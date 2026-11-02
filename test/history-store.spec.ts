import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErroDeUso, Store, type RegistroHistorico } from "../src/db/store.js";

let root: Store;
let ana: Store;
let bruno: Store;
let agora: number;
const pastas: string[] = [];
const bancos: Store[] = [];

const evento = (eventoId: string, extra: Partial<RegistroHistorico> = {}): RegistroHistorico => ({
  eventoId, origem: "codex", sessao: "sessao-1", papel: "user", conteudo: "Crie a tela de login.", ...extra,
});

beforeEach(() => {
  agora = Date.parse("2026-10-10T12:00:00Z");
  root = new Store({ file: ":memory:", now: () => new Date(agora).toISOString() });
  ana = root.forUser(101);
  bruno = root.forUser(202);
});

afterEach(() => {
  root.close();
  for (const banco of bancos.splice(0)) banco.close();
  for (const pasta of pastas.splice(0)) rmSync(pasta, { recursive: true, force: true });
});

describe("vincular projetos automaticamente", () => {
  it("cria uma vez, sanitiza o Git remoto e conserva o projeto já utilizado", () => {
    const primeiro = ana.garantirProjeto({ slug: "doc-center", nome: "Doc Center", repositorio: "https://alice:secret@example.com/equipe/doc-center.git?token=secret#branch" });
    expect(primeiro.criado).toBe(true);
    expect(primeiro.projeto.repositorio).toBe("https://example.com/equipe/doc-center");
    ana.atualizarProjeto("doc-center", { nome: "Nome escolhido", descricao: "Descrição salva", pedido: "Pedido já aprovado" });
    const documento = ana.criarDocumento({ projetoId: primeiro.projeto.id, tipo: "documentacao", titulo: "Levantamento", conteudo: "já existe" });
    const antes = ana.projetoPorSlug("doc-center")!;
    agora += 60_000;

    const repetido = ana.garantirProjeto({ slug: "doc-center", nome: "Outro nome", repositorio: "git@example.com:equipe/doc-center.git" });
    expect(repetido).toEqual({ projeto: antes, criado: false });
    expect(ana.garantirProjeto({ slug: "doc-center" }).projeto).toEqual(antes);
    expect(ana.garantirProjeto({ slug: "doc-center", repositorio: "" }).projeto).toEqual(antes);
    expect(ana.documentoPorId(documento.id)?.conteudo).toBe("já existe");
    expect(ana.listarProjetos()).toHaveLength(1);
    expect(bruno.garantirProjeto({ slug: "doc-center", repositorio: "https://example.com/outra/conta" }).criado).toBe(true);
    expect(bruno.projetoPorSlug("doc-center")?.id).not.toBe(primeiro.projeto.id);
  });

  it("preenche o remoto ausente uma vez e recusa colisão com outro repositório", () => {
    const existente = ana.criarProjeto({ nome: "Legado", pedido: "preservar" });
    expect(existente.repositorio).toBe("");
    const vinculado = ana.garantirProjeto({ slug: "legado", repositorio: "ssh://git@example.com/equipe/legado.git" });
    expect(vinculado.criado).toBe(false);
    expect(vinculado.projeto).toMatchObject({ id: existente.id, nome: "Legado", pedido: "preservar", repositorio: "https://example.com/equipe/legado" });
    expect(() => ana.garantirProjeto({ slug: "legado", repositorio: "https://example.com/outra/legado" })).toThrow(/DOC_CENTER_PROJECT/);
    expect(ana.projetoPorSlug("legado")).toEqual(vinculado.projeto);
  });

  it("aceita somente slugs canônicos e o projeto vinculado ao token", () => {
    const token = root.forUser(101, "alvo");
    expect(token.garantirProjeto({ slug: "alvo" }).criado).toBe(true);
    expect(token.garantirProjeto({ slug: "alvo" }).criado).toBe(false);
    expect(() => token.garantirProjeto({ slug: "outro" })).toThrow(ErroDeUso);
    for (const slug of ["", "Doc Center", "../outro", "Álvo", "a".repeat(61)]) {
      expect(() => ana.garantirProjeto({ slug })).toThrow(ErroDeUso);
    }
    for (const repositorio of ["/home/pessoa/projeto", "file:///tmp/projeto", "C:/Projeto", "https://example.com/", "https://example.com/a\nsegredo"]) {
      expect(() => ana.garantirProjeto({ slug: "remoto-invalido", repositorio })).toThrow(ErroDeUso);
    }
    expect(ana.projetoPorSlug("remoto-invalido")).toBeNull();
  });
});

