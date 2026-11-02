import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";

beforeAll(() => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: resolve("."), stdio: "pipe" });
});

function ready(child: ChildProcessWithoutNullStreams, output: () => string, errors: () => string): Promise<{ web: string; mcp: string }> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => finish(new Error("CLI não anunciou os dois listeners: " + output() + errors())), 8_000);
    const onExit = (code: number | null): void => finish(new Error(`CLI encerrou durante o startup (${code}): ${errors()}`));
    const check = (): void => {
      const web = /interface\s+(https?:\/\/\S+)/.exec(output())?.[1];
      const mcp = /mcp\s+(https?:\/\/\S+)/.exec(output())?.[1];
      if (web && mcp) finish(undefined, { web, mcp });
    };
    const finish = (error?: Error, endpoints?: { web: string; mcp: string }): void => {
      clearTimeout(timer);
      child.stdout.off("data", check);
      child.off("error", finish);
      child.off("exit", onExit);
      if (error) reject(error); else resolveReady(endpoints!);
    };
    child.stdout.on("data", check);
    child.once("error", finish);
    child.once("exit", onExit);
    check();
  });
}

describe("servidores pelo script de inicialização e CLI distribuída", () => {
  it("anuncia as portas efêmeras separadas e SIGTERM conserva os registros no banco", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doc-center-two-ports-"));
    const db = join(directory, "persistente.db");
    const child = spawn("bash", [resolve("start.sh"), "--db", db, "--host", "127.0.0.1", "--web-port", "0", "--mcp-port", "0"],
      { cwd: directory, env: { ...process.env, DOC_CENTER_NODE: process.execPath, DOC_CENTER_PUBLIC_URL: "", DOC_CENTER_MCP_PUBLIC_URL: "", DOC_CENTER_REGISTRATION: "open" }, stdio: "pipe" });
    let output = ""; let errors = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once("close", (code, signal) => done({ code, signal })));
    child.stdin.end();
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const endpoints = await ready(child, () => output, () => errors);
      const web = new URL(endpoints.web);
      const mcp = new URL(endpoints.mcp);
      expect(Number(web.port)).toBeGreaterThan(0);
      expect(Number(mcp.port)).toBeGreaterThan(0);
      expect(web.port).not.toBe(mcp.port);
      expect(mcp.pathname).toBe("/mcp");
      const login = await fetch(new URL("/login", web));
      expect(login.status).toBe(200);
      await login.body?.cancel();
      const wrongPort = await fetch(new URL("/login", mcp), { redirect: "manual" });
      expect(wrongPort.status).toBe(404);
      await wrongPort.body?.cancel();

      const account = await fetch(new URL("/api/auth/register", web), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ nome: "Conta CLI", email: "duas-portas@example.com", senha: "senha-forte-servidor-123" }) });
      expect(account.status).toBe(201);
      const { usuario } = await account.json() as { usuario: { id: number } };
      const cookie = account.headers.get("set-cookie")!.split(";")[0]!;
      const credential = await fetch(new URL("/api/tokens", web), { method: "POST", headers: { cookie, "content-type": "application/json" },
        body: '{"nome":"CLI workflow"}' });
      expect(credential.status).toBe(201);
      const { token } = await credential.json() as { token: string };
      async function tool(name: string, args: Record<string, unknown>) {
        const response = await fetch(mcp, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        expect(response.status).toBe(200);
        const body = await response.json() as { result: { isError?: boolean } };
        expect(body.result.isError).not.toBe(true);
      }
      await tool("abrir_projeto", { projeto: "cli-servidor", nome: "CLI servidor" });
      await tool("registrar_prompt", { projeto: "cli-servidor", evento_id: "persistido", origem: "codex", sessao: "sessao-cli", papel: "user", conteudo: "Não perder ao desligar." });
      expect(output).not.toContain(token);
      child.kill("SIGTERM");
      const result = await Promise.race([closed, new Promise<never>((_, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error("SIGTERM não encerrou os listeners")), 4_000);
      })]);
      clearTimeout(shutdownTimer);
      expect(result).toEqual({ code: 0, signal: null });

      const reopened = new Store({ file: db });
      try {
        const own = reopened.forUser(usuario.id);
        const project = own.projetoPorSlug("cli-servidor")!;
        expect(project).not.toBeNull();
        expect(own.listarHistorico(project.id)).toMatchObject([{ eventoId: "persistido", conteudo: "Não perder ao desligar." }]);
      } finally { reopened.close(); }
    } finally {
      clearTimeout(shutdownTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
