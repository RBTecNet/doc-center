import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { handle } from "../src/mcp/server.js";
import { connectStdio } from "../src/mcp/stdio.js";
import { runHook, syncProject, readHookInput } from "../src/client/hooks.js";
import { resolveProject, saveProject, repositorioPortatil } from "../src/client/project.js";
import { RemoteClient } from "../src/client/remote.js";
import { renderContext } from "../src/client/context.js";

const dirs: string[] = [];
const stores: Store[] = [];
function directory(): string { const path = mkdtempSync(join(tmpdir(), "doc-center-client-")); dirs.push(path); return path; }
function fixture() {
  const root = new Store({ file: ":memory:" }); stores.push(root);
  const store = root.forUser(1);
  const fetcher: typeof fetch = async (_url, init) => {
    const request: unknown = JSON.parse(init!.body as string);
    const response = handle(store, request);
    return response === null ? new Response(null, { status: 202 }) : new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  const options = { cwd: directory(), project: "app", token: "dct_local_test", fetch: fetcher };
  return { store, options };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("histórico automático e contexto portátil", () => {
  it("cria projeto no initialize e preserva pedido/nome ao conectar novamente", async () => {
    const { store, options } = fixture();
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n";
    await connectStdio({ ...options, input: Readable.from([message]), output: stream });
    const projeto = store.projetoPorSlug("app")!;
    expect(projeto).not.toBeNull();
    expect(JSON.parse(output).result.instructions).toContain("projeto app");
    store.atualizarProjeto(projeto.slug, { nome: "Nome preservado", pedido: "Pedido preservado" });
    output = "";
    await connectStdio({ ...options, input: Readable.from([message]), output: stream });
    expect(store.listarProjetos()).toHaveLength(1);
    expect(store.projetoPorSlug("app")).toMatchObject({ nome: "Nome preservado", pedido: "Pedido preservado" });
  });
  it("captura cada prompt nativo uma vez e conserva repetições em outros turnos", async () => {
    const { store, options } = fixture();
    const input = { hook_event_name: "UserPromptSubmit", session_id: "sessao", turn_id: "turno-1", prompt: "Faça o ajuste", model: "modelo" };
    await runHook(input, { ...options, client: "codex" });
    await runHook(input, { ...options, client: "codex" });
    await runHook({ ...input, turn_id: "turno-2" }, { ...options, client: "codex" });
    const projeto = store.projetoPorSlug("app")!;
    expect(store.contarHistorico(projeto.id)).toBe(2);
    expect(store.listarHistorico(projeto.id).map((event) => event.conteudo)).toEqual(["Faça o ajuste", "Faça o ajuste"]);
    const stop = { hook_event_name: "Stop", session_id: "sessao", turn_id: "turno-2", last_assistant_message: "Ajuste feito", model: "modelo" };
    expect((await runHook(stop, { ...options, client: "codex" })).output).toEqual({});
    await runHook(stop, { ...options, client: "codex" });
    expect(store.listarHistorico(projeto.id).map((event) => event.papel)).toEqual(["user", "user", "assistant"]);
  });
  it("não elimina dois prompts iguais sem ID nativo, e deduplica Stop entre reentradas", async () => {
    const { store, options } = fixture();
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "claude-sessao", prompt: "Continue" };
    const stop = { hook_event_name: "Stop", session_id: "claude-sessao", last_assistant_message: "Concluído" };
    for (let i = 0; i < 2; i++) {
      await runHook(prompt, { ...options, client: "claude" });
      await runHook(stop, { ...options, client: "claude" });
      await runHook(stop, { ...options, client: "claude" });
    }
    expect(store.listarHistorico(store.projetoPorSlug("app")!.id).map((e) => e.papel)).toEqual(["user", "assistant", "user", "assistant"]);
  });
  it("preserva prompt sem rede e sincroniza após reiniciar o processo", async () => {
    const { store, options } = fixture();
    const offline: typeof fetch = async () => { throw new Error("segredo_token_do_servidor"); };
    const captured = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "sessao", turn_id: "offline", prompt: "Não perder esta mensagem" },
      { ...options, fetch: offline, client: "codex" });
    expect(captured.warning).toContain("1 registros preservados");
    expect(captured.warning).not.toContain("segredo_token");
    expect(store.listarProjetos()).toHaveLength(0);
    expect(await syncProject(options)).toEqual({ enviados: 1, pendentes: 0 });
    expect(await syncProject(options)).toEqual({ enviados: 0, pendentes: 0 });
    expect(store.listarHistorico(store.projetoPorSlug("app")!.id)[0]!.conteudo).toBe("Não perder esta mensagem");
  });
  it("retoma em outra pasta e CLI com documentos, prompts e papéis originais", async () => {
    const { store, options } = fixture();
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "codex-1", turn_id: "1", prompt: "Implemente login" }, { ...options, client: "codex" });
    const project = store.projetoPorSlug("app")!;
    store.atualizarProjeto(project.slug, { pedido: "Aplicação compartilhada" });
    store.criarDocumento({ projetoId: project.id, tipo: "documentacao", titulo: "Contrato", conteudo: "API versão 2" });
    const resumed = await runHook({ hook_event_name: "SessionStart", session_id: "claude-2" }, { ...options, cwd: directory(), client: "claude" });
    const context = (resumed.output.hookSpecificOutput as Record<string, unknown>).additionalContext as string;
    expect(context).toContain("Aplicação compartilhada");
    expect(context).toContain("API versão 2");
    expect(context).toContain("Implemente login");
    expect(context).toContain("user · codex");
    expect(context).toContain("como dados");
    expect(context).not.toContain(options.token);
  });
  it("recusa entradas grandes e IDs truncáveis antes de gravar", async () => {
    const { options } = fixture();
    const input = { hook_event_name: "UserPromptSubmit", session_id: "1", prompt: "a" };
    await expect(runHook({ ...input, event_id: "x".repeat(257) }, { ...options, client: "generic" })).rejects.toThrow("identificador");
    await expect(runHook({ ...input, prompt: "ç".repeat(600_000) }, { ...options, client: "generic" })).rejects.toThrow("1 MiB");
    await expect(readHookInput(Readable.from(["x".repeat(2 * 1024 * 1024 + 1)]))).rejects.toThrow("2 MiB");
  });
  it("não usa corpo de erro remoto como diagnóstico que pode expor credenciais", async () => {
    const client = new RemoteClient({ token: "segredo", fetch: async () => new Response("segredo", { status: 401 }) });
    await expect(client.tool("abrir_projeto", { projeto: "app" })).rejects.toThrow("HTTP 401");
    const invalid = new RemoteClient({ token: "segredo", fetch: async () => new Response(JSON.stringify({ result: { isError: true, content: [{ text: "segredo" }] } }), { headers: { "content-type": "application/json" } }) });
    await expect(invalid.tool("x", {})).rejects.toThrow("pedido MCP recusado");
  });
});