describe("histórico imutável e idempotente", () => {
  it("retransmite o mesmo evento sem duplicar e conserva prompts iguais enviados outra vez", () => {
    const projeto = ana.garantirProjeto({ slug: "app" }).projeto;
    const original = ana.registrarHistorico(projeto.id, evento("mensagem-1"));
    agora += 100_000;
    const retry = ana.registrarHistorico(projeto.id, evento("mensagem-1"));
    expect(original.criado).toBe(true);
    expect(retry).toEqual({ entrada: original.entrada, criado: false });
    const repetido = ana.registrarHistorico(projeto.id, evento("mensagem-2"));
    expect(repetido.criado).toBe(true);
    expect(repetido.entrada.id).not.toBe(original.entrada.id);
    expect(ana.listarHistorico(projeto.id).map((entrada) => entrada.conteudo)).toEqual(["Crie a tela de login.", "Crie a tela de login."]);
    expect(ana.contarHistorico(projeto.id)).toBe(2);
    expect(() => root.banco.prepare("UPDATE historico SET conteudo = 'reescrito' WHERE id = ?").run(original.entrada.id)).toThrow(/imutável/);
  });

  it("a mesma identidade com conteúdo ou procedência divergente não altera o original", () => {
    const projeto = ana.garantirProjeto({ slug: "app" }).projeto;
    const completo = evento("id", { modelo: "gpt-6", maquina: "notebook", criadoEm: "2026-10-10T09:00:00-03:00", metadados: '{"branch":"main","commit":"abc"}' });
    const original = ana.registrarHistorico(projeto.id, completo).entrada;
    expect(original.criadoEm).toBe("2026-10-10T12:00:00.000Z");
    expect(ana.registrarHistorico(projeto.id, { ...completo, criadoEm: "2026-10-10T12:00:00Z" }).criado).toBe(false);
    for (const extra of [
      { conteudo: "Outro pedido" }, { papel: "assistant" as const }, { modelo: "outro-modelo" },
      { maquina: "outra" }, { criadoEm: "2026-10-10T12:00:01Z" }, { metadados: '{"branch":"outra"}' },
    ]) {
      expect(() => ana.registrarHistorico(projeto.id, { ...completo, ...extra })).toThrow(/dados diferentes/);
    }
    expect(ana.entradaDoHistorico(projeto.id, original.id)).toEqual(original);
    expect(ana.contarHistorico(projeto.id)).toBe(1);
  });

  it("identidades de sessões, CLIs e projetos distintos permanecem distintas", () => {
    const primeiro = ana.garantirProjeto({ slug: "primeiro" }).projeto;
    const segundo = ana.garantirProjeto({ slug: "segundo" }).projeto;
    const comum = evento("id");
    ana.registrarHistorico(primeiro.id, comum);
    ana.registrarHistorico(primeiro.id, { ...comum, sessao: "outra-sessao" });
    ana.registrarHistorico(primeiro.id, { ...comum, origem: "claude" });
    ana.registrarHistorico(segundo.id, comum);
    expect(ana.contarHistorico(primeiro.id)).toBe(3);
    expect(ana.contarHistorico(segundo.id)).toBe(1);
  });

  it("preserva mensagens completas grandes e valida limites e dados de origem", () => {
    const projeto = ana.garantirProjeto({ slug: "app" }).projeto;
    const grande = "ação\n".repeat(30_000);
    const criado = ana.registrarHistorico(projeto.id, evento("grande", { conteudo: grande, metadados: '{"cli":"custom","branch":"main"}' })).entrada;
    expect(ana.entradaDoHistorico(projeto.id, criado.id)?.conteudo).toBe(grande);
    expect(ana.entradaDoHistorico(projeto.id, criado.id)?.metadados).toBe('{"cli":"custom","branch":"main"}');
    const invalidos: Record<string, unknown>[] = [
      { eventoId: "" }, { eventoId: "a".repeat(257) }, { origem: " codex" }, { sessao: "sessao\n2" },
      { papel: "function" }, { conteudo: "💬".repeat(300_000) }, { conteudo: null }, { modelo: null },
      { maquina: "m\u0000x" }, { criadoEm: "hoje" }, { criadoEm: "2026-02-30T12:00:00Z" }, { criadoEm: "2026-10-10T24:00:00Z" },
      { metadados: "{" }, { metadados: JSON.stringify({ x: "a".repeat(17_000) }) }, { metadados: null },
    ];
    for (const extra of invalidos) {
      expect(() => ana.registrarHistorico(projeto.id, { ...evento("invalido"), ...extra } as RegistroHistorico)).toThrow(ErroDeUso);
    }
    expect(ana.contarHistorico(projeto.id)).toBe(1);
  });

  it("preserva NUL e UTF-8 em todas as leituras e retransmissões do evento", () => {
    const projeto = ana.garantirProjeto({ slug: "app" }).projeto;
    const conteudo = "início\u0000meio😀\u0000fim";
    const registro = evento("com-nul", { conteudo });
    const salvo = ana.registrarHistorico(projeto.id, registro).entrada;
    expect(salvo.conteudo).toBe(conteudo);
    expect(ana.registrarHistorico(projeto.id, registro)).toEqual({ criado: false, entrada: salvo });
    expect(() => ana.registrarHistorico(projeto.id, { ...registro, conteudo: "início" })).toThrow(/dados diferentes/);
    expect(ana.entradaDoHistorico(projeto.id, salvo.id)).toEqual(salvo);
    expect(ana.listarHistorico(projeto.id)).toEqual([salvo]);
    expect(ana.ultimasDoHistorico(projeto.id)).toEqual([salvo]);
    expect(ana.contarHistorico(projeto.id)).toBe(1);
    expect(root.banco.prepare("SELECT hex(conteudo) AS bytes FROM historico WHERE id = ?").get(salvo.id))
      .toEqual({ bytes: Buffer.from(conteudo, "utf8").toString("hex").toUpperCase() });
  });

  it("recupera sem migração o conteúdo TEXT com NUL gravado pela versão anterior", () => {
    const projeto = ana.garantirProjeto({ slug: "app" }).projeto;
    const conteudo = "antes\u0000texto que já estava armazenado\u0000💬";
    root.banco.prepare(`INSERT INTO historico
      (projeto_id, evento_id, origem, sessao, papel, conteudo, modelo, maquina, criado_em, registrado_em, metadados)
      VALUES (?, 'text-antigo', 'codex', 'sessao-1', 'user', ?, '', '', ?, ?, '')`)
      .run(projeto.id, conteudo, "2026-10-10T12:00:00.000Z", "2026-10-10T12:00:00.000Z");
    const leitura = ana.listarHistorico(projeto.id)[0]!;
    expect(leitura.conteudo).toBe(conteudo);
    expect(ana.registrarHistorico(projeto.id, evento("text-antigo", { conteudo })))
      .toEqual({ criado: false, entrada: leitura });
    expect(ana.contarHistorico(projeto.id)).toBe(1);
  });
});

