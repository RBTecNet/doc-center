/**
 * Leitor de ZIP, escrito aqui.
 *
 * A aplicação não tem dependência de runtime, e uma skill chega como zip. O
 * formato é simples o bastante para caber num arquivo: o diretório central lista
 * as entradas com nome, método e tamanhos, e o `node:zlib` já sabe desinflar.
 *
 * A leitura é pelo DIRETÓRIO CENTRAL, e não pelos cabeçalhos locais, porque o
 * cabeçalho local pode trazer tamanho zero quando o zip foi escrito em fluxo (o
 * tamanho real vai num descritor depois dos dados). O diretório central sempre
 * tem os números certos — é para isso que ele existe.
 */

import { crc32 } from "node:zlib";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ArquivoDoZip {
  /** Caminho relativo dentro do pacote, com barras normais. */
  caminho: string;
  conteudo: Buffer;
}

export class ZipInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipInvalido";
  }
}

const FIM_DO_DIRETORIO = 0x06054b50;
const ENTRADA_DO_DIRETORIO = 0x02014b50;
const CABECALHO_LOCAL = 0x04034b50;

/** O fim do diretório central fica no fim do arquivo, depois de um comentário de tamanho variável. */
function acharFimDoDiretorio(dados: Buffer): number {
  const minimo = 22;
  if (dados.length < minimo) throw new ZipInvalido("arquivo pequeno demais para ser um zip");

  // O comentário tem no máximo 65535 bytes; procurar de trás para frente acha o
  // fim verdadeiro mesmo quando o comentário contém a própria assinatura.
  const limite = Math.max(0, dados.length - minimo - 0xffff);
  for (let posicao = dados.length - minimo; posicao >= limite; posicao -= 1) {
    if (dados.readUInt32LE(posicao) === FIM_DO_DIRETORIO) return posicao;
  }
  throw new ZipInvalido("não encontrei o diretório central: o arquivo não é um zip");
}

/**
 * Um caminho de dentro do zip é dado de fora, e dado de fora não escolhe onde
 * escreve. `../` e caminho absoluto são recusados — este é o defeito clássico
 * de quem descompacta (zip slip), e ele custa o diretório inteiro de quem abriu.
 */
export function caminhoSeguro(bruto: string): string | null {
  const normalizado = bruto.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizado === "" || normalizado.endsWith("/")) return null;
  if (normalizado.startsWith("/") || /^[A-Za-z]:/.test(normalizado)) return null;
  if (normalizado.split("/").some((parte) => parte === ".." || parte === "")) return null;
  return normalizado;
}

/**
 * A raiz comum do pacote, quando houver.
 *
 * Um zip baixado costuma vir com tudo dentro de uma pasta — `frontend-design/`.
 * Guardar esse prefixo faria o `SKILL.md` virar `frontend-design/SKILL.md`, e os
 * caminhos relativos que a própria skill usa deixariam de bater.
 */
export function raizComum(caminhos: readonly string[]): string {
  if (caminhos.length === 0) return "";
  const primeiro = caminhos[0]!.split("/");
  if (primeiro.length < 2) return "";

  const candidato = primeiro[0]!;
  return caminhos.every((caminho) => caminho.startsWith(`${candidato}/`)) ? `${candidato}/` : "";
}