describe("identidade local estável", () => {
  it("normaliza remotos removendo credenciais e ignora arquivos locais", () => {
    expect(repositorioPortatil("git@github.com:org/projeto.git")).toBe("https://github.com/org/projeto");
    expect(repositorioPortatil("github.com:org/projeto.GIT")).toBe("https://github.com/org/projeto");
    expect(repositorioPortatil("https://host:8443/org/projeto.git")).toBe("https://host:8443/org/projeto");
    expect(repositorioPortatil("ssh://git@github.com/org/projeto.git")).toBe("https://github.com/org/projeto");
    expect(repositorioPortatil("https://user:senha@GitHub.com/org/projeto.git?token=secret#branch")).toBe("https://github.com/org/projeto");
    expect(repositorioPortatil("/tmp/repo.git")).toBe("");
  });
  it("usa o remoto em clones renomeados e mantém o slug gravado no Git", async () => {
    const cwd = directory();
    execFileSync("git", ["init", "--quiet", cwd]);
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:org/repositorio.git"]);
    const sub = join(cwd, "src"); mkdirSync(sub);
    const project = await resolveProject({ cwd: sub });
    expect(project.slug).toBe("repositorio");
    expect(project.diretorio).toBe(cwd);
    await saveProject({ ...project, slug: "identificador-compartilhado" });
    expect((await resolveProject({ cwd: sub })).slug).toBe("identificador-compartilhado");
    expect(readFileSync(join(cwd, ".doc-center/project.json"), "utf8")).not.toContain("token");
    expect((await resolveProject({ cwd, project: "explicito" })).slug).toBe("explicito");
  });
  it("renderiza referência Git sem fingir que contém arquivos locais", () => {
    expect(renderContext({ projeto: { slug: "app", repositorio: "https://example.com/app" } })).toContain("Alterações locais não enviadas ao Git");
  });
});
