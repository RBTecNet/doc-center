import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Readable } from "node:stream";
import { Journal, observedTime, type CaptureEvent } from "./journal.js";
import { gitCheckpoint, resolveProject } from "./project.js";
import { RemoteClient, objeto, type RemoteOptions } from "./remote.js";
import { renderContext } from "./context.js";

export interface HookOptions extends RemoteOptions {
  client: string;
  cwd?: string;
  project?: string;
}
const short = (value: unknown, fallback = ""): string => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("identificador do evento inválido (máximo 256 caracteres)");
  return value;
};

export async function readHookInput(input: Readable): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 2 * 1024 * 1024) throw new Error("entrada do hook excede 2 MiB");
    parts.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new Error("entrada JSON do hook inválida"); }
  if (!objeto(parsed)) throw new Error("entrada JSON do hook inválida");
  return parsed;
}

export async function runHook(input: Record<string, unknown>, options: HookOptions): Promise<{ output: Record<string, unknown>; warning?: string }> {
  if (!/^[a-z0-9_-]{1,64}$/.test(options.client)) throw new Error("cliente do hook inválido");
  const eventName = short(input.hook_event_name);
  if (!["SessionStart", "UserPromptSubmit", "Stop"].includes(eventName)) return { output: {} };
  const session = short(input.session_id);
  if (!session) throw new Error("session_id é obrigatório no hook");
  const project = await resolveProject({ ...(options.cwd ? { cwd: options.cwd } : typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
    ...(options.project ? { project: options.project } : {}) });
  const prazo = AbortSignal.timeout(25_000);
  const remote = new RemoteClient({ ...options, timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal ? AbortSignal.any([options.signal, prazo]) : prazo });
  const journal = new Journal(project, remote);
  try {
    if (eventName !== "SessionStart") {
      const content = eventName === "UserPromptSubmit" ? input.prompt ?? input.content : input.last_assistant_message ?? input.content;
      if (typeof content !== "string" || !content.trim()) return { output: {} };
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("mensagem excede o limite de 1 MiB; registre um documento com o conteúdo maior");
      const role = eventName === "UserPromptSubmit" ? "user" : "assistant";
      const turn = short(input.turn_id);
      const anchor = createHash("sha256").update(turn || journal.lastUser(options.client, session)).digest("hex").slice(0, 32);
      const eventId = short(input.event_id) || (role === "user" ? (turn ? `user:${createHash("sha256").update(turn).digest("hex")}` : `user:${randomUUID()}`)
        : `assistant:${anchor}:${createHash("sha256").update(content).digest("hex")}`);
      const event: CaptureEvent = { evento_id: eventId, origem: options.client, sessao: session, papel: role, conteudo: content,
        modelo: short(input.model), maquina: hostname().slice(0, 256), criado_em: new Date().toISOString() };
      const checkpoint = await gitCheckpoint(project.diretorio);
      if (checkpoint) event.metadados = JSON.stringify({ git: checkpoint });
      if (typeof input.timestamp === "string") {
        event.criado_em = observedTime(input.timestamp);
      }
      journal.enqueue(event);
    }
    try {
      const status = await journal.sync(remote, project, 20);
      const warning = status.pendentes ? `${status.pendentes} registros aguardam sincronização; execute doc-center sync com a credencial da conta original` : undefined;
      if (eventName === "SessionStart") {
        const context = await remote.tool("obter_contexto", { projeto: project.slug });
        return { output: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: renderContext(context) } },
          ...(warning ? { warning } : {}) };
      }
      return { output: {}, ...(warning ? { warning } : {}) };
    } catch {
      return { output: {}, warning: `doc-center: sincronização indisponível; ${journal.pending()} registros preservados na outbox local. Execute doc-center sync e verifique URL, conexão e permissão workflow do token.` };
    }
  } finally { journal.close(); }
}

export async function syncProject(options: Omit<HookOptions, "client">): Promise<{ enviados: number; pendentes: number }> {
  const project = await resolveProject(options);
  const remote = new RemoteClient(options);
  const journal = new Journal(project, remote);
  try { return await journal.sync(remote, project); } finally { journal.close(); }
}