describe("paginação e contexto retomável", () => {
  it("usa o último ID real como cursor entre CLIs e preserva ordem e filtro", () => {
    const projeto = ana.garantirProjeto({ slug: "app" }).projeto;
    const outro = bruno.garantirProjeto({ slug: "app" }).projeto;
    const a = ana.registrarHistorico(projeto.id, evento("a")).entrada;
    bruno.registrarHistorico(outro.id, evento("fora"));
    const b = ana.registrarHistorico(projeto.id, evento("b", { origem: "claude", papel: "assistant", conteudo: "Pronto." })).entrada;
    const c = ana.registrarHistorico(projeto.id, evento("c", { origem: "opencode", papel: "tool", conteudo: "Testes passaram." })).entrada;
    const pagina = ana.listarHistorico(projeto.id, { limite: 2 });
    expect(pagina.map((entrada) => entrada.id)).toEqual([a.id, b.id]);
    const d = ana.registrarHistorico(projeto.id, evento("d", { origem: "agy", papel: "system" })).entrada;
    expect(ana.listarHistorico(projeto.id, { depois: pagina.at(-1)!.id }).map((entrada) => entrada.id)).toEqual([c.id, d.id]);
    expect(ana.listarHistorico(projeto.id, { papel: "user" }).map((entrada) => entrada.id)).toEqual([a.id]);
    expect(ana.ultimasDoHistorico(projeto.id, 2).map((entrada) => entrada.id)).toEqual([c.id, d.id]);
    expect(ana.entradaDoHistorico(projeto.id, b.id)?.origem).toBe("claude");
    expect(ana.entradaDoHistorico(projeto.id, 999999)).toBeNull();
  });

  it("limita número de eventos e usa a quantidade real recebida nas páginas grandes", () => {
    const projeto = ana.garantirProjeto({ slug: "app" }).projeto;
    for (let i = 0; i < 510; i++) ana.registrarHistorico(projeto.id, evento(`e-${i}`, { conteudo: String(i) }));
    expect(ana.listarHistorico(projeto.id)).toHaveLength(100);
    expect(ana.listarHistorico(projeto.id, { limite: 999 })).toHaveLength(500);
    expect(ana.ultimasDoHistorico(projeto.id)).toHaveLength(20);
    expect(ana.ultimasDoHistorico(projeto.id, 999)).toHaveLength(500);
    for (const options of [{ depois: -1 }, { depois: 1.1 }, { limite: 0 }, { limite: 1.1 }, { papel: "inventado" }]) {
      expect(() => ana.listarHistorico(projeto.id, options)).toThrow(ErroDeUso);
    }
  });

  it("página de mensagens grandes cabe no budget sem cortar nenhum conteúdo", () => {
    const projeto = ana.garantirProjeto({ slug: "app" }).projeto;
    const conteudo = "x".repeat(1024 * 1024);
    const entradas = Array.from({ length: 6 }, (_, indice) => ana.registrarHistorico(projeto.id, evento(`grande-${indice}`, { conteudo })).entrada);
    const pagina = ana.listarHistorico(projeto.id, { limite: 500 });
    expect(pagina.length).toBeGreaterThan(0);
    expect(pagina.length).toBeLessThan(4);
    expect(Buffer.byteLength(JSON.stringify(pagina))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(pagina.every((entrada) => entrada.conteudo === conteudo)).toBe(true);
    const restante = ana.listarHistorico(projeto.id, { depois: pagina.at(-1)!.id });
    expect([...pagina, ...restante].map((entrada) => entrada.id)).toEqual(entradas.map((entrada) => entrada.id));
    const ultimas = ana.ultimasDoHistorico(projeto.id, 20);
    expect(ultimas.map((entrada) => entrada.id)).toEqual(entradas.slice(-ultimas.length).map((entrada) => entrada.id));
    expect(ultimas.every((entrada) => entrada.conteudo === conteudo)).toBe(true);
  });
});

describe("propriedade e persistência do histórico", () => {
  it("protege contas e projetos vinculados inclusive em consultas diretas por ID", () => {
    const a = ana.garantirProjeto({ slug: "app" }).projeto;
    const b = bruno.garantirProjeto({ slug: "app" }).projeto;
    const outro = ana.garantirProjeto({ slug: "outro" }).projeto;
    const ea = ana.registrarHistorico(a.id, evento("a")).entrada;
    const eb = bruno.registrarHistorico(b.id, evento("b")).entrada;
    const eo = ana.registrarHistorico(outro.id, evento("o")).entrada;
    const token = root.forUser(101, "app");
    expect(token.registrarHistorico(a.id, evento("permitido")).criado).toBe(true);
    expect(token.entradaDoHistorico(a.id, ea.id)).toEqual(ea);
    expect(ana.entradaDoHistorico(a.id, eb.id)).toBeNull();
    expect(ana.entradaDoHistorico(b.id, eb.id)).toBeNull();
    expect(token.entradaDoHistorico(outro.id, eo.id)).toBeNull();
    for (const [store, projetoId] of [[ana, b.id], [token, b.id], [token, outro.id], [root, a.id]] as const) {
      expect(store.listarHistorico(projetoId)).toEqual([]);
      expect(store.ultimasDoHistorico(projetoId)).toEqual([]);
      expect(store.contarHistorico(projetoId)).toBe(0);
      expect(() => store.registrarHistorico(projetoId, evento("invadir"))).toThrow(ErroDeUso);
    }
    ana.removerProjeto("app");
    expect(ana.entradaDoHistorico(a.id, ea.id)).toBeNull();
    expect(bruno.entradaDoHistorico(b.id, eb.id)).toEqual(eb);
    expect(root.banco.prepare("SELECT 1 FROM historico WHERE projeto_id = ?").get(a.id)).toBeUndefined();
  });

  it("reabre o banco preservando o remoto, eventos e idempotência em outra máquina", () => {
    const pasta = mkdtempSync(join(tmpdir(), "doc-center-history-"));
    pastas.push(pasta);
    const file = join(pasta, "persistente.db");
    const primeiro = new Store({ file });
    const conta = primeiro.forUser(101);
    const projeto = conta.garantirProjeto({ slug: "app", repositorio: "https://example.com/equipe/app" }).projeto;
    const registro = evento("original", { origem: "claude", maquina: "maquina-original", conteudo: "preservar\u0000o restante💬", metadados: '{"branch":"main"}' });
    const salvo = conta.registrarHistorico(projeto.id, registro).entrada;
    primeiro.close();

    const segundo = new Store({ file });
    bancos.push(segundo);
    const retomado = segundo.forUser(101);
    expect(retomado.garantirProjeto({ slug: "app" })).toEqual({ criado: false, projeto });
    expect(retomado.registrarHistorico(projeto.id, registro)).toEqual({ criado: false, entrada: salvo });
    expect(retomado.ultimasDoHistorico(projeto.id)).toEqual([salvo]);
    expect(segundo.forUser(202).contarHistorico(projeto.id)).toBe(0);
    expect(segundo.banco.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migra projetos locais antigos sem perder pedido, documentos e seleções", () => {
    const pasta = mkdtempSync(join(tmpdir(), "doc-center-history-migration-"));
    pastas.push(pasta);
    const file = join(pasta, "antigo.db");
    const antigo = new DatabaseSync(file);
    antigo.exec(`
      CREATE TABLE projetos (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, nome TEXT NOT NULL,
        descricao TEXT NOT NULL DEFAULT '', pedido TEXT NOT NULL DEFAULT '', criado_em TEXT NOT NULL, alterado_em TEXT NOT NULL);
      CREATE TABLE documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, projeto_id INTEGER REFERENCES projetos(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL, slug TEXT NOT NULL, titulo TEXT NOT NULL, conteudo TEXT NOT NULL, criado_em TEXT NOT NULL, alterado_em TEXT NOT NULL);
      CREATE TABLE selecoes (projeto_id INTEGER NOT NULL REFERENCES projetos(id) ON DELETE CASCADE,
        documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE, criado_em TEXT NOT NULL, PRIMARY KEY(projeto_id,documento_id));
      INSERT INTO projetos VALUES (7,'legado','Legado','descrição','pedido salvo','antes','depois');
      INSERT INTO documentos VALUES (11,NULL,'skill','design','Design','guia','antes','depois');
      INSERT INTO selecoes VALUES (7,11,'antes');
    `);
    antigo.close();
    const migrado = new Store({ file });
    bancos.push(migrado);
    expect(migrado.projetoPorSlug("legado")).toMatchObject({ id: 7, pedido: "pedido salvo", repositorio: "" });
    expect(migrado.idsSelecionados(7)).toEqual([11]);
    const historico = migrado.registrarHistorico(7, evento("legado")).entrada;
    expect(migrado.adotarLegado(101)).toBe(true);
    const adotado = migrado.forUser(101);
    expect(adotado.garantirProjeto({ slug: "legado" }).projeto).toMatchObject({ id: 7, pedido: "pedido salvo" });
    expect(adotado.listarDoProjeto(7).map((documento) => documento.id)).toEqual([11]);
    expect(adotado.entradaDoHistorico(7, historico.id)).toEqual(historico);
    expect(migrado.entradaDoHistorico(7, historico.id)).toBeNull();
    expect(migrado.banco.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
