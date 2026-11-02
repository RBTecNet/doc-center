import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/db/store.js";
import { Journal, type CaptureEvent } from "../src/client/journal.js";
import type { LocalProject } from "../src/client/project.js";
import { RemoteClient } from "../src/client/remote.js";

let server: Store;
let project: LocalProject;
const directories: string[] = [];
const journals = new Set<Journal>();
const MESSAGE = "Prompt original preservado mesmo sem conexão.";
const TOKEN_A = "dct_token_privado_a";
const TOKEN_B = "dct_token_privado_b";

function event(id: string, extra: Partial<CaptureEvent> = {}): CaptureEvent {
  return { evento_id: id, origem: "claude", sessao: "sessao-1", papel: "user", conteudo: MESSAGE, ...extra };
}

function journal(remote: RemoteClient, workspace = project): Journal {
  const instance = new Journal(workspace, remote);
  journals.add(instance);
  return instance;
}

function close(instance: Journal): void { instance.close(); journals.delete(instance); }

/** O transporte é simulado; propriedade, persistência e dedup são do Store real. */
function connection(userId: number, token: string, url = "https://docs.example.com/mcp") {
  const remote = new RemoteClient({ token, url });
  const store = server.forUser(userId);
  let offline = false;
  let failWrite = false;
  let lostAck = false;
  const tool = vi.spyOn(remote, "tool").mockImplementation(async (name, args) => {
    if (offline || (failWrite && name === "registrar_prompt")) throw new Error("sem conexão");
    if (name === "abrir_projeto") return store.garantirProjeto({ slug: String(args.projeto), nome: String(args.nome), repositorio: String(args.repositorio) }) as unknown as Record<string, unknown>;
    if (name !== "registrar_prompt") throw new Error("ferramenta inesperada");
    const projeto = store.projetoPorSlug(String(args.projeto))!;
    const result = store.registrarHistorico(projeto.id, {
      eventoId: String(args.evento_id), origem: String(args.origem), sessao: String(args.sessao),
      papel: args.papel as CaptureEvent["papel"], conteudo: String(args.conteudo),
      ...(args.modelo === undefined ? {} : { modelo: String(args.modelo) }),
      ...(args.maquina === undefined ? {} : { maquina: String(args.maquina) }),
      ...(args.criado_em === undefined ? {} : { criadoEm: String(args.criado_em) }),
      ...(args.metadados === undefined ? {} : { metadados: String(args.metadados) }),
    });
    if (lostAck) { lostAck = false; throw new Error("conexão perdida depois da gravação"); }
    return result as unknown as Record<string, unknown>;
  });
  return { remote, tool, store, offline: (value: boolean) => { offline = value; },
    failWrite: (value: boolean) => { failWrite = value; }, loseAck: () => { lostAck = true; } };
}

function localRows(): { payload: string; sent: number; project_id: number | null; token_hash: string }[] {
  const db = new DatabaseSync(join(project.diretorio, ".doc-center", "local", "history.db"), { readOnly: true });
  try { return db.prepare("SELECT payload,sent,project_id,token_hash FROM events ORDER BY id").all() as unknown as ReturnType<typeof localRows>; }
  finally { db.close(); }
}

beforeEach(() => {
  server = new Store({ file: ":memory:" });
  const directory = mkdtempSync(join(tmpdir(), "doc-center-journal-"));
  directories.push(directory);
  project = { diretorio: directory, slug: "app", nome: "Aplicação", repositorio: "https://example.com/equipe/app" };
});

