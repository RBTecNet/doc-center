/**
 * O projeto inteiro num zip, e de volta.
 *
 * A regra do §34 que governa este arquivo: **a base é conveniência, não
 * dependência**. O zip existe para que o trabalho continue sem ela — você joga
 * numa pasta, roda o capivara, e funciona. E para que ele seja compartilhável:
 * outra pessoa recebe o mesmo material sem precisar do nosso servidor.
 *
 * A estrutura é EXATAMENTE a que o harness materializa em `.capivara/`. Um
 * formato só nas duas direções: exportar é empacotar o que o harness leria;
 * importar é o inverso. Converter no meio criaria dois formatos que divergem no
 * dia em que um mudar.
 */

import type { Store } from "./db/store.js";
import type { Documento, Projeto } from "./db/schema.js";
import { NATUREZAS, pastaDaNatureza } from "./db/schema.js";
import { escreverZip, lerZip, pareceTexto, type ArquivoDoZip } from "./zip.js";

export const PASTA = ".capivara";

/** O índice das skills, que o harness lê quando a base não responde. */
export interface EntradaDoIndice {
  slug: string;
  nome: string;
  area: string;
  uri: string;
}

function indiceDasSkills(projeto: Projeto, skills: readonly Documento[]): EntradaDoIndice[] {
  return skills.map((skill) => ({
    slug: skill.slug,
    nome: skill.titulo,
    area: skill.area,
    uri: `capivara://${projeto.slug}/docs/skill/${skill.slug}`,
  }));
}

/**
 * O índice das memórias, em markdown.
 *
 * Uma linha por memória, com o arquivo atrás. É a forma que já se provou duas
 * vezes — no `HANDOFF.md` do harness e no índice de memórias do Claude Code — e
 * é o que permite a **qualquer** modelo abrir o zip, ler um arquivo e saber por
 * onde continuar, sem capivara e sem MCP.
 */
function indiceDasMemorias(projeto: Projeto, memorias: readonly Documento[]): string {
  const linhas = [`# Memória — ${projeto.nome}`, ""];

  if (memorias.length === 0) {
    linhas.push("_Este projeto ainda não tem memória registrada._");
    return linhas.join("\n");
  }

  linhas.push("O que se sabe deste projeto e não está no código. Leia o estado primeiro.", "");

  for (const natureza of NATUREZAS) {
    const dela = memorias.filter((memoria) => memoria.natureza === natureza.natureza);
    if (dela.length === 0) continue;

    linhas.push(`## ${natureza.titulo}`, "");
    for (const memoria of dela) {
      const arquivo = caminhoDaMemoria(memoria);
      const resumo = memoria.conteudo.split("\n").find((linha) => linha.trim() !== "" && !linha.startsWith("#")) ?? "";
      linhas.push(`- [${memoria.titulo}](${arquivo}) — ${resumo.slice(0, 110)}`);
    }
    linhas.push("");
  }

  return linhas.join("\n");
}

function caminhoDaMemoria(memoria: Documento): string {
  const natureza = memoria.natureza || "decisao";
  return natureza === "estado" ? "estado-atual.md" : `${pastaDaNatureza(natureza)}/${memoria.slug}.md`;
}

export interface Exportacao {
  zip: Buffer;
  arquivos: string[];
}

/**
 * Empacota o projeto.
 *
 * Só o que está ATIVO: rascunho existe para ser revisado, e levá-lo num zip
 * compartilhado passaria adiante como sabido o que ninguém conferiu.
 */
export function exportarProjeto(store: Store, projeto: Projeto): Exportacao {
  const usados = store.listarDoProjeto(projeto.id).filter((documento) => documento.status !== "rascunho");
  const skills = usados.filter((documento) => documento.tipo === "skill");
  const memorias = store.memorias(projeto.id).filter((memoria) => memoria.status !== "rascunho");
  const outros = usados.filter((documento) => documento.tipo !== "skill" && documento.tipo !== "memoria");

  const arquivos: ArquivoDoZip[] = [];
  const texto = (caminho: string, conteudo: string): void => {
    arquivos.push({ caminho, conteudo: Buffer.from(conteudo, "utf8") });
  };

  // O pedido: é o que o `init` lê para saber o que construir.
  if (projeto.pedido.trim() !== "") texto(`${PASTA}/pedido.md`, projeto.pedido.trim());

  texto(
    `${PASTA}/projeto.json`,
    `${JSON.stringify({ slug: projeto.slug, nome: projeto.nome, descricao: projeto.descricao, exportadoEm: new Date().toISOString() }, null, 2)}\n`,
  );

  // As skills, na pasta onde o harness as materializa e com os caminhos que o
  // próprio SKILL.md cita.
  for (const skill of skills) {
    texto(`${PASTA}/skills/${skill.slug}/SKILL.md`, skill.conteudo);
    for (const arquivo of store.arquivos(skill.id)) {
      const conteudo = store.arquivo(skill.id, arquivo.caminho);
      if (conteudo) arquivos.push({ caminho: `${PASTA}/skills/${skill.slug}/${arquivo.caminho}`, conteudo: conteudo.conteudo });
    }
  }
  if (skills.length > 0) {
    texto(`${PASTA}/skills/index.json`, `${JSON.stringify(indiceDasSkills(projeto, skills), null, 2)}\n`);
  }

  // As memórias, com o índice na frente.
  texto(`${PASTA}/memoria/MEMORIA.md`, indiceDasMemorias(projeto, memorias));
  for (const memoria of memorias) {
    texto(`${PASTA}/memoria/${caminhoDaMemoria(memoria)}`, memoria.conteudo);
  }

  for (const documento of outros) {
    texto(`${PASTA}/documentos/${documento.tipo}/${documento.slug}.md`, documento.conteudo);
  }

  return { zip: escreverZip(arquivos), arquivos: arquivos.map((arquivo) => arquivo.caminho) };
}

