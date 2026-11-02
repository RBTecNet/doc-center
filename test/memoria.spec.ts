/**
 * A memória do projeto: escrita por agente, valendo só depois de aprovada.
 *
 * O que se prova aqui é a diferença entre as naturezas — armadilha acumula,
 * estado substitui — e a regra que protege todos os runs futuros: nada que um
 * agente escreveu chega a um run sem passar por uma pessoa.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";
import { autenticarTeste } from "./auth-fixture.js";

let store: Store;
let rootStore: Store;
let headers: Record<string, string> = {};
let mcpHeaders: Record<string, string> = {};
let server: Server;
let base = "";
let projetoId = 0;

const rpc = async (method: string, params?: Record<string, unknown>) => {
  const resposta = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...mcpHeaders, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return (await resposta.json()) as any;
};

const registrar = (natureza: string, titulo: string, conteudo: string) =>
  rpc("tools/call", {
    name: "registrar_memoria",
    arguments: { projeto: "p", natureza, titulo, conteudo, procedencia: "build-1 · P02" },
  });

beforeEach(async () => {
  store = rootStore = new Store({ file: ":memory:" });
  projetoId = store.criarProjeto({ nome: "P", pedido: "algo" }).id;
  server = createApp({ store });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
  ({ store, headers, mcpHeaders } = await autenticarTeste(rootStore, base));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rootStore.close();
});

describe("registrar memória pelo protocolo", () => {
  it("entra como rascunho, com procedência", async () => {
    const resposta = await registrar("armadilha", "SQLite em teste", "Use SQLITE_TEST_FILE diferente.");
    expect(resposta.result.content[0].text).toContain("rascunho");

    const memorias = store.memorias(projetoId);
    expect(memorias).toHaveLength(1);
    expect(memorias[0]).toMatchObject({ status: "rascunho", natureza: "armadilha", procedencia: "build-1 · P02" });
  });

  /*
   * Estado antigo não é histórico, é mentira: quem o lê trabalha sobre o que já
   * não é verdade. Por isso ele substitui, e as outras naturezas acumulam.
   */
  it("estado substitui; armadilha acumula", async () => {
    await registrar("estado", "Estado atual", "fase 1 fechada");
    await registrar("estado", "Estado atual", "fases 1 e 2 fechadas");
    await registrar("armadilha", "Primeira", "a");
    await registrar("armadilha", "Segunda", "b");

    const memorias = store.memorias(projetoId);
    const estados = memorias.filter((memoria) => memoria.natureza === "estado");
    expect(estados).toHaveLength(1);
    expect(estados[0]?.conteudo).toBe("fases 1 e 2 fechadas");
    expect(memorias.filter((memoria) => memoria.natureza === "armadilha")).toHaveLength(2);
  });

  it("a mesma armadilha registrada de novo atualiza, não duplica", async () => {
    await registrar("armadilha", "SQLite em teste", "primeira versão");
    await registrar("armadilha", "SQLite em teste", "com mais detalhe");

    const memorias = store.memorias(projetoId);
    expect(memorias).toHaveLength(1);
    expect(memorias[0]?.conteudo).toBe("com mais detalhe");
  });

  it("natureza inventada é recusada como erro da ferramenta", async () => {
    const resposta = await rpc("tools/call", {
      name: "registrar_memoria",
      arguments: { projeto: "p", natureza: "palpite", titulo: "x", conteudo: "y" },
    });
    expect(resposta.result.isError).toBe(true);
    expect(resposta.result.content[0].text).toContain("natureza desconhecida");
  });

  it("projeto inexistente não cria nada", async () => {
    const resposta = await rpc("tools/call", {
      name: "registrar_memoria",
      arguments: { projeto: "nao-existe", natureza: "decisao", titulo: "x", conteudo: "y" },
    });
    expect(resposta.result.isError).toBe(true);
    expect(store.memorias(projetoId)).toHaveLength(0);
  });
});

describe("rascunho não chega a um run", () => {
  /*
   * A regra que dá sentido à aprovação. Se o rascunho fosse servido, revisar
   * seria teatro: o run já teria usado a memória antes de alguém olhar.
   */
  it("o protocolo não expõe memória em rascunho", async () => {
    await registrar("armadilha", "Ainda não revisada", "conteúdo do rascunho");

    const antes = (await rpc("resources/list")).result.resources as { uri: string }[];
    expect(antes.some((recurso) => recurso.uri.includes("ainda-nao-revisada"))).toBe(false);

    const pendente = store.rascunhos(projetoId)[0]!;
    await fetch(`${base}/api/documentos/${pendente.id}/aprovar`, { method: "POST", headers });

    const depois = (await rpc("resources/list")).result.resources as { uri: string }[];
    expect(depois.some((recurso) => recurso.uri.includes("ainda-nao-revisada"))).toBe(true);
  });

  it("aprovar tira da fila de pendentes", async () => {
    await registrar("decisao", "Stack", "Node com TypeScript");
    const pendente = store.rascunhos(projetoId)[0]!;
    store.aprovar(pendente.id);

    expect(store.rascunhos(projetoId)).toHaveLength(0);
    expect(store.documentoPorId(pendente.id)?.status).toBe("ativo");
  });
});
