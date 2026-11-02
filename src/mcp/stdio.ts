/** Ponte MCP stdio → HTTP. A autenticação continua no servidor, por usuário. */
import type { Readable, Writable } from "node:stream";
import { isRpcRequest, PROTOCOL_VERSION, type RpcRequest, type RpcResponse } from "./server.js";
import { resolveProject } from "../client/project.js";
import { RemoteClient, MAX_MCP_BYTES, mcpEndpoint, corpoLimitado } from "../client/remote.js";
export { MAX_MCP_BYTES, mcpEndpoint } from "../client/remote.js";

export interface StdioOptions {
  url?: string;
  token?: string;
  input?: Readable;
  output?: Writable;
  errors?: Writable;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** false é útil para clientes que só encaminham protocolo, sem workspace. */
  bootstrap?: boolean;
  cwd?: string;
  project?: string;
}

function escrever(stream: Writable, mensagem: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(mensagem, (erro) => erro ? reject(erro) : resolve());
  });
}

const objeto = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === "object" && valor !== null && !Array.isArray(valor);

function respostaValida(valor: unknown, pedido: RpcRequest): valor is RpcResponse {
  if (!objeto(valor) || valor.jsonrpc !== "2.0" || valor.id !== pedido.id) return false;
  if ("result" in valor) return !("error" in valor);
  return objeto(valor.error) && typeof valor.error.code === "number" && typeof valor.error.message === "string";
}

/** Uma linha por mensagem; EOF drena pedidos completos e encerra o processo. */
export async function connectStdio(options: StdioOptions = {}): Promise<void> {
  const token = (options.token ?? process.env.DOC_CENTER_TOKEN ?? "").trim();
  if (!token || /\s/.test(token)) throw new Error("defina DOC_CENTER_TOKEN com o token criado na área logada");
  const endpoint = mcpEndpoint(options.url ?? process.env.DOC_CENTER_URL ?? "http://127.0.0.1:7777/mcp");
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errors = options.errors ?? process.stderr;
  const enviar = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_MCP_BYTES;
  const abortar = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abortar.signal]) : abortar.signal;
  let protocolVersion = PROTOCOL_VERSION;
  let projetoAberto: string | undefined;

  // Um pipe fechado pelo cliente cancela o HTTP em andamento. EOF normal
  // permite responder ao último pedido que já chegou inteiro.
  const fechado = (): void => { if (!input.readableEnded) abortar.abort(); };
  const saidaFechada = (): void => { abortar.abort(); input.destroy(); };
  input.on("close", fechado);
  output.on("error", saidaFechada);
  output.on("close", saidaFechada);

  const erroRpc = (id: RpcResponse["id"], code: number, message: string): Promise<void> =>
    escrever(output, JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

  async function linha(bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    let pedido: unknown;
    try { pedido = JSON.parse(bytes.toString("utf8")); } catch {
      await erroRpc(null, -32700, "JSON inválido");
      return;
    }
    if (!isRpcRequest(pedido)) {
      await erroRpc(null, -32600, "requisição JSON-RPC inválida");
      return;
    }
    try {
      const resposta = await enviar(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "mcp-protocol-version": protocolVersion,
        },
        body: JSON.stringify(pedido),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]),
      });
      if (!resposta.ok) {
        await resposta.body?.cancel();
        throw new Error(`servidor MCP respondeu HTTP ${resposta.status}`);
      }
      if (pedido.id === undefined) {
        await resposta.body?.cancel();
        if (resposta.status !== 202) throw new Error("notificação MCP deve responder HTTP 202");
        return;
      }
      if (resposta.status === 202) throw new Error("servidor MCP não respondeu ao pedido");
      if (!resposta.headers.get("content-type")?.startsWith("application/json")) {
        await resposta.body?.cancel();
        throw new Error("servidor doc-center deve responder JSON");
      }
      const body = await corpoLimitado(resposta, maxBytes);
      let envelope: unknown;
      try { envelope = JSON.parse(body); } catch { throw new Error("servidor MCP devolveu JSON inválido"); }
      if (!respostaValida(envelope, pedido)) throw new Error("resposta JSON-RPC inválida");
      if (pedido.method === "initialize" && objeto(envelope.result) && typeof envelope.result.protocolVersion === "string") {
        protocolVersion = envelope.result.protocolVersion;
        if (options.bootstrap !== false && !projetoAberto) {
          const project = await resolveProject(options);
          const remote = new RemoteClient({ url: endpoint.href, token, fetch: enviar, signal,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
          await remote.tool("abrir_projeto", { projeto: project.slug, nome: project.nome, repositorio: project.repositorio });
          projetoAberto = project.slug;
          envelope.result.instructions = `${typeof envelope.result.instructions === "string" ? envelope.result.instructions + "\n" : ""}` +
            `Workspace vinculado ao projeto ${projetoAberto}. Use obter_contexto para retomar o trabalho e listar_historico/ler_documento para mensagens anteriores. ` +
            "A captura automática dos prompts usa os hooks instalados por doc-center setup; MCP sozinho não recebe a conversa da CLI.";
        }
      }
      await escrever(output, JSON.stringify(envelope) + "\n");
    } catch (erro) {
      if (signal.aborted) return;
      // Mensagens do fetch ou do servidor podem conter URLs e credenciais.
      // Só erros controlados pela ponte são mostrados.
      const message = erro instanceof Error && (
        erro.message.startsWith("servidor MCP ") || erro.message.startsWith("servidor doc-center ") ||
        erro.message.startsWith("pedido MCP recusado;") || erro.message.startsWith("DOC_CENTER_PROJECT ") ||
        ["resposta JSON-RPC inválida", "resposta MCP excede o limite"].includes(erro.message)
      ) ? erro.message : "não foi possível conectar ao doc-center; verifique URL, token e disponibilidade";
      if (pedido.id === undefined) await escrever(errors, message + "\n");
      else await erroRpc(pedido.id, -32000, message);
    }
  }

  let pendente = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      if (signal.aborted) break;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      let inicio = 0;
      while (inicio < bytes.length) {
        const fim = bytes.indexOf(10, inicio);
        const parte = bytes.subarray(inicio, fim < 0 ? bytes.length : fim);
        if (pendente.length + parte.length > maxBytes) {
          await erroRpc(null, -32600, "mensagem MCP excede o limite");
          input.destroy();
          return;
        }
        pendente = Buffer.concat([pendente, parte]);
        if (fim < 0) break;
        await linha(pendente);
        pendente = Buffer.alloc(0);
        inicio = fim + 1;
      }
    }
    if (!signal.aborted && pendente.length > 0) await erroRpc(null, -32700, "mensagem MCP incompleta; termine com uma nova linha");
  } catch (erro) {
    if (!signal.aborted) throw erro;
  } finally {
    abortar.abort();
    input.off("close", fechado);
    output.off("error", saidaFechada);
    output.off("close", saidaFechada);
  }
}
