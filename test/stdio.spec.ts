import { PassThrough, Readable, Writable } from "node:stream";
import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { connectStdio, mcpEndpoint } from "../src/mcp/stdio.js";
import { Store } from "../src/db/store.js";
import { AuthStore } from "../src/auth.js";
import { createApp, listen } from "../src/http.js";
import { autenticarTeste } from "./auth-fixture.js";

const TOKEN = "dc_teste_token_secreto";
const envelope = (id: number, result: unknown = {}) => ({ jsonrpc: "2.0", id, result });
const pedido = (id: number, method = "ping") => ({ jsonrpc: "2.0", id, method });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

function capturar(): { stream: Writable; texto: () => string } {
  let texto = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { texto += chunk.toString(); callback(); } });
  return { stream, texto: () => texto };
}

async function executar(lines: unknown[], enviar: typeof fetch, options: { maxBytes?: number } = {}) {
  const output = capturar();
  const errors = capturar();
  const input = Readable.from([lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n"]);
  await connectStdio({ bootstrap: false, token: TOKEN, input, output: output.stream, errors: errors.stream, fetch: enviar, ...options });
  return { output: output.texto(), errors: errors.texto() };
}

describe("ponte MCP stdio autenticada", () => {
  it("preserva handshake, notificações silenciosas e respostas por linha", async () => {
    const enviar = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(options!.body as string);
      if (body.id === undefined) return new Response(null, { status: 202 });
      return json(envelope(body.id, body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { text: "olá\nmundo" }));
    });
    const resposta = await executar([
      pedido(1, "initialize"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      pedido(2),
    ], enviar);
    const lines = resposta.output.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([envelope(1, { protocolVersion: "2025-06-18" }), envelope(2, { text: "olá\nmundo" })]);
    expect(resposta.errors).toBe("");
    expect(resposta.output).not.toContain(TOKEN);
    expect(enviar).toHaveBeenCalledTimes(3);
    for (const [url, options] of enviar.mock.calls) {
      expect(String(url)).toBe("http://127.0.0.1:7777/mcp");
      const headers = new Headers(options?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(options?.redirect).toBe("error");
    }
  });

  it("exige token e HTTPS fora de loopback, sem credenciais na URL", async () => {
    await expect(connectStdio({ token: "" })).rejects.toThrow("DOC_CENTER_TOKEN");
    expect(mcpEndpoint("https://docs.example.com").href).toBe("https://docs.example.com/mcp");
    expect(mcpEndpoint("http://[::1]:7777/mcp").hostname).toBe("[::1]");
    for (const url of ["http://docs.example.com/mcp", "https://user:secret@example.com/mcp", "https://example.com/mcp?token=secret", "file:///tmp/x"]) {
      expect(() => mcpEndpoint(url)).toThrow();
    }
  });

  it("recusa JSON inválido e formatos perigosos e continua no pedido seguinte", async () => {
    const enviar = vi.fn<typeof fetch>(async () => json(envelope(1)));
    const resposta = await executar(["{", null, [], { jsonrpc: "2.0", id: {}, method: "ping" },
      { jsonrpc: "2.0", method: "ping", params: null }, pedido(1)], enviar);
    const lines = resposta.output.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.slice(0, 5).map((line) => line.error.code)).toEqual([-32700, -32600, -32600, -32600, -32600]);
    expect(lines[5]).toEqual(envelope(1));
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("não expõe tokens ou corpo do servidor em falhas HTTP ou de conexão", async () => {
    const enviar = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(TOKEN, { status: 401 }))
      .mockRejectedValueOnce(new Error(`fetch falhou ${TOKEN}`))
      .mockResolvedValueOnce(new Response(TOKEN, { status: 403 }));
    const resposta = await executar([pedido(1), pedido(2), { jsonrpc: "2.0", method: "notifications/initialized" }], enviar);
    expect(resposta.output).toContain("HTTP 401");
    expect(resposta.output).toContain("não foi possível conectar");
    expect(resposta.errors).toContain("HTTP 403");
    expect(resposta.output + resposta.errors).not.toContain(TOKEN);
  });

  it("valida id e JSON da resposta e não inventa resposta para HTTP 202 de pedido", async () => {
    const enviar = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(envelope(99)))
      .mockResolvedValueOnce(new Response("{", { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const resposta = await executar([pedido(1), pedido(2), pedido(3)], enviar);
    const lines = resposta.output.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.id, line.error.code])).toEqual([[1, -32000], [2, -32000], [3, -32000]]);
  });

  it("limita tanto uma linha de entrada quanto o corpo HTTP", async () => {
    const enviar = vi.fn<typeof fetch>(async () => json(envelope(1, { text: "x".repeat(200) })));
    const resposta = await executar([pedido(1)], enviar, { maxBytes: 100 });
    expect(resposta.output).toContain("resposta MCP excede o limite");
    const excessiva = await executar(["x".repeat(101), pedido(1)], enviar, { maxBytes: 100 });
    expect(excessiva.output).toContain("mensagem MCP excede o limite");
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("decodifica UTF-8 quando a linha chega dividida entre buffers", async () => {
    const bytes = Buffer.from(JSON.stringify({ ...pedido(1), params: { text: "ação" } }) + "\n");
    const corte = bytes.indexOf(Buffer.from("ç")) + 1;
    const enviar = vi.fn<typeof fetch>(async () => json(envelope(1)));
    await connectStdio({ token: TOKEN, input: Readable.from([bytes.subarray(0, corte), bytes.subarray(corte)]),
      output: capturar().stream, errors: capturar().stream, fetch: enviar });
    expect(JSON.parse(enviar.mock.calls[0]![1]!.body as string).params.text).toBe("ação");
  });

  it("recusa uma mensagem incompleta no EOF", async () => {
    const output = capturar();
    const enviar = vi.fn<typeof fetch>();
    await connectStdio({ token: TOKEN, input: Readable.from([JSON.stringify(pedido(1))]), output: output.stream, fetch: enviar });
    expect(output.texto()).toContain("mensagem MCP incompleta");
    expect(enviar).not.toHaveBeenCalled();
  });

  it("cancela HTTP pendente quando o cliente fecha o pipe", async () => {
    const input = new PassThrough();
    let entrou!: () => void;
    const iniciou = new Promise<void>((resolve) => { entrou = resolve; });
    let signal: AbortSignal | undefined;
    const enviar = vi.fn<typeof fetch>(async (_url, options) => {
      signal = options?.signal ?? undefined;
      entrou();
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelado")), { once: true }));
    });
    const output = capturar();
    const conectado = connectStdio({ token: TOKEN, input, output: output.stream, fetch: enviar });
    input.write(JSON.stringify(pedido(1)) + "\n");
    await iniciou;
    input.destroy();
    await conectado;
    expect(signal?.aborted).toBe(true);
    expect(output.texto()).toBe("");
  });

  it("conecta a um endpoint HTTP real usando Bearer e termina no EOF", async () => {
    let server: Server;
    server = createServer((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(envelope(body.id, { pong: true })));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const output = capturar();
    try {
      await connectStdio({ token: TOKEN, url: `http://127.0.0.1:${port}`, input: Readable.from([JSON.stringify(pedido(1)) + "\n"]), output: output.stream });
      expect(JSON.parse(output.texto())).toEqual(envelope(1, { pong: true }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("atravessa o servidor autenticado isolando a conta e o projeto do workflow", async () => {
    const banco = new Store({ file: ":memory:" });
    const auth = new AuthStore(banco);
    const server = createApp({ store: banco, auth });
    const base = `http://127.0.0.1:${await listen(server, 0)}`;
    try {
      const primeira = await autenticarTeste(banco, base);
      const segunda = await auth.registrar({ nome: "Outra pessoa", email: "outra@example.com", senha: "outra-senha-segura" });
      const outroStore = banco.forUser(segunda.id);
      const meuProjeto = primeira.store.criarProjeto({ nome: "Aplicação", slug: "app", pedido: "meu workflow" });
      const outroProjeto = outroStore.criarProjeto({ nome: "Aplicação privada", slug: "app", pedido: "segredo da outra conta" });
      const documento = primeira.store.criarDocumento({ projetoId: meuProjeto.id, tipo: "documentacao", titulo: "Meu documento", conteudo: "conteúdo autorizado" });
      outroStore.criarDocumento({ projetoId: outroProjeto.id, tipo: "documentacao", titulo: "Privado", conteudo: "segredo da outra conta" });
      const { token } = auth.criarToken(primeira.usuarioId, { nome: "CLI vinculada", projeto: "app", permissao: "workflow" });
      const messages = [
        pedido(1, "initialize"),
        { jsonrpc: "2.0", method: "notifications/initialized" },
        pedido(2, "resources/list"),
        { ...pedido(3, "resources/read"), params: { uri: `capivara://app/docs/documentacao/${documento.slug}` } },
        { ...pedido(4, "resources/read"), params: { uri: "capivara://app/docs/documentacao/privado" } },
        { ...pedido(5, "tools/call"), params: { name: "registrar_memoria", arguments: { projeto: "app", titulo: "Decisão da CLI", conteudo: "decisão", natureza: "decisao" } } },
        { ...pedido(6, "tools/call"), params: { name: "registrar_levantamento", arguments: { projeto: "outro-projeto", conteudo: "fora do token" } } },
        { ...pedido(7, "tools/call"), params: { name: "ler_documento", arguments: { uri: `capivara://app/docs/documentacao/${documento.slug}` } } },
        { ...pedido(8, "tools/call"), params: { name: "ler_documento", arguments: { uri: "capivara://app/docs/documentacao/privado" } } },
      ];
      const output = capturar();
      const errors = capturar();
      await connectStdio({ token, url: `${base}/mcp`, project: "app", cwd: "/tmp", input: Readable.from([messages.map((message) => JSON.stringify(message)).join("\n") + "\n"]), output: output.stream, errors: errors.stream });
      const responses = output.texto().trim().split("\n").map((line) => JSON.parse(line));
      expect(responses.map((response) => response.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(output.texto()).toContain("conteúdo autorizado");
      expect(output.texto()).not.toContain("segredo da outra conta");
      expect(output.texto()).not.toContain(token);
      expect(responses[3].error.code).toBe(-32602);
      expect(responses[5].result.isError).toBe(true);
      expect(responses[6].result.content).toEqual([{ type: "text", text: "conteúdo autorizado" }]);
      expect(responses[7].result.isError).toBe(true);
      expect(primeira.store.rascunhos(meuProjeto.id)).toHaveLength(1);
      expect(outroStore.rascunhos(outroProjeto.id)).toHaveLength(0);
      expect(primeira.store.projetoPorSlug("outro-projeto")).toBeNull();
      expect(errors.texto()).toBe("");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      banco.close();
    }
  });
});
