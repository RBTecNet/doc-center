/** Outbox privada: gravamos antes de tentar a rede, reenvio é idempotente. */
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LocalProject } from "./project.js";
import type { RemoteClient } from "./remote.js";

export interface CaptureEvent {
  evento_id: string;
  origem: string;
  sessao: string;
  papel: "user" | "assistant" | "tool" | "system";
  conteudo: string;
  modelo?: string;
  maquina?: string;
  criado_em?: string;
  metadados?: string;
}

interface Row { id: number; payload: string; project_id: number | null; token_hash: string; sent: number }
function semLink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error("a outbox não pode usar um link simbólico"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function observedTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("timestamp deve ser ISO 8601 com fuso horário");
  const date = new Date(value);
  const day = value.slice(0, 10);
  const [year, month, number] = day.split("-").map(Number);
  const calendar = new Date(day + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== number || Number(value.slice(11, 13)) > 23) throw new Error("timestamp do evento inválido");
  return date.toISOString();
}
export class Journal {
  private readonly db: DatabaseSync;
  private readonly endpoint: string;
  private readonly slug: string;
  private readonly fingerprint: string;
  private readonly directory: string;
  constructor(project: LocalProject, remote: RemoteClient) {
    const base = join(project.diretorio, ".doc-center");
    mkdirSync(base, { recursive: true });
    if (lstatSync(base).isSymbolicLink()) throw new Error("a pasta do doc-center não pode ser um link simbólico");
    const dir = join(project.diretorio, ".doc-center", "local");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error("a pasta local do doc-center não pode ser um link simbólico");
    chmodSync(dir, 0o700);
    const arquivo = join(dir, "history.db");
    semLink(arquivo);
    // Uma regra dentro da própria pasta cobre também os arquivos WAL/SHM.
    const ignore = join(dir, ".gitignore");
    semLink(ignore);
    writeFileSync(ignore, "*\n", { mode: 0o600 });
    this.db = new DatabaseSync(arquivo);
    chmodSync(arquivo, 0o600);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS targets (
        endpoint TEXT NOT NULL, slug TEXT NOT NULL, token_hash TEXT NOT NULL, project_id INTEGER NOT NULL,
        PRIMARY KEY (endpoint, slug, token_hash)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, slug TEXT NOT NULL,
        token_hash TEXT NOT NULL, project_id INTEGER, origin TEXT NOT NULL, session TEXT NOT NULL,
        event_id TEXT NOT NULL, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
        UNIQUE (endpoint, slug, token_hash, origin, session, event_id)
      );`);
    this.endpoint = remote.endpoint.href;
    this.slug = project.slug;
    this.directory = project.diretorio;
    this.fingerprint = createHash("sha256").update(remote.token).digest("hex");
  }
  close(): void { this.db.close(); }
  enqueue(event: CaptureEvent): void {
    for (const key of ["evento_id", "origem", "sessao"] as const) {
      if (typeof event[key] !== "string" || !event[key] || event[key].length > 256 || event[key].trim() !== event[key] ||
        /[\x00-\x1f\x7f]/.test(event[key])) throw new Error("identificador do evento inválido (máximo 256 caracteres)");
    }
    if (!["user", "assistant", "tool", "system"].includes(event.papel) || typeof event.conteudo !== "string" || !event.conteudo.trim() || Buffer.byteLength(event.conteudo) > 1024 * 1024) {
      throw new Error("mensagem excede o limite ou tem papel/conteúdo inválido");
    }
    for (const value of [event.modelo, event.maquina]) if (value !== undefined && (typeof value !== "string" || value.length > 256 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value))) throw new Error("identificador do modelo ou máquina inválido");
    if (event.criado_em !== undefined) observedTime(event.criado_em);
    if (event.metadados !== undefined) {
      if (Buffer.byteLength(event.metadados) > 16_384) throw new Error("metadados do evento excedem 16 KiB");
      try { if (event.metadados.trim()) JSON.parse(event.metadados); } catch { throw new Error("metadados do evento devem ser JSON válido"); }
    }
    const target = this.db.prepare("SELECT project_id FROM targets WHERE endpoint=? AND slug=? AND token_hash=?")
      .get(this.endpoint, this.slug, this.fingerprint) as { project_id: number } | undefined;
    this.db.prepare(`INSERT OR IGNORE INTO events (endpoint,slug,token_hash,project_id,origin,session,event_id,payload)
      VALUES (?,?,?,?,?,?,?,?)`).run(this.endpoint, this.slug, this.fingerprint, target?.project_id ?? null,
      event.origem, event.sessao, event.evento_id, JSON.stringify(event));
    const stored = this.db.prepare("SELECT payload FROM events WHERE endpoint=? AND slug=? AND token_hash=? AND origin=? AND session=? AND event_id=?")
      .get(this.endpoint, this.slug, this.fingerprint, event.origem, event.sessao, event.evento_id) as { payload: string };
    const original = JSON.parse(stored.payload) as CaptureEvent;
    if (original.conteudo !== event.conteudo || original.papel !== event.papel) {
      throw new Error("o identificador do evento já foi usado com outro conteúdo");
    }
  }
  lastUser(origin: string, session: string): string {
    const row = this.db.prepare(`SELECT event_id FROM events WHERE endpoint=? AND slug=? AND token_hash=? AND origin=? AND session=?
      AND json_extract(payload,'$.papel')='user' ORDER BY id DESC LIMIT 1`)
      .get(this.endpoint, this.slug, this.fingerprint, origin, session) as { event_id: string } | undefined;
    return row?.event_id ?? "sem-prompt";
  }
  pending(): number {
    return (this.db.prepare("SELECT count(*) AS total FROM events WHERE endpoint=? AND slug=? AND sent=0")
      .get(this.endpoint, this.slug) as { total: number }).total;
  }
  async sync(remote: RemoteClient, project: LocalProject, limite = Infinity): Promise<{ enviados: number; pendentes: number }> {
    if (remote.endpoint.href !== this.endpoint || createHash("sha256").update(remote.token).digest("hex") !== this.fingerprint ||
      project.slug !== this.slug || project.diretorio !== this.directory) {
      throw new Error("a outbox deve ser sincronizada pela conexão original");
    }
    const opened = await remote.tool("abrir_projeto", { projeto: project.slug, nome: project.nome, repositorio: project.repositorio });
    const remoteProject = opened.projeto as Record<string, unknown> | undefined;
    if (!remoteProject || !Number.isSafeInteger(remoteProject.id) || (remoteProject.id as number) <= 0) throw new Error("resposta MCP de projeto inválida");
    const id = remoteProject.id as number;
    this.db.prepare(`INSERT INTO targets (endpoint,slug,token_hash,project_id) VALUES (?,?,?,?)
      ON CONFLICT(endpoint,slug,token_hash) DO UPDATE SET project_id=excluded.project_id`).run(this.endpoint, this.slug, this.fingerprint, id);
    // Nunca reenviar o histórico de uma conta para outra ao trocar o token.
    this.db.prepare("UPDATE events SET project_id=? WHERE endpoint=? AND slug=? AND token_hash=? AND project_id IS NULL")
      .run(id, this.endpoint, this.slug, this.fingerprint);
    let enviados = 0;
    while (enviados < limite) {
      const row = this.db.prepare(`SELECT id,payload,project_id,token_hash,sent FROM events WHERE endpoint=? AND slug=? AND sent=0
        AND project_id=? ORDER BY id LIMIT 1`).get(this.endpoint, this.slug, id) as Row | undefined;
      if (!row) break;
      await remote.tool("registrar_prompt", { projeto: project.slug, ...JSON.parse(row.payload) as CaptureEvent });
      this.db.prepare("UPDATE events SET sent=1 WHERE id=?").run(row.id);
      enviados++;
    }
    return { enviados, pendentes: this.pending() };
  }
}
