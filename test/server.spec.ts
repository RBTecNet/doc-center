import { createServer, Server, type Server as HttpServer } from "node:http";
import { createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/db/store.js";
import { startServers } from "../src/server.js";
import { autenticarTeste } from "./auth-fixture.js";

type Running = Awaited<ReturnType<typeof startServers>>;
let store: Store;
const running = new Set<Running>();
const listeners = new Set<HttpServer>();

async function start(options: Parameters<typeof startServers>[0] = { store, webPort: 0, mcpPort: 0 }) {
  const pair = await startServers(options);
  running.add(pair);
  return pair;
}
async function close(pair: Running): Promise<void> { await pair.close(); running.delete(pair); }
async function reserve(): Promise<{ server: HttpServer; port: number }> {
  const server = createServer();
  listeners.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as { port: number }).port };
}
async function closeListener(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  listeners.delete(server);
}

beforeEach(() => { store = new Store({ file: ":memory:" }); });
afterEach(async () => {
  for (const pair of running) await pair.close();
  running.clear();
  for (const server of listeners) await closeListener(server);
  store.close();
  vi.restoreAllMocks();
});

describe("dois listeners compartilhando a mesma conta", () => {
  it("cadastro e token da web autenticam o MCP na sua porta exclusiva", async () => {
    const pair = await start();
    expect(pair.webPort).toBeGreaterThan(0);
    expect(pair.mcpPort).toBeGreaterThan(0);
    expect(pair.webPort).not.toBe(pair.mcpPort);
    const web = `http://127.0.0.1:${pair.webPort}`;
    const mcp = `http://127.0.0.1:${pair.mcpPort}/mcp`;
    const account = await autenticarTeste(store, web);
    const initialized = await fetch(mcp, { method: "POST", headers: { ...account.mcpHeaders, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: expect.any(String) } });

    const webRpc = await fetch(`${web}/mcp`, { method: "POST", headers: account.mcpHeaders, body: "{}", redirect: "manual" });
    expect(webRpc.status).toBe(404);
    expect(await webRpc.text()).not.toContain("protocolVersion");
    const revoked = await fetch(`${web}/api/tokens`, { headers: account.headers });
    const { tokens } = await revoked.json() as { tokens: { id: number }[] };
    expect((await fetch(`${web}/api/tokens/${tokens[0]!.id}`, { method: "DELETE", headers: account.headers })).status).toBe(204);
    const denied = await fetch(mcp, { method: "POST", headers: account.mcpHeaders, body: '{"jsonrpc":"2.0","id":2,"method":"ping"}' });
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
  });

  it("encerra ambos os listeners sem fechar o banco e permite reiniciar as credenciais", async () => {
    const first = await start();
    const account = await autenticarTeste(store, `http://127.0.0.1:${first.webPort}`);
    const project = account.store.criarProjeto({ nome: "Persistido", pedido: "Preserve este pedido" });
    account.store.registrarHistorico(project.id, { eventoId: "um", origem: "codex", sessao: "sessao", papel: "user", conteudo: "Pedido registrado" });
    await close(first);
    expect(first.web.listening).toBe(false);
    expect(first.mcp.listening).toBe(false);
    expect(account.store.projetoPorSlug("persistido")?.pedido).toBe("Preserve este pedido");
    expect(account.store.contarHistorico(project.id)).toBe(1);
    await first.close(); // Encerramento pode ser solicitado por mais de um sinal.

    const next = await start();
    const session = await fetch(`http://127.0.0.1:${next.webPort}/api/auth/me`, { headers: account.headers });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ usuario: { id: account.usuarioId } });
    const token = await fetch(`http://127.0.0.1:${next.mcpPort}/mcp`, { method: "POST", headers: account.mcpHeaders,
      body: '{"jsonrpc":"2.0","id":3,"method":"ping"}' });
    expect(token.status).toBe(200);
    await token.body?.cancel();
  });

  it("encerra também conexões TCP ociosas em ambas as portas", async () => {
    const pair = await start();
    const sockets = [pair.webPort, pair.mcpPort].map((port) => createConnection({ port, host: "127.0.0.1" }));
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve); socket.once("error", reject);
    })));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = pair.close();
    try {
      await Promise.race([closing, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("shutdown deixou conexões ociosas abertas")), 2_500);
      })]);
      expect(pair.web.listening).toBe(false);
      expect(pair.mcp.listening).toBe(false);
    } finally {
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await closing;
      running.delete(pair);
    }
  });
});

describe("abertura atômica das portas", () => {
  it("se a porta MCP estiver ocupada, libera a web para outra tentativa", async () => {
    const occupied = await reserve();
    const freeWeb = await reserve();
    await closeListener(freeWeb.server);
    await expect(startServers({ store, webPort: freeWeb.port, mcpPort: occupied.port }))
      .rejects.toThrow(/EADDRINUSE|address already in use/i);
    await closeListener(occupied.server);
    const recovered = await start({ store, webPort: freeWeb.port, mcpPort: occupied.port });
    expect(recovered.webPort).toBe(freeWeb.port);
    expect(recovered.mcpPort).toBe(occupied.port);
  });

  it("se a segunda porta falhar, desfaz o bind MCP já aberto", async () => {
    const occupiedWeb = await reserve();
    const freeMcp = await reserve();
    await closeListener(freeMcp.server);
    await expect(startServers({ store, webPort: occupiedWeb.port, mcpPort: freeMcp.port }))
      .rejects.toThrow(/EADDRINUSE|address already in use/i);
    await closeListener(occupiedWeb.server);
    const recovered = await start({ store, webPort: occupiedWeb.port, mcpPort: freeMcp.port });
    expect(recovered.webPort).toBe(occupiedWeb.port);
    expect(recovered.mcpPort).toBe(freeMcp.port);
  });

  it("recusa portas inválidas e portas fixas iguais antes de tentar bind", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    for (const invalid of [-1, 65_536, 1.5, NaN, Infinity]) {
      await expect(startServers({ store, webPort: invalid, mcpPort: 0 })).rejects.toThrow();
      await expect(startServers({ store, webPort: 0, mcpPort: invalid })).rejects.toThrow();
    }
    await expect(startServers({ store, webPort: 7777, mcpPort: 7777 })).rejects.toThrow();
    expect(listen).not.toHaveBeenCalled();
    expect(store.listarProjetos()).toEqual([]);
  });
});
