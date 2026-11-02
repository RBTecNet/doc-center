import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { AuthStore } from "../src/auth.js";
import { createApp, listen } from "../src/http.js";

describe("CLI distribuída com servidor autenticado", () => {
  it("instala, cria automaticamente, registra, retoma em outra CLI e aceita leitura", async () => {
    // npm test também pode rodar sem dist; verificar exatamente o artefato
    // distribuído evita diferenças entre imports de TS e o bundle Node.
    execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: resolve("."), stdio: "pipe" });
    const dir = mkdtempSync(join(tmpdir(), "doc-center-cli-e2e-"));
    const otherDir = mkdtempSync(join(tmpdir(), "doc-center-other-machine-"));
    const root = new Store({ file: ":memory:" });
    const auth = new AuthStore(root);
    const user = await auth.registrar({ nome: "Conta CLI", email: "cli@example.com", senha: "senha-forte-cli-123" });
    const token = auth.criarToken(user.id, { nome: "CLI workflow", permissao: "workflow" }).token;
    const app = createApp({ store: root, auth });
    const url = `http://127.0.0.1:${await listen(app, 0)}/mcp`;
    const cli = resolve("dist/cli.js");
    function run(args: string[], input = "", accessToken = token, cwd = dir): Promise<{ code: number | null; output: string; errors: string }> {
      return new Promise((done, reject) => {
        const processChild = spawn(process.execPath, [cli, ...args], { cwd,
          env: { ...process.env, DOC_CENTER_URL: url, DOC_CENTER_TOKEN: accessToken, DOC_CENTER_PROJECT: "cli-app" }, stdio: "pipe" });
        let output = ""; let errors = "";
        processChild.on("error", reject);
        processChild.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        processChild.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
        processChild.on("close", (code) => done({ code, output, errors }));
        processChild.stdin.end(input);
      });
    }
    try {
      const setup = await run(["setup", "--client", "codex"]);
      expect(setup.code).toBe(0);
      expect(readFileSync(join(dir, ".codex/hooks.json"), "utf8")).toContain("UserPromptSubmit");
      expect(readFileSync(join(dir, ".doc-center/project.json"), "utf8")).not.toContain(token);
      const connected = await run(["connect"], JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
      expect(connected.code).toBe(0);
      expect(JSON.parse(connected.output).result.instructions).toContain("cli-app");
      const own = root.forUser(user.id);
      const project = own.projetoPorSlug("cli-app")!;
      expect(project).not.toBeNull();
      const captured = await run(["hook", "--client", "codex"], JSON.stringify({ cwd: dir, hook_event_name: "UserPromptSubmit", session_id: "session-e2e", turn_id: "turn-e2e", prompt: "Prompt compartilhado do Codex" }));
      expect(captured.code).toBe(0);
      expect(JSON.parse(captured.output)).toEqual({});
      expect(own.contarHistorico(project.id)).toBe(1);
      const resumed = await run(["hook", "--client", "claude"], JSON.stringify({ cwd: otherDir, hook_event_name: "SessionStart", session_id: "claude-e2e" }), token, otherDir);
      expect(resumed.code).toBe(0);
      expect(JSON.parse(resumed.output).hookSpecificOutput.additionalContext).toContain("Prompt compartilhado do Codex");
      expect(resumed.output).toContain("user · codex");
      const exported = await run(["resume", "--format", "json"], "", token, otherDir);
      expect(exported.code).toBe(0);
      expect(JSON.parse(exported.output).historico.entradas[0].conteudo).toBe("Prompt compartilhado do Codex");
      const reader = auth.criarToken(user.id, { nome: "CLI leitura", permissao: "leitura", projeto: "cli-app" }).token;
      const readOnly = await run(["connect"], JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize" }) + "\n", reader);
      expect(readOnly.code).toBe(0);
      expect(JSON.parse(readOnly.output).result.instructions).toContain("cli-app");
      expect(own.listarProjetos()).toHaveLength(1);
      expect(setup.output + connected.output + captured.output + resumed.output + exported.output + readOnly.output).not.toContain(token);
    } finally {
      await new Promise<void>((done) => app.close(() => done()));
      root.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  }, 30_000);
});
