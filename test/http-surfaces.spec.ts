import { request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../src/auth.js";
import { Store } from "../src/db/store.js";
import { createApp, listen, type AppOptions } from "../src/http.js";
import { autenticarTeste } from "./auth-fixture.js";

let store: Store;
let auth: AuthStore;
const servers: Server[] = [];

async function open(surface: "web" | "mcp", options: Partial<AppOptions> = {}): Promise<string> {
  const server = createApp({ store, auth, surface, ...options });
  servers.push(server);
  return `http://127.0.0.1:${await listen(server, 0)}`;
}
async function get(base: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { redirect: "manual", headers });
  return { status: response.status, body: await response.text() };
}
async function rpc(base: string, headers: Record<string, string>) {
  const response = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  return { status: response.status, body: await response.text() };
}
function rawGet(base: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(base + "/login", { headers }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.end();
  });
}

beforeEach(() => { store = new Store({ file: ":memory:" }); auth = new AuthStore(store); });
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

describe("superfícies web e MCP exclusivas", () => {
  it("não expõe páginas, assets ou APIs de sessão na porta MCP mesmo com credenciais válidas", async () => {
    const web = await open("web");
    const mcp = await open("mcp");
    const account = await autenticarTeste(store, web);
    const paths = ["/", "/login", "/cadastro", "/conta", "/app.js", "/api/auth/me", "/api/tokens", "/api/projetos"];
    for (const headers of [{}, account.headers, account.mcpHeaders]) {
      for (const path of paths) {
        const response = await get(mcp, path, headers);
        expect(response.status, path).toBe(404);
        expect(response.body).not.toContain("teste@example.com");
      }
    }
    for (const path of ["/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/tokens", "/api/projetos"]) {
      const response = await fetch(mcp + path, { method: "POST", headers: { ...account.headers, "content-type": "application/json" }, body: "{JSON inválido" });
      expect(response.status, path).toBe(404);
      await response.body?.cancel();
    }
    expect(store.banco.prepare("SELECT COUNT(*) AS total FROM usuarios").get()).toEqual({ total: 1 });
  });

  it("só Bearer autentica MCP, e a web não oferece /mcp nem administração por token", async () => {
    const web = await open("web");
    const mcp = await open("mcp");
    const account = await autenticarTeste(store, web);
    expect((await rpc(mcp, {})).status).toBe(401);
    expect((await rpc(mcp, account.headers)).status).toBe(401);
    expect((await rpc(mcp, account.mcpHeaders)).status).toBe(200);
    for (const headers of [{}, account.headers, account.mcpHeaders, { ...account.headers, ...account.mcpHeaders }]) {
      expect((await rpc(web, headers)).status).toBe(404);
      expect((await get(web, "/mcp", headers)).status).toBe(404);
    }
    expect((await get(web, "/api/tokens", account.mcpHeaders)).status).toBe(401);
    expect((await get(web, "/api/tokens", { ...account.headers, ...account.mcpHeaders })).status).toBe(403);
    expect((await get(web, "/api/auth/me", account.headers)).status).toBe(200);
  });

  it("mantém validação de Origin independente em cada porta", async () => {
    const web = await open("web");
    const mcp = await open("mcp");
    const account = await autenticarTeste(store, web);
    expect((await get(web, "/api/auth/me", { ...account.headers, origin: web })).status).toBe(200);
    expect((await get(web, "/api/auth/me", { ...account.headers, origin: mcp })).status).toBe(403);
    expect((await rpc(mcp, { ...account.mcpHeaders, origin: mcp })).status).toBe(200);
    expect((await rpc(mcp, { ...account.mcpHeaders, origin: web })).status).toBe(403);
    expect((await get(mcp, "/login", { origin: web })).status).toBe(403);
    expect(await rawGet(mcp, { host: "host-malicioso.example" })).toBe(403);
  });

  it("mostra na conta o endpoint MCP configurado sem usar a porta da web", async () => {
    const endpoint = "https://mcp.example.com:7443/mcp";
    const web = await open("web", { mcpPublicUrl: endpoint });
    const account = await autenticarTeste(store, web);
    const page = await get(web, "/conta", account.headers);
    expect(page.status).toBe(200);
    expect(page.body).toContain("data-mcp-endpoint");
    expect(page.body).toContain(endpoint);
    expect(page.body).toContain("DOC_CENTER_URL");
    expect(page.body).not.toContain(web + "/mcp");
  });
});

describe("configuração pública das origens", () => {
  it.each(["http://localhost:80", "http://[::1]:80"])("normaliza Host e Origin na porta HTTP padrão de %s", async (publicUrl) => {
    const web = await open("web", { publicUrl });
    const host = new URL(publicUrl).hostname;
    const origin = new URL(publicUrl).origin;
    expect(await rawGet(web, { host, origin })).toBe(200);
    expect(await rawGet(web, { host: `${host}:80`, origin: publicUrl })).toBe(200);
    expect(await rawGet(web, { host: `${host}:81`, origin })).toBe(403);
    expect(await rawGet(web, { host: "malicioso.example", origin })).toBe(403);
    expect(await rawGet(web, { host, origin: "http://malicioso.example" })).toBe(403);
  });

  it("recusa endpoint MCP inválido antes de abrir o listener", () => {
    for (const mcpPublicUrl of [
      "não-é-url", "ftp://example.com/mcp", "https://user:secret@example.com/mcp",
      "https://example.com/mcp?token=segredo", "https://example.com/mcp#fragmento",
      "https://example.com/", "https://example.com/mcp/", "https://example.com/cli/mcp",
    ]) {
      expect(() => createApp({ store, auth, surface: "web", mcpPublicUrl })).toThrow();
    }
  });
});