afterEach(() => {
  for (const instance of journals) instance.close();
  journals.clear();
  server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("outbox durável", () => {
  it("grava antes da rede e recupera integralmente depois de reabrir o processo", async () => {
    const a = connection(101, TOKEN_A);
    a.offline(true);
    const first = journal(a.remote);
    const original = event("original", { conteudo: "ação\n".repeat(30_000), maquina: "notebook", metadados: '{"branch":"main"}' });
    first.enqueue(original);
    expect(a.tool).not.toHaveBeenCalled();
    await expect(first.sync(a.remote, project)).rejects.toThrow("sem conexão");
    expect(first.pending()).toBe(1);
    expect(localRows()).toMatchObject([{ payload: JSON.stringify(original), sent: 0, project_id: null }]);
    close(first);

    a.offline(false);
    const second = journal(a.remote);
    expect(await second.sync(a.remote, project)).toEqual({ enviados: 1, pendentes: 0 });
    const id = a.store.projetoPorSlug(project.slug)!.id;
    expect(a.store.listarHistorico(id)).toMatchObject([{ eventoId: "original", conteudo: original.conteudo, maquina: "notebook", metadados: original.metadados }]);
    expect(localRows()).toMatchObject([{ sent: 1, project_id: id }]);
  });

  it("reenvia depois de perder o ACK sem duplicar o evento no servidor", async () => {
    const a = connection(101, TOKEN_A);
    const outbox = journal(a.remote);
    outbox.enqueue(event("ack-perdido"));
    a.loseAck();
    await expect(outbox.sync(a.remote, project)).rejects.toThrow("depois da gravação");
    const id = a.store.projetoPorSlug(project.slug)!.id;
    expect(a.store.contarHistorico(id)).toBe(1);
    expect(outbox.pending()).toBe(1);
    expect(await outbox.sync(a.remote, project)).toEqual({ enviados: 1, pendentes: 0 });
    expect(a.store.contarHistorico(id)).toBe(1);
    expect(a.tool.mock.calls.filter(([name]) => name === "registrar_prompt")).toHaveLength(2);
  });

  it("deduplica identidade local e mantém prompts iguais com IDs distintos", async () => {
    const a = connection(101, TOKEN_A);
    const outbox = journal(a.remote);
    outbox.enqueue(event("primeiro"));
    outbox.enqueue(event("primeiro"));
    outbox.enqueue(event("segundo"));
    expect(outbox.pending()).toBe(2);
    expect(() => outbox.enqueue(event("primeiro", { conteudo: "Outro pedido" }))).toThrow(/outro conteúdo/);
    expect(outbox.lastUser("claude", "sessao-1")).toBe("segundo");
    expect(await outbox.sync(a.remote, project)).toEqual({ enviados: 2, pendentes: 0 });
    const entries = a.store.listarHistorico(a.store.projetoPorSlug(project.slug)!.id);
    expect(entries.map((entry) => entry.eventoId)).toEqual(["primeiro", "segundo"]);
    expect(entries.map((entry) => entry.conteudo)).toEqual([MESSAGE, MESSAGE]);
  });

  it("marca somente mensagens confirmadas e respeita o limite de sincronização", async () => {
    const a = connection(101, TOKEN_A);
    const outbox = journal(a.remote);
    for (let i = 0; i < 4; i++) outbox.enqueue(event(`e-${i}`));
    expect(await outbox.sync(a.remote, project, 2)).toEqual({ enviados: 2, pendentes: 2 });
    expect(localRows().map((row) => row.sent)).toEqual([1, 1, 0, 0]);
    expect(await outbox.sync(a.remote, project)).toEqual({ enviados: 2, pendentes: 0 });
    expect(a.store.contarHistorico(a.store.projetoPorSlug(project.slug)!.id)).toBe(4);
  });

  it("uma recusa de abrir projeto preserva o evento e sua identidade original", async () => {
    const a = connection(101, TOKEN_A);
    a.store.garantirProjeto({ slug: project.slug, repositorio: "https://example.com/outra/app" });
    const outbox = journal(a.remote);
    outbox.enqueue(event("repo-conflitante"));
    await expect(outbox.sync(a.remote, project)).rejects.toThrow(/outro repositório/);
    expect(outbox.pending()).toBe(1);
    expect(localRows()).toMatchObject([{ sent: 0, project_id: null }]);
    expect(a.tool.mock.calls.filter(([name]) => name === "registrar_prompt")).toEqual([]);
  });

  it("rejeita eventos inválidos antes da gravação para que não bloqueiem a fila", async () => {
    const a = connection(101, TOKEN_A);
    const outbox = journal(a.remote);
    const invalid: Record<string, unknown>[] = [
      { evento_id: " id-com-espaço" }, { evento_id: "x".repeat(257) }, { evento_id: 123 },
      { origem: "claude\t" }, { sessao: "sessao\u0001" }, { sessao: "" },
      { papel: "developer" }, { conteudo: "   " }, { conteudo: "é".repeat(524_289) },
      { modelo: " modelo" }, { maquina: "máquina\u007f" },
      { criado_em: "2026-02-30T12:00:00Z" }, { criado_em: "2026-10-10T24:00:00Z" },
      { criado_em: "10/10/2026" }, { metadados: "{incompleto" },
      { metadados: JSON.stringify({ campo: "é".repeat(8_192) }) },
    ];
    for (const change of invalid) {
      expect(() => outbox.enqueue({ ...event("inválido"), ...change } as CaptureEvent)).toThrow();
    }
    expect(localRows()).toEqual([]);
    expect(outbox.pending()).toBe(0);
    expect(a.tool).not.toHaveBeenCalled();

    outbox.enqueue(event("válido", { criado_em: "2026-10-10T10:00:00-03:00" }));
    expect(await outbox.sync(a.remote, project)).toEqual({ enviados: 1, pendentes: 0 });
    expect(a.store.listarHistorico(a.store.projetoPorSlug(project.slug)!.id)).toMatchObject([
      { eventoId: "válido", criadoEm: "2026-10-10T13:00:00.000Z" },
    ]);
  });
});

describe("troca de conta, token e servidor", () => {
  it("token novo da mesma conta retoma eventos cujo projeto já foi confirmado", async () => {
    const a = connection(101, TOKEN_A);
    a.failWrite(true);
    const old = journal(a.remote);
    old.enqueue(event("rotacionado"));
    await expect(old.sync(a.remote, project)).rejects.toThrow("sem conexão");
    const projectId = a.store.projetoPorSlug(project.slug)!.id;
    expect(localRows()[0]!.project_id).toBe(projectId);
    close(old);

    const rotated = connection(101, "dct_token_rotacionado_a");
    const resumed = journal(rotated.remote);
    expect(await resumed.sync(rotated.remote, project)).toEqual({ enviados: 1, pendentes: 0 });
    expect(rotated.store.projetoPorSlug(project.slug)!.id).toBe(projectId);
    expect(rotated.store.contarHistorico(projectId)).toBe(1);
  });

  it("conta distinta usa seu projeto e não recebe registros pendentes de outra conta", async () => {
    const a = connection(101, TOKEN_A);
    const old = journal(a.remote);
    await old.sync(a.remote, project); // Confirma a identidade do projeto antes da queda da rede.
    const idA = a.store.projetoPorSlug(project.slug)!.id;
    old.enqueue(event("privado-a", { conteudo: "Segredo da conta A" }));
    close(old);

    const b = connection(202, TOKEN_B);
    const switched = journal(b.remote);
    switched.enqueue(event("privado-b", { conteudo: "Pedido da conta B" }));
    expect(await switched.sync(b.remote, project)).toEqual({ enviados: 1, pendentes: 1 });
    const idB = b.store.projetoPorSlug(project.slug)!.id;
    expect(idB).not.toBe(idA);
    expect(b.store.listarHistorico(idB).map((entry) => entry.conteudo)).toEqual(["Pedido da conta B"]);
    expect(b.tool.mock.calls.filter(([name]) => name === "registrar_prompt").map(([, args]) => args.evento_id)).toEqual(["privado-b"]);
    close(switched);

    const resumed = journal(a.remote);
    expect(await resumed.sync(a.remote, project)).toEqual({ enviados: 1, pendentes: 0 });
    expect(a.store.listarHistorico(idA).map((entry) => entry.conteudo)).toEqual(["Segredo da conta A"]);
  });

  it("o alvo desconhecido capturado offline nunca é adotado por outro token", async () => {
    const a = connection(101, TOKEN_A);
    const offline = journal(a.remote);
    offline.enqueue(event("a-sem-alvo", { conteudo: "Mensagem privada antes da primeira conexão" }));
    expect(localRows()[0]!.project_id).toBeNull();
    close(offline);

    const b = connection(202, TOKEN_B);
    const switched = journal(b.remote);
    expect(await switched.sync(b.remote, project)).toEqual({ enviados: 0, pendentes: 1 });
    expect(localRows()[0]!.project_id).toBeNull();
    expect(b.store.contarHistorico(b.store.projetoPorSlug(project.slug)!.id)).toBe(0);
    expect(b.tool.mock.calls.filter(([name]) => name === "registrar_prompt")).toEqual([]);
    close(switched);

    const original = journal(a.remote);
    expect(await original.sync(a.remote, project)).toEqual({ enviados: 1, pendentes: 0 });
    expect(a.store.listarHistorico(a.store.projetoPorSlug(project.slug)!.id)[0]!.eventoId).toBe("a-sem-alvo");
  });

  it("separa filas por endpoint mesmo quando o token e o slug coincidem", async () => {
    const a = connection(101, TOKEN_A, "https://primeiro.example.com/mcp");
    const old = journal(a.remote);
    old.enqueue(event("servidor-original"));
    close(old);
    const other = connection(101, TOKEN_A, "https://outro.example.com/mcp");
    const switched = journal(other.remote);
    expect(await switched.sync(other.remote, project)).toEqual({ enviados: 0, pendentes: 0 });
    expect(other.tool.mock.calls.filter(([name]) => name === "registrar_prompt")).toEqual([]);
    expect(localRows()).toMatchObject([{ sent: 0, project_id: null }]);
  });

  it("recusa trocar o RemoteClient ou o workspace de uma instância já aberta", async () => {
    const a = connection(101, TOKEN_A);
    const outbox = journal(a.remote);
    outbox.enqueue(event("protegido"));
    const b = connection(202, TOKEN_B);
    const endpoint = connection(101, TOKEN_A, "https://outro.example.com/mcp");
    await expect(outbox.sync(b.remote, project)).rejects.toThrow(/conexão original/);
    await expect(outbox.sync(endpoint.remote, project)).rejects.toThrow(/conexão original/);
    await expect(outbox.sync(a.remote, { ...project, slug: "outro" })).rejects.toThrow(/conexão original/);
    await expect(outbox.sync(a.remote, { ...project, diretorio: join(project.diretorio, "outra-pasta") })).rejects.toThrow(/conexão original/);
    expect(a.tool).not.toHaveBeenCalled();
    expect(b.tool).not.toHaveBeenCalled();
    expect(endpoint.tool).not.toHaveBeenCalled();
    expect(localRows()).toMatchObject([{ sent: 0, project_id: null }]);
  });
});

describe("privacidade dos arquivos locais", () => {
  it("limita permissões, ignora a outbox no Git e nunca grava tokens em claro", () => {
    const a = connection(101, TOKEN_A);
    const outbox = journal(a.remote);
    outbox.enqueue(event("privado"));
    const local = join(project.diretorio, ".doc-center", "local");
    expect(statSync(local).mode & 0o777).toBe(0o700);
    expect(statSync(join(local, "history.db")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(local, ".gitignore"), "utf8")).toBe("*\n");
    expect(localRows()[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(localRows())).not.toContain(TOKEN_A);
  });

  it("recusa arquivo DB simbólico sem modificar o destino", () => {
    const local = join(project.diretorio, ".doc-center", "local");
    mkdirSync(local, { recursive: true });
    const target = join(project.diretorio, "arquivo-a-preservar");
    writeFileSync(target, "conteúdo original");
    symlinkSync(target, join(local, "history.db"));
    const a = connection(101, TOKEN_A);
    expect(() => new Journal(project, a.remote)).toThrow(/link simbólico/);
    expect(readFileSync(target, "utf8")).toBe("conteúdo original");
  });

  it("não escreve por uma regra Git simbólica", () => {
    const local = join(project.diretorio, ".doc-center", "local");
    mkdirSync(local, { recursive: true });
    const target = join(project.diretorio, "arquivo-a-preservar");
    writeFileSync(target, "conteúdo original");
    symlinkSync(target, join(local, ".gitignore"));
    const a = connection(101, TOKEN_A);
    expect(() => journal(a.remote)).toThrow(/link simbólico/);
    expect(readFileSync(target, "utf8")).toBe("conteúdo original");
  });

  it.each(["history.db", ".gitignore"])("não cria o destino de um link simbólico pendente em %s", (filename) => {
    const local = join(project.diretorio, ".doc-center", "local");
    mkdirSync(local, { recursive: true });
    const target = join(project.diretorio, "arquivo-externo-que-nao-existe");
    symlinkSync(target, join(local, filename));
    const a = connection(101, TOKEN_A);
    expect(() => journal(a.remote)).toThrow(/link simbólico/);
    expect(existsSync(target)).toBe(false);
  });

  it.each([".doc-center", ".doc-center/local"])("não redireciona a outbox pela pasta simbólica %s", (relative) => {
    const target = join(project.diretorio, "destino-privado");
    mkdirSync(target);
    writeFileSync(join(target, "marcador"), "preservar");
    if (relative.includes("/")) mkdirSync(join(project.diretorio, ".doc-center"));
    symlinkSync(target, join(project.diretorio, relative));
    const a = connection(101, TOKEN_A);
    expect(() => journal(a.remote)).toThrow(/link simbólico/);
    expect(existsSync(join(target, "history.db"))).toBe(false);
    expect(readFileSync(join(target, "marcador"), "utf8")).toBe("preservar");
  });
});
