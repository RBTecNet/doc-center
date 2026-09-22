/**
 * A borda HTTP, onde o dado entra.
 *
 * O defeito que motivou este arquivo: a API criava a skill sem descrição,
 * categoria, gatilhos nem restrições. O store sabia guardar, a tela sabia
 * mostrar, e no meio os campos eram descartados em silêncio — a skill chegava
 * ao catálogo sem nada do que se lê para escolhê-la. Nada falhava; só ficava
 * vazio.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";

let store: Store;
let server: Server;
let base = "";

async function pedir(metodo: string, caminho: string, corpo?: unknown): Promise<{ status: number; dado: any }> {
  const resposta = await fetch(`${base}${caminho}`, {
    method: metodo,
    ...(corpo === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) }),
  });
  return { status: resposta.status, dado: await resposta.json() };
}

beforeEach(async () => {
  store = new Store({ file: ":memory:" });
  server = createApp({ store });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

const SKILL = {
  tipo: "skill",
  titulo: "Revisar diff",
  categoria: "Qualidade",
  descricao: "Lê o diff inteiro e aponta defeito de correção.",
  gatilhos: "revisar PR, antes de commitar",
  restricoes: "formatação, que a ferramenta já pega",
  conteudo: "Leia o diff inteiro antes de comentar.",
};

describe("cadastrar no catálogo", () => {
  it("guarda a vitrine inteira, não só o conteúdo", async () => {
    const { status, dado } = await pedir("POST", "/api/documentos", SKILL);
    expect(status).toBe(201);
    expect(dado.documento).toMatchObject({
      categoria: "Qualidade",
      descricao: "Lê o diff inteiro e aponta defeito de correção.",
      gatilhos: "revisar PR, antes de commitar",
      restricoes: "formatação, que a ferramenta já pega",
    });

    // E sobrevive à ida ao banco: o defeito original só aparecia ao reler.
    const lido = await pedir("GET", `/api/documentos/${dado.documento.id}`);
    expect(lido.dado.documento.gatilhos).toBe("revisar PR, antes de commitar");
  });

  it("editar preserva o que não foi enviado", async () => {
    const { dado } = await pedir("POST", "/api/documentos", SKILL);
    await pedir("PUT", `/api/documentos/${dado.documento.id}`, { conteudo: "outro conteúdo" });

    const lido = await pedir("GET", `/api/documentos/${dado.documento.id}`);
    expect(lido.dado.documento.conteudo).toBe("outro conteúdo");
    expect(lido.dado.documento.categoria, "a categoria não foi tocada").toBe("Qualidade");
  });

  it("memória não precisa de vitrine", async () => {
    const { status, dado } = await pedir("POST", "/api/documentos", {
      tipo: "memoria",
      titulo: "Estilo",
      conteudo: "português no código",
    });
    expect(status).toBe(201);
    expect(dado.documento.categoria).toBe("");
  });
});

describe("os códigos de resposta", () => {
  /*
   * "Já existe" é resposta legítima a pedido legítimo. Responder 500 mandaria o
   * operador procurar defeito no servidor, e um monitor contaria falha onde não
   * houve.
   */
  it("duplicado é 400 com a razão, não 500", async () => {
    await pedir("POST", "/api/documentos", SKILL);
    const repetido = await pedir("POST", "/api/documentos", SKILL);
    expect(repetido.status).toBe(400);
    expect(repetido.dado.erro).toContain("já existe");
  });

  it("projeto inexistente é 404", async () => {
    const { status } = await pedir("GET", "/api/projetos/inventado");
    expect(status).toBe(404);
  });

  it("rota desconhecida é 404 e diz qual era", async () => {
    const { status, dado } = await pedir("GET", "/api/nada");
    expect(status).toBe(404);
    expect(dado.erro).toContain("/api/nada");
  });
});

describe("adotar do catálogo", () => {
  it("adiciona e remove do projeto pela mesma rota", async () => {
    const projeto = await pedir("POST", "/api/projetos", { nome: "Biblioteca" });
    const skill = await pedir("POST", "/api/documentos", SKILL);
    const id = skill.dado.documento.id;

    const adotada = await pedir("POST", `/api/projetos/biblioteca/selecoes/${id}`);
    expect(adotada.dado.selecionados).toEqual([id]);

    const comProjeto = await pedir("GET", "/api/projetos/biblioteca");
    expect(comProjeto.dado.usados.map((documento: { titulo: string }) => documento.titulo)).toEqual(["Revisar diff"]);
    expect(projeto.dado.projeto.slug).toBe("biblioteca");

    const removida = await pedir("DELETE", `/api/projetos/biblioteca/selecoes/${id}`);
    expect(removida.dado.selecionados).toEqual([]);
    // A skill continua no catálogo: adotar aponta, não copia nem move.
    const aindaExiste = await pedir("GET", `/api/documentos/${id}`);
    expect(aindaExiste.status).toBe(200);
  });
});

/**
 * A tela dos artefatos que o harness grava.
 *
 * Um levantamento tem dezenas de milhares de caracteres, e a prévia nasceu com
 * corte em 600 e `overflow: hidden`: servia para uma memória de três linhas e
 * escondia 90% do que o harness escreveu. Quem precisa conferir um documento
 * gerado só tem um jeito — lendo.
 */
describe("ler um artefato inteiro na tela", () => {
  it("a prévia leva o documento todo, não os primeiros 600 caracteres", async () => {
    const projeto = store.criarProjeto({ nome: "P", slug: "p", pedido: "x" });
    const longo = Array.from({ length: 200 }, (_, indice) => `linha ${indice} do levantamento`).join("\n");
    store.criarDocumento({ projetoId: projeto.id, tipo: "documentacao", titulo: "Levantamento", conteudo: longo });

    const html = await (await fetch(`${base}/projetos/p`)).text();
    expect(html).toContain("linha 0 do levantamento");
    expect(html).toContain("linha 199 do levantamento");
  });

  it("acima do teto, diz quanto ficou de fora em vez de terminar no meio", async () => {
    const projeto = store.criarProjeto({ nome: "Q", slug: "q", pedido: "x" });
    store.criarDocumento({ projetoId: projeto.id, tipo: "documentacao", titulo: "Enorme", conteudo: "a".repeat(30_000) });

    const html = await (await fetch(`${base}/projetos/q`)).text();
    expect(html).toContain("mostrando os primeiros");
    expect(html).toContain("abra em editar para ver tudo");
  });

  it("prompts têm seu próprio botão de criar, com campo de descrição", async () => {
    store.criarProjeto({ nome: "R", slug: "r", pedido: "x" });
    const html = await (await fetch(`${base}/projetos/r`)).text();

    expect(html).toContain("novo prompt");
    // A descrição é o que distingue dois prompts na hora de escolher, no wizard.
    expect(html).toContain("quando usar este prompt");
  });
});
