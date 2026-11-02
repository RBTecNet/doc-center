/**
 * Os prompts guardados.
 *
 * O `pedido` de um projeto é único e é dele. Estes são os outros: o pedido de
 * mudança que se repete em três projetos, o texto de uma funcionalidade que
 * sempre volta. Eles têm NOME — é por ele que alguém os reconhece na lista — e
 * um endereço, que é o que o comando usa.
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

const rpc = async (method: string, params?: Record<string, unknown>) => {
  const resposta = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...mcpHeaders, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return (await resposta.json()) as any;
};

beforeEach(async () => {
  store = rootStore = new Store({ file: ":memory:" });
  const projeto = store.criarProjeto({ nome: "MCP Teste", slug: "mcp-teste", pedido: "uma locadora de vídeos" });

  store.criarDocumento({
    projetoId: projeto.id,
    tipo: "prompt",
    titulo: "Editar cliente",
    conteudo: "quero poder editar e remover clientes",
    descricao: "a edição que faltou no primeiro build",
  });
  store.criarDocumento({
    tipo: "prompt",
    titulo: "CRUD completo",
    conteudo: "para cada cadastro, garanta criar, listar, editar e remover",
    descricao: "serve a qualquer projeto",
  });

  server = createApp({ store });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
  ({ store, headers, mcpHeaders } = await autenticarTeste(rootStore, base));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rootStore.close();
});

describe("prompts/list", () => {
  it("traz o pedido do projeto e os prompts guardados, cada um com seu nome", async () => {
    const { result } = await rpc("prompts/list");
    const porNome = new Map<string, any>(result.prompts.map((prompt: any) => [prompt.name, prompt]));

    expect([...porNome.keys()].sort()).toEqual(["geral/crud-completo", "mcp-teste", "mcp-teste/editar-cliente"]);
    expect(porNome.get("mcp-teste")?.title).toBe("pedido — MCP Teste");
    expect(porNome.get("mcp-teste/editar-cliente")?.title).toBe("Editar cliente — MCP Teste");
    expect(porNome.get("geral/crud-completo")?.title).toBe("CRUD completo");
  });

  /*
   * A descrição é o que distingue dois prompts de nome parecido na hora de
   * escolher. Sem ela a lista vira uma coluna de títulos que ninguém lembra.
   */
  it("a descrição vem junto, para quem está escolhendo", async () => {
    const { result } = await rpc("prompts/list");
    const editar = result.prompts.find((prompt: any) => prompt.name === "mcp-teste/editar-cliente");
    expect(editar.description).toBe("a edição que faltou no primeiro build");
  });
});

describe("prompts/get", () => {
  it("o slug sozinho é o pedido do projeto", async () => {
    const { result } = await rpc("prompts/get", { name: "mcp-teste" });
    expect(result.messages[0].content.text).toBe("uma locadora de vídeos");
  });

  it("projeto/slug é um prompt daquele projeto", async () => {
    const { result } = await rpc("prompts/get", { name: "mcp-teste/editar-cliente" });
    expect(result.messages[0].content.text).toContain("editar e remover clientes");
  });

  it("geral/slug é um prompt da área geral", async () => {
    const { result } = await rpc("prompts/get", { name: "geral/crud-completo" });
    expect(result.messages[0].content.text).toContain("criar, listar, editar e remover");
  });

  it("nome que não existe é recusado, não devolve vazio", async () => {
    expect((await rpc("prompts/get", { name: "mcp-teste/nao-existe" })).error).toBeTruthy();
    expect((await rpc("prompts/get", { name: "projeto-fantasma/x" })).error).toBeTruthy();
  });
});
