/**
 * O que um pacote de skill diz sobre si mesmo.
 *
 * O `SKILL.md` abre com um frontmatter que já traz tudo o que o catálogo pede —
 * nome, descrição com *use when* e *do NOT use*, versão e procedência. Importar
 * preenche o cartão a partir dele: ninguém redigita o que o arquivo já diz, e o
 * que estiver errado se corrige na tela depois.
 *
 * O leitor de YAML é deliberadamente raso: pares `chave: valor` e um nível de
 * aninhamento, que é o que esses frontmatters usam. Um YAML completo aqui seria
 * uma dependência inteira para ler oito linhas.
 */

import type { ArquivoDoZip } from "./zip.js";

export const ENTRADA = "SKILL.md";

export interface Frontmatter {
  nome: string;
  descricao: string;
  /** O que o `description` diz sobre quando usar — a parte antes do "não use". */
  gatilhos: string;
  restricoes: string;
  versao: string;
  fonte: string;
  autor: string;
}

const VAZIO: Frontmatter = { nome: "", descricao: "", gatilhos: "", restricoes: "", versao: "", fonte: "", autor: "" };

function semAspas(valor: string): string {
  const texto = valor.trim();
  if ((texto.startsWith("'") && texto.endsWith("'")) || (texto.startsWith('"') && texto.endsWith('"'))) {
    return texto.slice(1, -1);
  }
  return texto;
}

/**
 * Separa "quando usar" de "quando não usar" dentro da descrição.
 *
 * A convenção dos pacotes que circulam é uma frase só: "Create X… Use this skill
 * when… Do NOT use for…". Quebrar isso nos três campos do catálogo é o que faz a
 * vitrine ficar legível — e é recuperável se errar, porque o texto inteiro
 * continua na descrição.
 */
export function partirDescricao(descricao: string): { descricao: string; gatilhos: string; restricoes: string } {
  const texto = descricao.trim();
  if (texto === "") return { descricao: "", gatilhos: "", restricoes: "" };

  const naoUsar = /\b(do not use|don't use|não use|nao use|evite usar)\b/i.exec(texto);
  const restricoes = naoUsar ? texto.slice(naoUsar.index).replace(/^[^:]*?\bfor\b\s*/i, "").trim() : "";
  const semRestricao = naoUsar ? texto.slice(0, naoUsar.index).trim() : texto;

  const usar = /\b(use (this|the) skill when|use when|usar quando|use quando)\b/i.exec(semRestricao);
  const gatilhos = usar ? semRestricao.slice(usar.index + usar[0].length).replace(/^[:\s]+/, "").trim() : "";
  const resumo = usar ? semRestricao.slice(0, usar.index).trim() : semRestricao;

  return { descricao: resumo.replace(/[.\s]+$/, ""), gatilhos: gatilhos.replace(/[.\s]+$/, ""), restricoes: restricoes.replace(/[.\s]+$/, "") };
}

export function lerFrontmatter(conteudo: string): Frontmatter {
  const casamento = /^---\r?\n([\s\S]*?)\r?\n---/.exec(conteudo.trimStart());
  if (!casamento) return { ...VAZIO };

  const campos = new Map<string, string>();
  let secao = "";

  for (const linha of (casamento[1] ?? "").split("\n")) {
    if (linha.trim() === "" || linha.trimStart().startsWith("#")) continue;

    const aninhado = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(linha);
    if (aninhado && secao !== "") {
      campos.set(`${secao}.${aninhado[1]}`, semAspas(aninhado[2] ?? ""));
      continue;
    }

    const raiz = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(linha);
    if (!raiz) continue;
    const valor = semAspas(raiz[2] ?? "");
    secao = valor === "" ? (raiz[1] ?? "") : "";
    if (valor !== "") campos.set(raiz[1] ?? "", valor);
  }

  const partes = partirDescricao(campos.get("description") ?? "");
  return {
    nome: campos.get("name") ?? "",
    descricao: partes.descricao,
    gatilhos: partes.gatilhos,
    restricoes: partes.restricoes,
    versao: campos.get("version") ?? campos.get("metadata.version") ?? "",
    fonte: campos.get("source") ?? campos.get("metadata.source") ?? "",
    autor: campos.get("author") ?? campos.get("metadata.author") ?? "",
  };
}

export interface PacoteLido {
  /** O caminho da base dentro do pacote — quase sempre `SKILL.md`. */
  entrada: string;
  /** O corpo da base, já sem o frontmatter: é o que vira o conteúdo do documento. */
  corpo: string;
  frontmatter: Frontmatter;
  /** Os demais arquivos, na ordem em que vieram. */
  arquivos: ArquivoDoZip[];
}

/**
 * Onde está a base do pacote.
 *
 * `SKILL.md` na raiz é o caso normal. Um pacote sem ele ainda é aproveitável — o
 * primeiro markdown da raiz vira a base — porque recusar o zip inteiro por causa
 * do nome de um arquivo seria rigor sem ganho.
 */
export function lerPacote(arquivos: readonly ArquivoDoZip[]): PacoteLido {
  const porNome = (nome: string): ArquivoDoZip | undefined =>
    arquivos.find((arquivo) => arquivo.caminho.toLowerCase() === nome.toLowerCase());

  const entrada =
    porNome(ENTRADA) ??
    arquivos.find((arquivo) => !arquivo.caminho.includes("/") && arquivo.caminho.toLowerCase().endsWith(".md"));

  if (!entrada) {
    throw new Error(`o pacote não tem ${ENTRADA} nem outro markdown na raiz para servir de base`);
  }

  const texto = entrada.conteudo.toString("utf8");
  return {
    entrada: entrada.caminho,
    corpo: semFrontmatter(texto),
    frontmatter: lerFrontmatter(texto),
    arquivos: arquivos.filter((arquivo) => arquivo.caminho !== entrada.caminho),
  };
}

/** O corpo do SKILL.md sem o frontmatter — o que o modelo lê. */
export function semFrontmatter(conteudo: string): string {
  const texto = conteudo.trimStart();
  const casamento = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(texto);
  return casamento ? texto.slice(casamento[0].length).trimStart() : conteudo;
}
