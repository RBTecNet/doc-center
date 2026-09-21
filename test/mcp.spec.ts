/**
 * O protocolo, do jeito que o harness o exerce.
 *
 * Os testes falam com o servidor por HTTP de verdade e afirmam o contrato que o
 * capivara já lê: `capivara://<projeto>/pedido` e
 * `capivara://<projeto>/docs/<tipo>/<slug>`. Quebrar qualquer um destes quebra
 * um run lá do outro lado, e é melhor descobrir aqui.
 *
 * A regra central e a mais fácil de perder de vista: **sob um projeto só aparece
 * o que ele usa.** Um documento da área geral que ninguém selecionou existe no
 * acervo e não pertence a run nenhum.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";

let store: Store;
let server: Server;
let url = "";

async function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resposta = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return (await resposta.json()) as Record<string, unknown>;
}

const resultado = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const envelope = await rpc(method, params);
  if (envelope.error) throw new Error(`${method}: ${(envelope.error as { message: string }).message}`);
  return envelope.result as Record<string, unknown>;
};

beforeEach(async () => {
  store = new Store({ file: ":memory:" });

  const biblioteca = store.criarProjeto({ nome: "Biblioteca", pedido: "uma base documental com area geral e projetos" });
  const outro = store.criarProjeto({ nome: "Outro", pedido: "outra coisa qualquer" });

  const estilo = store.criarDocumento({ tipo: "memoria", titulo: "Estilo de código", conteudo: "português no código" });
  store.criarDocumento({ tipo: "skill", titulo: "Não selecionada", conteudo: "ninguém escolheu isto" });
  store.criarDocumento({
    projetoId: biblioteca.id,
    tipo: "tecnica",
    titulo: "Modelo do banco",
    conteudo: "SQLite, uma tabela por tipo",
  });

  store.selecionar(biblioteca.id, estilo.id);
  store.selecionar(outro.id, estilo.id);

  server = createApp({ store });
  const porta = await listen(server, 0);
  url = `http://127.0.0.1:${porta}/mcp`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

describe("o aperto de mão", () => {
  it("apresenta-se com versão e capacidades", async () => {
    const info = await resultado("initialize", { protocolVersion: "2025-06-18" });
    expect((info.serverInfo as { name: string }).name).toBe("doc-center");
    expect(info.capabilities).toHaveProperty("resources");
    expect(info.capabilities).toHaveProperty("prompts");
  });

  it("notificação não tem resposta, e o servidor não inventa uma", async () => {
    const resposta = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(resposta.status).toBe(202);
    expect(await resposta.text()).toBe("");
  });
});

describe("o que cada projeto oferece", () => {
  it("lista o pedido e os documentos que o projeto usa", async () => {
    const lista = (await resultado("resources/list")).resources as { uri: string }[];
    const uris = lista.map((recurso) => recurso.uri);

    expect(uris).toContain("capivara://biblioteca/pedido");
    expect(uris).toContain("capivara://biblioteca/docs/tecnica/modelo-do-banco");
    // Selecionado da área geral: aparece SOB o projeto, porque é o que ele usa.
    expect(uris).toContain("capivara://biblioteca/docs/memoria/estilo-de-codigo");
    // E o mesmo documento aparece sob o outro projeto que também o escolheu.
    expect(uris).toContain("capivara://outro/docs/memoria/estilo-de-codigo");
    // O que ninguém selecionou existe só no acervo.
    expect(uris).toContain("capivara://geral/docs/skill/nao-selecionada");
    expect(uris).not.toContain("capivara://biblioteca/docs/skill/nao-selecionada");
  });

  it("lê o pedido e os documentos pelo URI", async () => {
    const pedido = (await resultado("resources/read", { uri: "capivara://biblioteca/pedido" })).contents as {
      text: string;
    }[];
    expect(pedido[0]?.text).toBe("uma base documental com area geral e projetos");

    const memoria = (await resultado("resources/read", { uri: "capivara://biblioteca/docs/memoria/estilo-de-codigo" }))
      .contents as { text: string }[];
    expect(memoria[0]?.text).toBe("português no código");
  });

  /*
   * O coração da seleção. Ler pelo par tipo/slug direto no banco acharia o
   * documento e o entregaria — e a seleção deixaria de significar qualquer
   * coisa. Quem não escolheu, não recebe.
   */
  it("recusa um documento da área geral que o projeto não selecionou", async () => {
    const envelope = await rpc("resources/read", { uri: "capivara://biblioteca/docs/skill/nao-selecionada" });
    expect(envelope.error).toBeTruthy();
    expect((envelope.error as { message: string }).message).toContain("não usa");
  });

  it("URI fora do contrato é recusada em vez de adivinhada", async () => {
    for (const uri of ["capivara://biblioteca", "http://biblioteca/pedido", "capivara://x/docs/memoria"]) {
      const envelope = await rpc("resources/read", { uri });
      expect(envelope.error, uri).toBeTruthy();
    }
  });

  it("projeto inexistente diz isso, e não devolve vazio", async () => {
    const envelope = await rpc("resources/read", { uri: "capivara://inventado/pedido" });
    expect((envelope.error as { message: string }).message).toContain("não existe");
  });
});

describe("o pedido também é um prompt", () => {
  it("lista um prompt por projeto com pedido escrito", async () => {
    const prompts = (await resultado("prompts/list")).prompts as { name: string }[];
    expect(prompts.map((prompt) => prompt.name)).toContain("biblioteca");
  });

  it("entrega o texto do pedido", async () => {
    const mensagens = (await resultado("prompts/get", { name: "biblioteca" })).messages as {
      content: { text: string };
    }[];
    expect(mensagens[0]?.content.text).toBe("uma base documental com area geral e projetos");
  });

  it("projeto sem pedido não vira prompt fantasma", async () => {
    store.criarProjeto({ nome: "Sem pedido" });
    const prompts = (await resultado("prompts/list")).prompts as { name: string }[];
    expect(prompts.map((prompt) => prompt.name)).not.toContain("sem-pedido");
  });
});

describe("a ferramenta de material", () => {
  it("resume o que o projeto usa", async () => {
    const saida = (await resultado("tools/call", { name: "listar_material", arguments: { projeto: "biblioteca" } }))
      .content as { text: string }[];
    expect(saida[0]?.text).toContain("Biblioteca");
    expect(saida[0]?.text).toContain("memoria/estilo-de-codigo");
    expect(saida[0]?.text).not.toContain("nao-selecionada");
  });

  /*
   * Erro DA FERRAMENTA, não do protocolo: o cliente pediu certo e o dado é que
   * não existe. Confundir os dois faz o cliente tratar "não achei" como "falhei
   * ao falar", e o diagnóstico vai para o lugar errado.
   */
  it("projeto inexistente é erro da ferramenta, não do protocolo", async () => {
    const envelope = await rpc("tools/call", { name: "listar_material", arguments: { projeto: "inventado" } });
    expect(envelope.error).toBeUndefined();
    expect((envelope.result as { isError: boolean }).isError).toBe(true);
  });
});

describe("método desconhecido", () => {
  it("responde erro de protocolo em vez de cair", async () => {
    const envelope = await rpc("resources/subscribe", { uri: "x" });
    expect((envelope.error as { code: number }).code).toBe(-32601);
  });
});