export function lerZip(dados: Buffer): ArquivoDoZip[] {
  const fim = acharFimDoDiretorio(dados);
  const quantas = dados.readUInt16LE(fim + 10);
  let posicao = dados.readUInt32LE(fim + 16);

  const arquivos: ArquivoDoZip[] = [];

  for (let indice = 0; indice < quantas; indice += 1) {
    if (posicao + 46 > dados.length || dados.readUInt32LE(posicao) !== ENTRADA_DO_DIRETORIO) {
      throw new ZipInvalido("o diretório central do zip está truncado ou corrompido");
    }

    const metodo = dados.readUInt16LE(posicao + 10);
    const comprimido = dados.readUInt32LE(posicao + 20);
    const original = dados.readUInt32LE(posicao + 24);
    const nomeTamanho = dados.readUInt16LE(posicao + 28);
    const extraTamanho = dados.readUInt16LE(posicao + 30);
    const comentarioTamanho = dados.readUInt16LE(posicao + 32);
    const inicioLocal = dados.readUInt32LE(posicao + 42);
    const nome = dados.toString("utf8", posicao + 46, posicao + 46 + nomeTamanho);

    posicao += 46 + nomeTamanho + extraTamanho + comentarioTamanho;

    const caminho = caminhoSeguro(nome);
    if (caminho === null) continue;

    if (dados.readUInt32LE(inicioLocal) !== CABECALHO_LOCAL) {
      throw new ZipInvalido(`entrada corrompida no zip: ${nome}`);
    }
    // O cabeçalho local tem seus próprios tamanhos de nome e extra, que podem
    // diferir dos do diretório central — os dados começam depois deles.
    const nomeLocal = dados.readUInt16LE(inicioLocal + 26);
    const extraLocal = dados.readUInt16LE(inicioLocal + 28);
    const inicioDados = inicioLocal + 30 + nomeLocal + extraLocal;
    const bruto = dados.subarray(inicioDados, inicioDados + comprimido);

    if (metodo === 0) {
      arquivos.push({ caminho, conteudo: Buffer.from(bruto) });
      continue;
    }
    if (metodo !== 8) {
      throw new ZipInvalido(`o arquivo ${nome} usa um método de compressão que não sabemos ler (${metodo})`);
    }

    let conteudo: Buffer;
    try {
      conteudo = inflateRawSync(bruto);
    } catch {
      throw new ZipInvalido(`não consegui descomprimir ${nome}`);
    }
    if (original !== 0 && conteudo.length !== original) {
      throw new ZipInvalido(`${nome} saiu com tamanho diferente do declarado`);
    }
    arquivos.push({ caminho, conteudo });
  }

  if (arquivos.length === 0) throw new ZipInvalido("o zip não tem arquivo nenhum que possamos guardar");

  const raiz = raizComum(arquivos.map((arquivo) => arquivo.caminho));
  return raiz === ""
    ? arquivos
    : arquivos.map((arquivo) => ({ ...arquivo, caminho: arquivo.caminho.slice(raiz.length) }));
}

/** Texto ou binário? Decide como o arquivo é guardado e mostrado. */
export function pareceTexto(conteudo: Buffer): boolean {
  // Byte zero não aparece em texto; é o sinal mais barato e mais confiável.
  const amostra = conteudo.subarray(0, 8000);
  if (amostra.includes(0)) return false;

  // E o texto precisa ser UTF-8 válido: ida e volta preserva os bytes.
  return Buffer.compare(Buffer.from(amostra.toString("utf8"), "utf8"), amostra) === 0;
}

/**
 * Escreve um zip.
 *
 * O mesmo formato que lemos, na direção contrária: cabeçalho local por arquivo,
 * diretório central no fim e o registro de fim depois dele. O CRC é calculado de
 * verdade — quem abrir este zip com qualquer outra ferramenta vai conferi-lo, e
 * um CRC errado faz o arquivo parecer corrompido mesmo estando íntegro.
 */
export function escreverZip(arquivos: readonly ArquivoDoZip[]): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;

  for (const arquivo of arquivos) {
    const nome = Buffer.from(arquivo.caminho, "utf8");
    const comprimido = deflateRawSync(arquivo.conteudo);

    /*
     * Comprimir nem sempre encolhe: texto minúsculo e imagem já comprimida
     * saem maiores. Guardar o maior dos dois seria pagar para piorar.
     */
    const usarDeflate = comprimido.length < arquivo.conteudo.length;
    const dados = usarDeflate ? comprimido : arquivo.conteudo;
    const soma = crc32(arquivo.conteudo);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(usarDeflate ? 8 : 0, 8);
    local.writeUInt32LE(soma, 14);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(arquivo.conteudo.length, 22);
    local.writeUInt16LE(nome.length, 26);
    locais.push(local, nome, dados);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(usarDeflate ? 8 : 0, 10);
    central.writeUInt32LE(soma, 16);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt32LE(arquivo.conteudo.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nome);

    deslocamento += 30 + nome.length + dados.length;
  }

  const corpoCentral = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(FIM_DO_DIRETORIO, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(corpoCentral.length, 12);
  fim.writeUInt32LE(deslocamento, 16);

  return Buffer.concat([...locais, corpoCentral, fim]);
}
