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
import { handle, type RpcResponse } from "../src/mcp/server.js";
import { autenticarTeste } from "./auth-fixture.js";
import { AuthStore } from "../src/auth.js";

let store: Store;
let rootStore: Store;
let server: Server;
let url = "";
let mcpHeaders: Record<string, string>;
let usuarioId: number;

async function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resposta = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...mcpHeaders },
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
  rootStore = store;

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
  const autenticado = await autenticarTeste(rootStore, `http://127.0.0.1:${porta}`);
  store = autenticado.store;
  mcpHeaders = autenticado.mcpHeaders;
  usuarioId = autenticado.usuarioId;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rootStore.close();
});

describe("o aperto de mão", () => {
  it("apresenta-se com versão e capacidades", async () => {
    const info = await resultado("initialize", { protocolVersion: "2025-06-18" });
    expect((info.serverInfo as { name: string }).name).toBe("doc-center");
    expect(info.capabilities).toHaveProperty("resources");
    expect(info.capabilities).toHaveProperty("prompts");
    expect(info.capabilities).toHaveProperty("tools");
  });

  it("notificação não tem resposta, e o servidor não inventa uma", async () => {
    const resposta = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...mcpHeaders },
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
    expect(saida[0]?.text).toContain("capivara://biblioteca/docs/memoria/estilo-de-codigo");
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

describe("validação e permissões MCP", () => {
  const direto = (method: string, params?: Record<string, unknown>, readOnly = false): RpcResponse =>
    handle(store, { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, { readOnly })!;

  it("recusa envelopes inválidos sem lançar exceção", () => {
    for (const request of [null, 1, [], {}, { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", method: "ping", params: [] }]) {
      expect(handle(store, request)?.error?.code).toBe(-32600);
    }
    for (const [method, params] of [
      ["resources/read", { uri: { toString: null } }],
      ["prompts/get", { name: [] }],
      ["tools/call", { name: "registrar_levantamento", arguments: null }],
      ["tools/call", { name: "registrar_levantamento", arguments: { projeto: {} } }],
    ] as const) {
      expect(direto(method, params).error?.code).toBe(-32602);
    }
  });

  it("token somente leitura oculta ferramentas de escrita e bloqueia chamada direta", () => {
    const lista = direto("tools/list", undefined, true).result as { tools: { name: string }[] };
    expect(lista.tools.map((tool) => tool.name)).toEqual(["abrir_projeto", "listar_historico", "obter_contexto", "listar_material", "ler_documento"]);
    for (const name of ["registrar_memoria", "registrar_levantamento"]) {
      const result = direto("tools/call", { name, arguments: { projeto: "novo", conteudo: "segredo" } }, true).result as { isError: boolean };
      expect(result.isError).toBe(true);
    }
    expect(store.projetoPorSlug("novo")).toBeNull();
  });

  it("rascunhos e seus arquivos não escapam por listas, leituras, prompts ou material", () => {
    const projeto = store.projetoPorSlug("biblioteca")!;
    const geral = store.criarDocumento({ tipo: "prompt", titulo: "Prompt pendente geral", conteudo: "segredo geral", status: "rascunho" });
    const local = store.criarDocumento({ projetoId: projeto.id, tipo: "prompt", titulo: "Prompt pendente local", conteudo: "segredo local", status: "rascunho" });
    store.selecionar(projeto.id, geral.id);
    store.gravarArquivo(geral.id, { caminho: "references/segredo.md", conteudo: Buffer.from("segredo arquivo"), binario: false });
    store.gravarArquivo(local.id, { caminho: "references/segredo.md", conteudo: Buffer.from("segredo arquivo"), binario: false });
    for (const method of ["resources/list", "prompts/list"]) {
      expect(JSON.stringify(direto(method).result)).not.toContain("pendente");
    }
    for (const [scope, slug] of [["geral", geral.slug], ["biblioteca", geral.slug], ["biblioteca", local.slug]]) {
      const uri = `capivara://${scope}/docs/prompt/${slug}`;
      expect(direto("resources/read", { uri }).error).toBeTruthy();
      expect(direto("resources/read", { uri: `${uri}/references/segredo.md` }).error).toBeTruthy();
      expect(direto("prompts/get", { name: `${scope}/${slug}` }).error).toBeTruthy();
      for (const alvo of [uri, `${uri}/references/segredo.md`]) {
        expect((direto("tools/call", { name: "ler_documento", arguments: { uri: alvo } }).result as { isError: boolean }).isError).toBe(true);
      }
    }
    expect(JSON.stringify(direto("tools/call", { name: "listar_material", arguments: { projeto: "biblioteca" } }).result)).not.toContain("pendente");
  });

  it("um prompt geral selecionado pode ser lido sob o projeto", () => {
    const projeto = store.projetoPorSlug("biblioteca")!;
    const prompt = store.criarDocumento({ tipo: "prompt", titulo: "Prompt compartilhado", conteudo: "pedido selecionado" });
    store.selecionar(projeto.id, prompt.id);
    expect(JSON.stringify(direto("prompts/get", { name: `biblioteca/${prompt.slug}` }).result)).toContain("pedido selecionado");
  });

  it("clientes de ferramentas leem documentos e arquivos de texto ou binários com token de leitura", () => {
    const projeto = store.projetoPorSlug("biblioteca")!;
    const doc = store.criarDocumento({ projetoId: projeto.id, tipo: "skill", titulo: "Pacote da CLI", conteudo: "conteúdo da skill" });
    store.gravarArquivo(doc.id, { caminho: "references/guia.md", conteudo: Buffer.from("guia do pacote"), binario: false });
    const binario = Buffer.from([0, 255, 23]);
    store.gravarArquivo(doc.id, { caminho: "assets/print.bin", conteudo: binario, binario: true });
    const uri = `capivara://biblioteca/docs/skill/${doc.slug}`;
    const material = JSON.stringify(direto("tools/call", { name: "listar_material", arguments: { projeto: "biblioteca" } }, true).result);
    expect(material).toContain(`${uri}/references/guia.md`);
    expect(material).toContain(`${uri}/assets/print.bin`);
    const ler = (alvo: string) => direto("tools/call", { name: "ler_documento", arguments: { uri: alvo } }, true).result;
    expect(ler(uri)).toEqual({ content: [{ type: "text", text: "conteúdo da skill" }] });
    expect(ler(`${uri}/references/guia.md`)).toEqual({ content: [{ type: "text", text: "guia do pacote" }] });
    expect(ler(`${uri}/assets/print.bin`)).toEqual({ content: [{ type: "resource", resource: {
      uri: `${uri}/assets/print.bin`, mimeType: "application/octet-stream", blob: binario.toString("base64"),
    } }] });
    for (const negada of ["capivara://biblioteca/docs/skill/nao-selecionada", "file:///etc/passwd"]) {
      expect((ler(negada) as { isError: boolean }).isError).toBe(true);
    }
  });

  it("a leitura por ferramenta também respeita o projeto do token e outra conta com o mesmo slug", async () => {
    const outraConta = await new AuthStore(rootStore).registrar({ nome: "Outra conta", email: "outra@example.com", senha: "outra-senha-segura" });
    const isolado = rootStore.forUser(outraConta.id);
    const outro = isolado.criarProjeto({ nome: "Biblioteca", slug: "biblioteca" });
    isolado.criarDocumento({ projetoId: outro.id, tipo: "documentacao", titulo: "Segredo alheio", conteudo: "segredo alheio" });
    const vinculado = rootStore.forUser(usuarioId, "biblioteca");
    for (const uri of ["capivara://outro/pedido", "capivara://geral/docs/skill/nao-selecionada", "capivara://biblioteca/docs/documentacao/segredo-alheio"]) {
      const resposta = handle(vinculado, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ler_documento", arguments: { uri } } }, { readOnly: true })!;
      expect((resposta.result as { isError: boolean }).isError).toBe(true);
      expect(JSON.stringify(resposta)).not.toContain('"text":"segredo alheio"');
    }
  });
});
