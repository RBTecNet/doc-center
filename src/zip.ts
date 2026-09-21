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

import { inflateRawSync } from "node:zlib";

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
