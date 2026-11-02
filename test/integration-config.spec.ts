import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configurarIntegracao } from "../src/integrations/config.js";
import { criarPluginOpenCode } from "../src/integrations/opencode-plugin.js";

const temporarios: string[] = [];
async function projeto(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "doc-center-integration-")); temporarios.push(dir); return dir;
}
async function gravar(dir: string, relativo: string, valor: unknown): Promise<void> {
  const arquivo = join(dir, relativo); await mkdir(join(arquivo, ".."), { recursive: true });
  await writeFile(arquivo, typeof valor === "string" ? valor : JSON.stringify(valor));
}
async function json(dir: string, relativo: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, relativo), "utf8")) as Record<string, any>;
}
afterEach(async () => { await Promise.all(temporarios.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("instalação local de integrações", () => {
  it("preserva configurações Claude e hooks de terceiros sem gravar tokens", async () => {
    const dir = await projeto();
    await gravar(dir, ".mcp.json", { outraOpcao: true, mcpServers: { outro: { command: "outro" } } });
    await gravar(dir, ".claude/settings.json", { permissions: { allow: ["Read"] }, hooks: {
      SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: "echo existente" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "verificador" }] }],
    } });
    const comando = ["node", "/caminho com espaço/cli.js"];
    const resultado = await configurarIntegracao({ cliente: "claude", diretorio: dir, comando, projeto: "biblioteca", url: "https://docs.example.com/mcp" });
    expect(resultado.arquivos).toHaveLength(2);
    const mcp = await json(dir, ".mcp.json");
    expect(mcp.outraOpcao).toBe(true);
    expect(mcp.mcpServers.outro).toEqual({ command: "outro" });
    expect(mcp.mcpServers.doc_center.args).toEqual([comando[1], "connect", "--project", "biblioteca", "--url", "https://docs.example.com/mcp"]);
    expect(mcp.mcpServers.doc_center.env.DOC_CENTER_TOKEN).toBe("${DOC_CENTER_TOKEN}");
    expect(mcp.mcpServers.doc_center.env.DOC_CENTER_URL).toBe("${DOC_CENTER_URL:-http://127.0.0.1:7777/mcp}");
    const settings = await json(dir, ".claude/settings.json");
    expect(settings.permissions).toEqual({ allow: ["Read"] });
    expect(settings.hooks.SessionStart[0]).toEqual({ matcher: "resume", hooks: [{ type: "command", command: "echo existente" }] });
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("verificador");
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("'/caminho com espaço/cli.js' hook --client claude");
    const primeira = await Promise.all(resultado.arquivos.map((arquivo) => readFile(arquivo, "utf8")));
    await configurarIntegracao({ cliente: "claude", diretorio: dir, comando, projeto: "biblioteca", url: "https://docs.example.com/mcp" });
    expect(await Promise.all(resultado.arquivos.map((arquivo) => readFile(arquivo, "utf8")))).toEqual(primeira);
  });

  it("mantém TOML de terceiros, inclusive valores multilinha, ao trocar transporte próprio", async () => {
    const dir = await projeto();
    const anterior = `model = "modelo"\ntexto = '''\n[mcp_servers.doc_center]\ncommand = "não é tabela"\n'''\n\n[mcp_servers.outro]\ncommand = "outro"\n\n[mcp_servers.doc_center]\nurl = "https://antigo.example/mcp"\nbearer_token_env_var = "TOKEN_ANTIGO"\nenabled = false\nenv_vars = [\n  "EXISTENTE", # comentário\n]\n\n[[agents]]\ncommand = "não alterar"\n`;
    await gravar(dir, ".codex/config.toml", anterior);
    await gravar(dir, ".codex/hooks.json", { description: "mantida", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo outro" }] }] } });
    const resultado = await configurarIntegracao({ cliente: "codex", diretorio: dir, comando: ["node", "/cli.js"] });
    const toml = await readFile(join(dir, ".codex/config.toml"), "utf8");
    expect(toml).toContain(`texto = '''\n[mcp_servers.doc_center]\ncommand = "não é tabela"\n'''`);
    expect(toml).toContain(`[mcp_servers.outro]\ncommand = "outro"`);
    expect(toml).toContain(`[[agents]]\ncommand = "não alterar"`);
    expect(toml).toContain(`enabled = false`);
    expect(toml).toContain('env_vars = ["EXISTENTE","DOC_CENTER_URL","DOC_CENTER_TOKEN"]');
    expect(toml).toContain('args = ["/cli.js","connect"]');
    expect(toml).not.toContain("TOKEN_ANTIGO");
    expect((await json(dir, ".codex/hooks.json")).description).toBe("mantida");
    expect(resultado.instrucoes.join(" ")).toContain("/hooks");
    await configurarIntegracao({ cliente: "codex", diretorio: dir, comando: ["node", "/cli.js"] });
    expect(await readFile(join(dir, ".codex/config.toml"), "utf8")).toBe(toml);
    expect((await json(dir, ".codex/hooks.json")).hooks.Stop).toHaveLength(2);
  });

  it("preserva JSONC, plugins e MCPs OpenCode; atualiza somente plugin gerenciado", async () => {
    const dir = await projeto();
    await gravar(dir, "opencode.jsonc", `{// comentário\n"plugin":["outro"], "model":"provedor/modelo", "mcp":{"outro":{"type":"local","command":["outra-cli"]},"servers":{"type":"local","command":["servidor-chamado-servers"]}},}`);
    const options = { cliente: "opencode" as const, diretorio: dir, comando: ["node", "/cli.js"] };
    const resultado = await configurarIntegracao(options);
    expect(resultado.arquivos.map((arquivo) => arquivo.slice(dir.length + 1))).toEqual(["opencode.jsonc", ".opencode/plugins/doc-center.js"]);
    const config = await json(dir, "opencode.jsonc");
    expect(config.plugin).toEqual(["outro"]);
    expect(config.model).toBe("provedor/modelo");
    expect(config.mcp.outro.command).toEqual(["outra-cli"]);
    expect(config.mcp.servers).toEqual({ type: "local", command: ["servidor-chamado-servers"] });
    expect(config.mcp.doc_center.type).toBe("local");
    expect(config.mcp.doc_center.environment).not.toHaveProperty("DOC_CENTER_URL");
    expect(config.mcp.doc_center.environment.DOC_CENTER_TOKEN).toBe("{env:DOC_CENTER_TOKEN}");
    const plugin = await readFile(join(dir, ".opencode/plugins/doc-center.js"), "utf8");
    await configurarIntegracao(options);
    expect(await readFile(join(dir, ".opencode/plugins/doc-center.js"), "utf8")).toBe(plugin);
  });

  it.each(["codex", "claude"] as const)("preserva hook parecido de terceiro em %s e reconhece apenas comando gerenciado", async (cliente) => {
    const dir = await projeto(); const arquivo = cliente === "codex" ? ".codex/hooks.json" : ".claude/settings.json";
    const terceiro = { hooks: [{ type: "command", command: `another-agent hook --client ${cliente} --audit`, timeout: 15 }] };
    await gravar(dir, arquivo, { hooks: { Stop: [terceiro] } });
    await configurarIntegracao({ cliente, diretorio: dir, comando: ["node", "/instalacao-antiga/cli.js"] });
    await configurarIntegracao({ cliente, diretorio: dir, comando: ["node", "/instalacao-nova/cli.js"], projeto: "biblioteca" });
    const hooks = (await json(dir, arquivo)).hooks;
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop[0]).toEqual(terceiro);
    for (const evento of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const gerenciados = hooks[evento].flatMap((grupo: any) => grupo.hooks).filter((hook: any) => hook.command.endsWith(` # doc-center-managed:${cliente}`));
      expect(gerenciados).toHaveLength(1);
      expect(gerenciados[0].command).toContain("/instalacao-nova/cli.js");
      expect(gerenciados[0].command).toContain("--project biblioteca");
    }
  });

  it("valida todos os arquivos antes de gravar e recusa substituir código alheio", async () => {
    const dir = await projeto();
    await gravar(dir, ".mcp.json", { mcpServers: { outro: { command: "existente" } } });
    await gravar(dir, ".claude/settings.json", "json inválido");
    const antes = await readFile(join(dir, ".mcp.json"), "utf8");
    await expect(configurarIntegracao({ cliente: "claude", diretorio: dir, comando: ["node", "/cli.js"] })).rejects.toThrow("inválido");
    expect(await readFile(join(dir, ".mcp.json"), "utf8")).toBe(antes);
    await gravar(dir, ".opencode/plugins/doc-center.js", "export const MeuPlugin = () => ({})");
    await expect(configurarIntegracao({ cliente: "opencode", diretorio: dir, comando: ["node", "/cli.js"] })).rejects.toThrow("não é uma integração gerenciada");
    await expect(readFile(join(dir, "opencode.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recusa symlink para configurações externas e TOML com definição inline conflitante", async () => {
    const dir = await projeto(); const externo = await projeto();
    await symlink(externo, join(dir, ".codex"));
    await expect(configurarIntegracao({ cliente: "codex", diretorio: dir, comando: ["node"] })).rejects.toThrow("link simbólico");
    await expect(readFile(join(externo, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    const outro = await projeto();
    await gravar(outro, ".codex/config.toml", '[mcp_servers]\ndoc_center = { command = "outro" }\n');
    await expect(configurarIntegracao({ cliente: "codex", diretorio: outro, comando: ["node"] })).rejects.toThrow("use uma tabela");
  });
});

describe("plugin OpenCode executável", () => {
  it("captura prompts e respostas finais com IDs estáveis e contexto isolado por sessão", async () => {
    const dir = await projeto(); const captura = join(dir, "captura.ndjson");
    const cli = join(dir, "cli com ' aspas $.mjs");
    await writeFile(cli, `import { appendFileSync } from "node:fs";\nlet input="";for await(const chunk of process.stdin)input+=chunk;const event=JSON.parse(input);appendFileSync(${JSON.stringify(captura)},JSON.stringify(event)+"\\n");process.stdout.write(JSON.stringify(event.hook_event_name==="SessionStart"?{hookSpecificOutput:{additionalContext:"contexto:"+event.session_id}}:{}));`);
    const queries: unknown[] = []; const warnings: unknown[] = [];
    const user = { id: "u1", sessionID: "s1", role: "user", time: { created: 1720000000000 }, model: { providerID: "p", modelID: "m" } };
    const assistant = { id: "a1", sessionID: "s1", role: "assistant", time: { created: 1720000001000, completed: 1720000002000 }, providerID: "p", modelID: "m", path: { cwd: dir } };
    const userParts = [{ type: "text", text: "pedido", sessionID: "s1", messageID: "u1" }, { type: "reasoning", text: "privado" }, { type: "text", text: "sintético", synthetic: true }];
    const assistantParts = [{ type: "text", text: "resposta final", sessionID: "s1", messageID: "a1" }, { type: "tool", text: "resultado privado" }, { type: "text", text: "outra sessão", sessionID: "s2" }];
    const client = { app: { log: async (value: unknown) => { warnings.push(value); } }, session: {
      get: async (options: any) => { queries.push(options); return { data: { id: options.path.id, directory: options.path.id === "externa" ? "/outra-pasta" : dir } }; },
      message: async (options: any) => { queries.push(options); return { data: { info: assistant, parts: assistantParts } }; },
      messages: async (options: any) => { queries.push(options); return { data: [{ info: user, parts: userParts }, { info: assistant, parts: assistantParts }] }; },
    } };
    const source = criarPluginOpenCode([process.execPath, cli], ["hook", "--client", "opencode"]);
    const module = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")) as { DocCenterPlugin: (input: unknown) => Promise<any> };
    const hooks = await module.DocCenterPlugin({ client, directory: dir });
    await hooks["chat.message"]({ sessionID: "s1" }, { message: user, parts: userParts });
    await hooks.event({ event: { type: "message.updated", properties: { info: assistant } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "desconhecida" } } });
    await hooks["chat.message"]({ sessionID: "externa" }, { message: { ...user, sessionID: "externa" }, parts: [{ type: "text", text: "não enviar" }] });
    const lines = (await readFile(captura, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ session_id: "s1", event_id: "opencode:user:u1", prompt: "pedido", model: "p/m", role: "user" });
    expect(lines[2]).toMatchObject({ session_id: "s1", event_id: "opencode:assistant:a1", content: "resposta final", role: "assistant" });
    expect(lines[2].timestamp).toBe(new Date(assistant.time.completed).toISOString());
    const system = { system: [] as string[] }; await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, system);
    expect(system.system).toEqual(["contexto:s1"]);
    const other = { system: [] }; await hooks["experimental.chat.system.transform"]({ sessionID: "s2" }, other); await hooks["experimental.chat.system.transform"]({}, other);
    expect(other.system).toEqual([]);
    expect(queries).not.toContainEqual(expect.objectContaining({ path: { id: "desconhecida" } }));
    expect(warnings).toEqual([]); await hooks.dispose();
  });

  it("cita caminhos de hook sem executar expansão de shell", async () => {
    const dir = await projeto();
    await configurarIntegracao({ cliente: "claude", diretorio: dir, comando: [process.execPath, "/pasta/a ' $(nao-executar) `tambem`.js"] });
    const command = (await json(dir, ".claude/settings.json")).hooks.Stop[0].hooks[0].command;
    expect(command).toContain("'\"'\"'"); expect(command).toContain("$(nao-executar)");
    expect(command).toMatch(/hook --client claude # doc-center-managed:claude$/);
  });

  it("tenta carregar contexto após falha offline e avisa sem expor stderr", async () => {
    const dir = await projeto(); const captura = join(dir, "offline.ndjson"); const contador = join(dir, "contador");
    const cli = join(dir, "offline.mjs");
    await writeFile(cli, `import {appendFileSync,readFileSync,writeFileSync} from "node:fs";\nlet input="";for await(const chunk of process.stdin)input+=chunk;const event=JSON.parse(input);appendFileSync(${JSON.stringify(captura)},JSON.stringify(event)+"\\n");let result={};if(event.hook_event_name==="SessionStart"){let count=0;try{count=Number(readFileSync(${JSON.stringify(contador)},"utf8"))}catch{}writeFileSync(${JSON.stringify(contador)},String(count+1));if(!count)process.stderr.write("doc-center: segredo-simulado-nao-repassar\\n");else result={hookSpecificOutput:{additionalContext:"contexto recuperado"}}}process.stdout.write(JSON.stringify(result));`);
    const warnings: unknown[] = [];
    const client = { app: { log: async (value: unknown) => { warnings.push(value); } }, session: {
      get: async (options: any) => ({ data: { id: options.path.id, directory: dir } }),
    } };
    const source = criarPluginOpenCode([process.execPath, cli], ["hook", "--client", "opencode"]);
    const module = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")) as { DocCenterPlugin: (input: unknown) => Promise<any> };
    const hooks = await module.DocCenterPlugin({ client, directory: dir });
    for (const id of ["u1", "u2"]) await hooks["chat.message"]({ sessionID: "s1" }, {
      message: { id, sessionID: "s1", role: "user", time: { created: 1720000000000 } },
      parts: [{ type: "text", text: "prompt repetido" }],
    });
    const lines = (await readFile(captura, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.filter((line) => line.hook_event_name === "SessionStart")).toHaveLength(2);
    expect(lines.filter((line) => line.prompt).map((line) => line.event_id)).toEqual(["opencode:user:u1", "opencode:user:u2"]);
    const output = { system: [] as string[] }; await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, output);
    expect(output.system).toEqual(["contexto recuperado"]);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain("Execute doc-center sync");
    expect(JSON.stringify(warnings)).not.toContain("segredo-simulado");
    await hooks.dispose();
  });

  it("ignora ExperimentalWarning do Node e detecta só prefixo da CLI por linha", async () => {
    const dir = await projeto(); const cli = join(dir, "node-warning.mjs");
    await writeFile(cli, `let input="";for await(const chunk of process.stdin)input+=chunk;const event=JSON.parse(input);process.stderr.write("(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\\n(Use node --trace-warnings to show where the warning was created)\\n");if(event.prompt==="pendente"){process.stderr.write("doc-");await new Promise(resolve=>setTimeout(resolve,10));process.stderr.write("center: mensagem privada não repassar\\n")}process.stdout.write(JSON.stringify(event.hook_event_name==="SessionStart"?{hookSpecificOutput:{additionalContext:"contexto"}}:{}));`);
    const warnings: unknown[] = [];
    const client = { app: { log: async (value: unknown) => { warnings.push(value); } }, session: {
      get: async (options: any) => ({ data: { id: options.path.id, directory: dir } }),
    } };
    const source = criarPluginOpenCode([process.execPath, cli], ["hook", "--client", "opencode"]);
    const module = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")) as { DocCenterPlugin: (input: unknown) => Promise<any> };
    const hooks = await module.DocCenterPlugin({ client, directory: dir });
    await hooks["chat.message"]({ sessionID: "s1" }, { message: { id: "u1", sessionID: "s1", role: "user" }, parts: [{ type: "text", text: "sincronizado" }] });
    expect(warnings).toEqual([]);
    await hooks["chat.message"]({ sessionID: "s1" }, { message: { id: "u2", sessionID: "s1", role: "user" }, parts: [{ type: "text", text: "pendente" }] });
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain("Execute doc-center sync");
    expect(JSON.stringify(warnings)).not.toContain("ExperimentalWarning");
    expect(JSON.stringify(warnings)).not.toContain("mensagem privada");
    await hooks.dispose();
  });
});
