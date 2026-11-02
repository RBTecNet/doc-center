/** Cliente autenticado compartilhado por hooks e pela ponte de protocolo. */
export const MAX_MCP_BYTES = 8 * 1024 * 1024;

export function mcpEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DOC_CENTER_URL deve ser uma URL HTTP(S) válida"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("DOC_CENTER_URL deve ser HTTP(S), sem credenciais, query ou fragmento");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("DOC_CENTER_URL remoto exige HTTPS");
  }
  if (url.pathname === "/") url.pathname = "/mcp";
  return url;
}

export const objeto = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function corpoLimitado(response: Response, maxBytes = MAX_MCP_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  try {
    while (true) {
      const parte = await reader.read();
      if (parte.done) break;
      tamanho += parte.value.byteLength;
      if (tamanho > maxBytes) throw new Error("resposta MCP excede o limite");
      partes.push(parte.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(partes).toString("utf8");
}

export interface RemoteOptions {
  url?: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class RemoteClient {
  readonly endpoint: URL;
  readonly token: string;
  private readonly options: RemoteOptions;
  private id = 0;
  constructor(options: RemoteOptions = {}) {
    this.options = options;
    this.token = (options.token ?? process.env.DOC_CENTER_TOKEN ?? "").trim();
    if (!this.token || /\s/.test(this.token)) throw new Error("defina DOC_CENTER_TOKEN com o token criado na área logada");
    this.endpoint = mcpEndpoint(options.url ?? process.env.DOC_CENTER_URL ?? "http://127.0.0.1:7777/mcp");
  }
  async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.id;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${this.token}`,
          "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
        signal: this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(this.options.timeoutMs ?? 30_000)])
          : AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch { throw new Error("doc-center indisponível; verifique URL, token e conexão"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`servidor MCP respondeu HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.startsWith("application/json")) {
      await response.body?.cancel();
      throw new Error("resposta MCP inválida");
    }
    let value: unknown;
    try { value = JSON.parse(await corpoLimitado(response)); } catch { throw new Error("resposta MCP inválida"); }
    if (!objeto(value) || value.jsonrpc !== "2.0" || value.id !== id || !objeto(value.result)) {
      throw new Error("pedido MCP recusado; confira o projeto e a permissão do token");
    }
    if (value.result.isError) throw new Error("pedido MCP recusado; confira o projeto, repositório e a permissão workflow do token");
    if (objeto(value.result.structuredContent)) return value.result.structuredContent;
    const content = value.result.content;
    if (Array.isArray(content) && objeto(content[0]) && typeof content[0].text === "string") {
      try { const parsed: unknown = JSON.parse(content[0].text); if (objeto(parsed)) return parsed; } catch { /* resultado não estruturado */ }
    }
    throw new Error("resposta MCP não contém dados estruturados");
  }
}
