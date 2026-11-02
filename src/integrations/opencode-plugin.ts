/** Plugin local, sem dependências: executa a CLI sem passar por um shell. */
export function criarPluginOpenCode(comando: string[], argumentos: string[]): string {
  return `// doc-center managed OpenCode integration v1
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const command = ${JSON.stringify(comando)};
const args = ${JSON.stringify(argumentos)};

export const DocCenterPlugin = async ({ client, directory }) => {
  const cwd = resolve(directory);
  const sessions = new Map();
  const pending = new Map();
  const warn = async () => {
    try {
      await client.app.log({ body: { service: "doc-center", level: "warn",
        message: "Sincronização doc-center pendente. Execute doc-center sync no projeto." } });
    } catch { /* Nunca registrar conteúdo, token ou stderr da CLI. */ }
  };
  const run = (payload) => new Promise((ok, fail) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd, env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "";
    let hasWarning = false;
    let stderrPrefix = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { fail(new Error("Sincronização doc-center pendente; execute doc-center sync.")); return; }
      try {
        const result = output.trim() ? JSON.parse(output) : {};
        if (hasWarning) void warn().then(() => ok(result)); else ok(result);
      } catch { fail(new Error("Resposta inválida do hook doc-center.")); }
    };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(true); }, 45000);
    child.on("error", () => finish(true));
    child.stdin.on("error", () => finish(true));
    child.stderr.on("data", (chunk) => {
      // Node:sqlite também avisa em stderr; somente avisos da CLI indicam pendência.
      const lines = chunk.toString("utf8").split("\\n");
      for (let i = 0; i < lines.length; i++) {
        stderrPrefix = (stderrPrefix + lines[i]).slice(0, 128);
        if (stderrPrefix.startsWith("doc-center:")) hasWarning = true;
        if (i < lines.length - 1) stderrPrefix = "";
      }
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) { child.kill("SIGTERM"); finish(true); }
    });
    child.on("close", (code) => finish(code !== 0));
    child.stdin.end(JSON.stringify(payload) + "\\n");
  });
  const serial = (id, action) => {
    const previous = pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    pending.set(id, next);
    void next.finally(() => { if (pending.get(id) === next) pending.delete(id); }).catch(() => {});
    return next;
  };
  const stateFor = (id) => {
    let state = sessions.get(id);
    if (!state) { state = { sent: new Set(), context: "", started: false }; sessions.set(id, state); }
    return state;
  };
  const start = async (id, source) => {
    const state = stateFor(id);
    if (state.started) return;
    // Falha ao obter contexto não impede gravar o próximo prompt na outbox.
    try {
      const output = await run({ cwd, session_id: id, event_id: "opencode:session:" + id,
        hook_event_name: "SessionStart", source });
      const context = output.hookSpecificOutput?.additionalContext;
      state.context = typeof context === "string" ? context : "";
      state.started = Boolean(state.context.trim());
    } catch { await warn(); }
  };
  const text = (parts, id, messageID) => (Array.isArray(parts) ? parts : [])
    .filter((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic && !part.ignored &&
      (!part.sessionID || part.sessionID === id) && (!part.messageID || part.messageID === messageID))
    .map((part) => part.text).join("\\n");
  const record = async (id, info, parts) => {
    if (info?.sessionID !== id || typeof info.id !== "string") return;
    if (info.role !== "user" && info.role !== "assistant") return;
    if (info.role === "assistant" && (!info.time?.completed || info.summary)) return;
    if (info.path?.cwd && resolve(info.path.cwd) !== cwd) return;
    const content = text(parts, id, info.id);
    if (!content) return;
    const state = stateFor(id);
    const eventID = "opencode:" + info.role + ":" + info.id;
    if (state.sent.has(eventID)) return;
    const time = info.time?.completed ?? info.time?.created;
    const model = info.model ?? { providerID: info.providerID, modelID: info.modelID };
    const payload = { cwd, session_id: id, event_id: eventID,
      hook_event_name: info.role === "user" ? "UserPromptSubmit" : "Stop", role: info.role,
      ...(info.role === "user" ? { prompt: content } : { content }),
      ...(model.providerID && model.modelID ? { model: model.providerID + "/" + model.modelID } : {}),
      ...(Number.isFinite(time) ? { timestamp: new Date(time).toISOString() } : {}) };
    await run(payload);
    state.sent.add(eventID);
  };
  const verify = async (id) => {
    const response = await client.session.get({ path: { id }, query: { directory: cwd } });
    return response.data?.id === id && typeof response.data.directory === "string" && resolve(response.data.directory) === cwd;
  };
  return {
    "chat.message": async (input, output) => {
      const id = input.sessionID;
      if (typeof id !== "string" || output.message?.sessionID !== id) return;
      await serial(id, async () => {
        if (!await verify(id)) return;
        await start(id, "resume");
        // A CLI grava localmente antes de tentar o upload; falhas são visíveis.
        try { await record(id, output.message, output.parts); } catch (error) { await warn(); throw error; }
      });
    },
    event: async ({ event }) => {
      const properties = event.properties ?? {};
      if (event.type === "session.created") {
        const info = properties.info;
        if (typeof info?.id === "string" && typeof info.directory === "string" && resolve(info.directory) === cwd) {
          await serial(info.id, () => start(info.id, "startup"));
        }
        return;
      }
      const id = properties.sessionID ?? properties.info?.sessionID;
      if (typeof id !== "string" || !sessions.has(id)) return;
      const finished = event.type === "message.updated" && properties.info?.role === "assistant" && properties.info.time?.completed;
      const idle = event.type === "session.idle" || (event.type === "session.status" && properties.status?.type === "idle");
      if (!finished && !idle) return;
      await serial(id, async () => {
        try {
          if (!await verify(id)) return;
          if (finished) {
            const response = await client.session.message({ path: { id, messageID: properties.info.id }, query: { directory: cwd } });
            await record(id, response.data?.info, response.data?.parts);
          } else {
            // Somente a sessão observada, nunca a lista global ou arquivos do cliente.
            const response = await client.session.messages({ path: { id }, query: { directory: cwd } });
            if (Array.isArray(response.data)) for (const message of response.data) await record(id, message.info, message.parts);
          }
        } catch { await warn(); }
      });
    },
    "experimental.chat.system.transform": async (input, output) => {
      // Sem sessionID não há contexto: não misturar sessões no mesmo processo.
      const context = typeof input.sessionID === "string" ? sessions.get(input.sessionID)?.context : "";
      if (context) output.system.push(context);
    },
    dispose: async () => { await Promise.allSettled([...pending.values()]); sessions.clear(); }
  };
};
`;
}
