/**
 * O zip do projeto: a base como conveniência, não dependência.
 *
 * O que se prova aqui é que o trabalho continua sem a base. O zip carrega o
 * material na MESMA estrutura que o harness materializa — um formato só nas duas
 * direções — e volta inteiro quando alguém o importa.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { exportarProjeto, importarProjeto } from "../src/projeto-zip.js";
import { lerZip } from "../src/zip.js";

let store: Store;

beforeEach(() => {
  store = new Store({ file: ":memory:" });
});

afterEach(() => {
  store.close();
});

function projetoCompleto() {
  const projeto = store.criarProjeto({ nome: "Locadora", pedido: "uma locadora de vídeos" });

  const skill = store.criarDocumento({
    projetoId: projeto.id,
    tipo: "skill",
    titulo: "frontend-design",
    conteudo: "## Design\n\nConsult references/typography.md",
    area: "frontend",
  });
  store.gravarArquivo(skill.id, { caminho: "references/typography.md", conteudo: Buffer.from("# Tipografia"), binario: false });
  store.gravarArquivo(skill.id, { caminho: "tela.png", conteudo: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), binario: true });

  store.registrarMemoria({
    projetoId: projeto.id,
    natureza: "armadilha",
    titulo: "SQLite em teste",
    conteudo: "# SQLite em teste\n\nUse arquivo próprio.",
    status: "ativo",
  });
  store.registrarMemoria({
    projetoId: projeto.id,
    natureza: "estado",
    titulo: "Estado atual",
    conteudo: "2 de 4 fases fechadas.",
    status: "ativo",
  });
  store.registrarMemoria({
    projetoId: projeto.id,
    natureza: "decisao",
    titulo: "Ainda não revisada",
    conteudo: "não deveria sair no zip",
  });

  return projeto;
}

describe("exportar", () => {
  it("empacota na estrutura que o harness materializa", () => {
    const { arquivos } = exportarProjeto(store, projetoCompleto());

    // Os caminhos são os do `.capivara/` do projeto: um formato só nas duas
    // direções, sem conversão no meio.
    expect(arquivos).toContain(".capivara/pedido.md");
    expect(arquivos).toContain(".capivara/skills/frontend-design/SKILL.md");
    expect(arquivos).toContain(".capivara/skills/frontend-design/references/typography.md");
    expect(arquivos).toContain(".capivara/skills/index.json");
    expect(arquivos).toContain(".capivara/memoria/MEMORIA.md");
    expect(arquivos).toContain(".capivara/memoria/estado-atual.md");
    expect(arquivos).toContain(".capivara/memoria/armadilhas/sqlite-em-teste.md");
    // O plural é escrito, não derivado: "decisao" + "s" daria "decisaos".
    expect(arquivos.some((caminho) => caminho.includes("/decisaos/"))).toBe(false);
  });

  /*
   * Rascunho existe para ser revisado. Passá-lo adiante num zip compartilhado
   * entregaria como sabido o que ninguém conferiu.
   */
  it("não leva rascunho", () => {
    const { zip } = exportarProjeto(store, projetoCompleto());
    const texto = lerZip(zip).map((arquivo) => arquivo.conteudo.toString("utf8")).join("\n");
    expect(texto).not.toContain("não deveria sair no zip");
  });

  it("o índice de memórias aponta para os arquivos que existem", () => {
    const { zip } = exportarProjeto(store, projetoCompleto());
    const arquivos = lerZip(zip);
    const indice = arquivos.find((arquivo) => arquivo.caminho.endsWith("MEMORIA.md"))!.conteudo.toString("utf8");

    expect(indice).toContain("# Memória — Locadora");
    expect(indice).toContain("(estado-atual.md)");
    expect(indice).toContain("(armadilhas/sqlite-em-teste.md)");
    /*
     * Todo link do índice existe no pacote: um índice que mente é pior que
     * nenhum. Os caminhos aqui vêm sem o `.capivara/` porque a leitura tira a
     * raiz comum — a mesma regra que faz um zip de skill baixado da internet
     * perder a pasta que o envolve.
     */
    for (const [, caminho] of indice.matchAll(/\]\(([^)]+)\)/g)) {
      expect(arquivos.some((arquivo) => arquivo.caminho === `memoria/${caminho}`), caminho).toBe(true);
    }
  });

  it("o zip que escrevemos é lido de volta, byte a byte", () => {
    const { zip } = exportarProjeto(store, projetoCompleto());
    const imagem = lerZip(zip).find((arquivo) => arquivo.caminho.endsWith("tela.png"))!;
    expect([...imagem.conteudo]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00]);
  });
});

describe("importar de volta", () => {
  it("recria o projeto inteiro noutra base", () => {
    const { zip } = exportarProjeto(store, projetoCompleto());

    const outra = new Store({ file: ":memory:" });
    const resultado = importarProjeto(outra, zip);

    expect(resultado.projeto.slug).toBe("locadora");
    expect(resultado.projeto.pedido).toBe("uma locadora de vídeos");
    expect(resultado.skills).toBe(1);

    const skill = outra.documento(resultado.projeto.id, "skill", "frontend-design")!;
    expect(skill.area).toBe("frontend");
    expect(outra.arquivos(skill.id).map((arquivo) => arquivo.caminho)).toEqual(["references/typography.md", "tela.png"]);
    // O binário sobreviveu à ida e à volta.
    expect([...outra.arquivo(skill.id, "tela.png")!.conteudo]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00]);

    const memorias = outra.memorias(resultado.projeto.id);
    expect(memorias.map((memoria) => memoria.natureza).sort()).toEqual(["armadilha", "estado"]);
    // Já revisadas na origem: exigir nova aprovação seria revisar duas vezes.
    expect(memorias.every((memoria) => memoria.status === "ativo")).toBe(true);
    outra.close();
  });

  it("importar duas vezes não duplica", () => {
    const { zip } = exportarProjeto(store, projetoCompleto());
    const outra = new Store({ file: ":memory:" });

    importarProjeto(outra, zip);
    const segunda = importarProjeto(outra, zip);

    expect(segunda.skills).toBe(0);
    expect(outra.listarProprios(segunda.projeto.id).filter((documento) => documento.tipo === "skill")).toHaveLength(1);
    outra.close();
  });

  it("aceita renomear o projeto na importação", () => {
    const { zip } = exportarProjeto(store, projetoCompleto());
    const outra = new Store({ file: ":memory:" });
    const resultado = importarProjeto(outra, zip, "locadora-copia");
    expect(resultado.projeto.slug).toBe("locadora-copia");
    outra.close();
  });
});
