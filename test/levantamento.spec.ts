/**
 * O levantamento de uma aplicação existente, chegando à base.
 *
 * Quem roda `capivara survey` não tem projeto nenhum cadastrado aqui: a
 * aplicação existe, a base não sabe dela. A ferramenta cria o projeto, guarda o
 * documento e semeia o pedido com um rascunho de reescrita — que é o que o
 * desenvolvedor vai editar para dizer a stack de destino e o que fica de fora.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";

let store: Store;
let server: Server;
let base = "";

const rpc = async (method: string, params?: Record<string, unknown>) => {
  const resposta = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return (await resposta.json()) as any;
};

const registrar = (conteudo: string, extras: Record<string, string> = {}) =>
  rpc("tools/call", {
    name: "registrar_levantamento",
    arguments: { projeto: "locadora-antiga", nome: "Locadora", conteudo, procedencia: "survey-abc", ...extras },
  });

beforeEach(async () => {
  store = new Store({ file: ":memory:" });
  server = createApp({ store });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

describe("registrar_levantamento", () => {
  it("cria o projeto que ainda não existe e guarda o documento", async () => {
    const resposta = await registrar("# Locadora — Levantamento\n\nregra x");
    expect(resposta.result.content[0].text).toContain("locadora-antiga");

    const projeto = store.projetoPorSlug("locadora-antiga");
    expect(projeto).toBeTruthy();
    const documentos = store.listarDoProjeto(projeto!.id);
    expect(documentos).toHaveLength(1);
    expect(documentos[0]?.tipo).toBe("documentacao");
    expect(documentos[0]?.conteudo).toContain("regra x");
  });

  /*
   * O documento nasce DO projeto, e por isso já é material dele: a seleção é o
   * mecanismo da área geral, e a base recusa selecionar o que já é próprio.
   */
  it("o levantamento já é material do projeto, sem precisar ser selecionado", async () => {
    await registrar("# Levantamento");
    const material = await rpc("tools/call", { name: "listar_material", arguments: { projeto: "locadora-antiga" } });
    expect(material.result.content[0].text).toContain("Levantamento");
  });

  it("o pedido nasce como rascunho de reescrita, com as duas linhas a preencher", async () => {
    await registrar("# Levantamento");
    const projeto = store.projetoPorSlug("locadora-antiga")!;

    expect(projeto.pedido).toContain("Reescrever a aplicação Locadora");
    expect(projeto.pedido).toContain("Stack de destino");
    expect(projeto.pedido).toContain("Fica de fora");
  });

  /*
   * Levantar de novo é o caso comum: a aplicação mudou, ou o levantamento
   * anterior ficou incompleto. O que não pode é apagar o pedido que alguém já
   * escreveu — é ele que diz o que a reescrita vai fazer.
   */
  it("rodar de novo atualiza o documento e preserva o pedido já escrito", async () => {
    await registrar("# Levantamento\n\nprimeira leitura");
    store.atualizarProjeto("locadora-antiga", { pedido: "Reescrever em Go, sem o módulo fiscal." });

    await registrar("# Levantamento\n\nsegunda leitura, mais completa");

    const projeto = store.projetoPorSlug("locadora-antiga")!;
    expect(projeto.pedido).toBe("Reescrever em Go, sem o módulo fiscal.");

    const documentos = store.listarDoProjeto(projeto.id);
    expect(documentos).toHaveLength(1);
    expect(documentos[0]?.conteudo).toContain("segunda leitura");
  });

  it("sem conteúdo não há levantamento", async () => {
    const resposta = await rpc("tools/call", { name: "registrar_levantamento", arguments: { projeto: "x" } });
    expect(resposta.result.isError).toBe(true);
  });
});