export interface Importacao {
  projeto: Projeto;
  skills: number;
  memorias: number;
  documentos: number;
}

/**
 * Recria o projeto a partir de um zip exportado.
 *
 * O que vem de fora entra como está — inclusive as memórias, que já foram
 * aprovadas por quem exportou. Reabri-las como rascunho obrigaria a revisar duas
 * vezes o mesmo conteúdo, e quem importa escolheu confiar na origem ao importar.
 */
export function importarProjeto(store: Store, dados: Buffer, slugDesejado?: string): Importacao {
  const arquivos = lerZip(dados);
  const porCaminho = new Map(arquivos.map((arquivo) => [arquivo.caminho.replace(/^\.capivara\//, ""), arquivo]));

  const manifesto = porCaminho.get("projeto.json");
  const declarado = manifesto
    ? (JSON.parse(manifesto.conteudo.toString("utf8")) as { slug?: string; nome?: string; descricao?: string })
    : {};

  const slug = slugDesejado?.trim() || declarado.slug || "importado";
  const pedido = porCaminho.get("pedido.md")?.conteudo.toString("utf8") ?? "";

  const projeto =
    store.projetoPorSlug(slug) ??
    store.criarProjeto({ nome: declarado.nome || slug, slug, descricao: declarado.descricao ?? "", pedido });
  if (pedido !== "" && projeto.pedido.trim() === "") store.atualizarProjeto(projeto.slug, { pedido });

  // As skills voltam com seus arquivos: o índice diz a área de cada uma, que o
  // harness usa para decidir em que fase ela entra.
  const indice = porCaminho.get("skills/index.json");
  const entradas = indice ? (JSON.parse(indice.conteudo.toString("utf8")) as EntradaDoIndice[]) : [];
  const areaPorSlug = new Map(entradas.map((entrada) => [entrada.slug, entrada]));

  const slugsDeSkill = new Set(
    [...porCaminho.keys()]
      .filter((caminho) => caminho.startsWith("skills/") && caminho.endsWith("/SKILL.md"))
      .map((caminho) => caminho.slice("skills/".length, -"/SKILL.md".length)),
  );

  let skills = 0;
  for (const slugDaSkill of slugsDeSkill) {
    const base = porCaminho.get(`skills/${slugDaSkill}/SKILL.md`)!;
    const entrada = areaPorSlug.get(slugDaSkill);
    if (store.documento(projeto.id, "skill", slugDaSkill)) continue;

    const criada = store.criarDocumento({
      projetoId: projeto.id,
      tipo: "skill",
      titulo: entrada?.nome || slugDaSkill,
      slug: slugDaSkill,
      conteudo: base.conteudo.toString("utf8"),
      area: entrada?.area ?? "geral",
    });

    for (const [caminho, arquivo] of porCaminho) {
      const prefixo = `skills/${slugDaSkill}/`;
      if (!caminho.startsWith(prefixo) || caminho === `${prefixo}SKILL.md`) continue;
      store.gravarArquivo(criada.id, {
        caminho: caminho.slice(prefixo.length),
        conteudo: arquivo.conteudo,
        binario: !pareceTexto(arquivo.conteudo),
      });
    }
    skills += 1;
  }

  let memorias = 0;
  for (const [caminho, arquivo] of porCaminho) {
    if (!caminho.startsWith("memoria/") || caminho.endsWith("MEMORIA.md")) continue;
    const natureza = caminho.includes("/") && caminho.endsWith("estado-atual.md") ? "estado" : naturezaDoCaminho(caminho);
    const texto = arquivo.conteudo.toString("utf8");

    store.registrarMemoria({
      projetoId: projeto.id,
      natureza,
      titulo: tituloDoTexto(texto, caminho),
      conteudo: texto,
      procedencia: "importado de zip",
      // Já revisadas na origem: exigir nova aprovação seria revisar duas vezes.
      status: "ativo",
    });
    memorias += 1;
  }

  let documentos = 0;
  for (const [caminho, arquivo] of porCaminho) {
    const partes = caminho.split("/");
    if (partes[0] !== "documentos" || partes.length < 3) continue;
    const tipo = partes[1]!;
    const slugDoDocumento = partes[2]!.replace(/\.md$/, "");
    if (store.documento(projeto.id, tipo, slugDoDocumento)) continue;

    store.criarDocumento({
      projetoId: projeto.id,
      tipo,
      titulo: slugDoDocumento,
      slug: slugDoDocumento,
      conteudo: arquivo.conteudo.toString("utf8"),
    });
    documentos += 1;
  }

  return { projeto: store.projetoPorSlug(projeto.slug)!, skills, memorias, documentos };
}

function naturezaDoCaminho(caminho: string): string {
  const pasta = caminho.split("/")[1] ?? "";
  return NATUREZAS.find((natureza) => natureza.pasta === pasta)?.natureza ?? "decisao";
}

function tituloDoTexto(texto: string, caminho: string): string {
  const cabecalho = /^#{1,3}\s+(.+)$/m.exec(texto)?.[1]?.trim();
  return cabecalho && cabecalho !== "" ? cabecalho : (caminho.split("/").pop() ?? "memória").replace(/\.md$/, "");
}
