/** Dois listeners, uma base de dados e uma identidade de usuário. */
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { AuthStore } from "./auth.js";
import type { Store } from "./db/store.js";
import { createApp, listen, type AppOptions } from "./http.js";

export interface ServerOptions extends Omit<AppOptions, "port" | "surface"> {
  webPort?: number;
  mcpPort?: number;
}

export interface RunningServers {
  web: Server;
  mcp: Server;
  webPort: number;
  mcpPort: number;
  mcpUrl: string;
  close(): Promise<void>;
}

export class ListenerError extends Error {
  readonly code: string | undefined;
  constructor(readonly service: "web" | "mcp", readonly port: number, error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    super(`não foi possível abrir ${service === "web" ? "a interface" : "o MCP"} na porta ${port}${code ? ` (${code})` : ""}`, { cause: error });
    this.code = code;
  }
}

function validarPorta(port: number, name: string): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} deve ser uma porta inteira entre 0 e 65535`);
}

function rastrear(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

async function fechar(server: Server, sockets: Set<Socket>): Promise<void> {
  if (!server.listening) { for (const socket of sockets) socket.destroy(); return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      // Dá tempo aos pedidos em andamento; clientes TCP sem request também
      // precisam encerrar para que SIGTERM não deixe o processo pendurado.
      timer = setTimeout(() => {
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }, 1000);
      timer.unref();
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  } finally { if (timer) clearTimeout(timer); }
}

function localUrl(host: string, port: number): string {
  const usable = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
  return `http://${usable.includes(":") && !usable.startsWith("[") ? `[${usable}]` : usable}:${port}/mcp`;
}

export async function startServers(options: ServerOptions): Promise<RunningServers> {
  const webPort = options.webPort ?? 80;
  const mcpPort = options.mcpPort ?? 7777;
  validarPorta(webPort, "--web-port/DOC_CENTER_WEB_PORT");
  validarPorta(mcpPort, "--mcp-port/DOC_CENTER_MCP_PORT");
  if (webPort === mcpPort && webPort !== 0) throw new Error("as portas da interface e do MCP devem ser diferentes");
  const host = options.host ?? "127.0.0.1";
  const auth = options.auth ?? new AuthStore(options.store);
  const mcp = createApp({ store: options.store, auth, host, surface: "mcp",
    ...(options.trustedProxy ? { trustedProxy: options.trustedProxy } : {}),
    ...(options.mcpPublicUrl ? { publicUrl: options.mcpPublicUrl, mcpPublicUrl: options.mcpPublicUrl } : {}) });
  const mcpSockets = rastrear(mcp);
  let web: Server | undefined;
  let webSockets = new Set<Socket>();
  try {
    let actualMcpPort: number;
    try { actualMcpPort = await listen(mcp, mcpPort, host); }
    catch (error) { throw new ListenerError("mcp", mcpPort, error); }
    // O port 0 também funciona: o endpoint divulgado usa a porta realmente
    // atribuída pelo SO. Em produção, uma URL explícita descreve o proxy/TLS.
    const mcpUrl = options.mcpPublicUrl ?? localUrl(host, actualMcpPort);
    web = createApp({ store: options.store, auth, host, surface: "web", mcpPublicUrl: mcpUrl,
      ...(options.trustedProxy ? { trustedProxy: options.trustedProxy } : {}),
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
      ...(options.registration ? { registration: options.registration } : {}) });
    webSockets = rastrear(web);
    let actualWebPort: number;
    try { actualWebPort = await listen(web, webPort, host); }
    catch (error) { throw new ListenerError("web", webPort, error); }
    const webServer = web;
    let closing: Promise<void> | undefined;
    return { web: webServer, mcp, webPort: actualWebPort, mcpPort: actualMcpPort, mcpUrl,
      close: () => { closing ??= Promise.all([fechar(webServer, webSockets), fechar(mcp, mcpSockets)]).then(() => {}); return closing; } };
  } catch (error) {
    await Promise.all([...(web ? [fechar(web, webSockets)] : []), fechar(mcp, mcpSockets)]);
    throw error;
  }
}
