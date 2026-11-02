import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db/store.js";
import { AuthStore, DURACAO_SESSAO } from "../src/auth.js";
import { createApp, listen } from "../src/http.js";

let store: Store;
let server: Server;
let auth: AuthStore;
let base: string;
let agora: number;
const SENHA = "uma-senha-longa-de-teste";

async function pedir(caminho: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${caminho}`, {
    method, redirect: "manual", headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function conta(email: string) {
  const resposta = await pedir("/api/auth/register", "POST", { nome: email, email, senha: SENHA });
  expect(resposta.status).toBe(201);
  const { usuario } = await resposta.json() as { usuario: { id: number; nome: string; email: string } };
  const cookie = resposta.headers.get("set-cookie")!.split(";")[0]!;
  return { usuario, cookie, store: store.forUser(usuario.id), headers: { cookie } };
}
async function token(cookie: string, extras: Record<string, unknown> = {}) {
  const resposta = await pedir("/api/tokens", "POST", { nome: "Workflow", ...extras }, { cookie });
  expect(resposta.status).toBe(201);
  return await resposta.json() as { token: string; credencial: { id: number } };
}
async function rpc(segredo: string, method: string, params?: Record<string, unknown>) {
  const resposta = await pedir("/mcp", "POST", { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, { authorization: `Bearer ${segredo}` });
  return { status: resposta.status, dado: await resposta.json() as any };
}

beforeEach(async () => {
  store = new Store({ file: ":memory:" });
  agora = Date.now();
  auth = new AuthStore(store, () => agora);
  server = createApp({ store, auth });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

describe("autenticação obrigatória", () => {
  it("não expõe a base local antes do primeiro cadastro", async () => {
    store.criarProjeto({ nome: "Segredo legado", pedido: "não vazar" });
    const pagina = await pedir("/");
    expect(pagina.status).toBe(303);
    expect(pagina.headers.get("location")).toBe("/cadastro");
    expect((await pedir("/api/projetos")).status).toBe(401);
    const mcp = await pedir("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("valida senha, normaliza email, entra e encerra a sessão", async () => {
    expect((await pedir("/api/auth/register", "POST", { nome: "A", email: "a@example.com", senha: "curta" })).status).toBe(400);
    const a = await conta("Pessoa@Example.com");
    expect(a.usuario.email).toBe("pessoa@example.com");
    const falha = await pedir("/api/auth/login", "POST", { email: a.usuario.email, senha: "incorreta" });
    expect(falha.status).toBe(401);
    const login = await pedir("/api/auth/login", "POST", { email: "PESSOA@EXAMPLE.COM", senha: SENHA });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax");
    const nova = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(nova).not.toBe(a.cookie);
    expect((await pedir("/api/auth/logout", "POST", undefined, { cookie: nova })).status).toBe(204);
    expect((await pedir("/api/auth/me", "GET", undefined, { cookie: nova })).status).toBe(401);
    const banco = store.banco.prepare("SELECT senha_hash FROM usuarios").get() as { senha_hash: string };
    expect(banco.senha_hash).toMatch(/^scrypt:/);
    expect(banco.senha_hash).not.toContain(SENHA);
  });

  it("permite primeira configuração com cadastro fechado e recusa contas seguintes", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createApp({ store, auth, registration: "closed", publicUrl: "https://docs.example.com" });
    base = `http://127.0.0.1:${await listen(server, 0)}`;
    const primeira = await pedir("/api/auth/register", "POST", { nome: "A", email: "a@example.com", senha: SENHA });
    expect(primeira.status).toBe(201);
    expect(primeira.headers.get("set-cookie")).toContain("; Secure");
    expect((await pedir("/api/auth/register", "POST", { nome: "B", email: "b@example.com", senha: SENHA })).status).toBe(400);
    expect((await pedir("/cadastro")).status).toBe(403);
  });

  it("recusa origem maliciosa, DNS rebinding e objetos inválidos", async () => {
    expect((await pedir("/api/auth/register", "POST", {}, { origin: "https://malicioso.example" })).status).toBe(403);
    expect((await pedir("/api/auth/login", "POST", {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    // fetch normaliza Host; usa HTTP nativo para simular DNS rebinding de fato.
    const hostMalicioso = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/login`, { headers: { host: "malicioso.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
    expect(hostMalicioso).toBe(403);
    expect((await pedir("/api/auth/login", "POST", null)).status).toBe(400);
    expect((await pedir("/api/auth/login", "POST", { senha: "x".repeat(17_000) })).status).toBe(413);
    const malformed = await fetch(`${base}/api/auth/login`, { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
  });

  it("limita tentativas simultâneas antes de derivar senhas", async () => {
    const respostas = await Promise.all(Array.from({ length: 10 }, () => pedir("/api/auth/login", "POST", { email: "ausente@example.com", senha: SENHA })));
    const estados = respostas.map((resposta) => resposta.status);
    expect(estados.every((status) => status === 401 || status === 429)).toBe(true);
    expect(estados.filter((status) => status === 401).length).toBeLessThanOrEqual(4);
    expect(estados.filter((status) => status === 429).length).toBeGreaterThanOrEqual(6);
  });
});

describe("isolamento em HTTP e MCP", () => {
  it("adota o legado somente na primeira conta e aceita slugs iguais em contas distintas", async () => {
    const legado = store.criarProjeto({ nome: "Mesmo", pedido: "pedido privado de A" });
    store.criarDocumento({ projetoId: legado.id, tipo: "prompt", titulo: "Privado", conteudo: "prompt de A" });
    const a = await conta("a@example.com");
    const b = await conta("b@example.com");
    expect(a.store.projetoPorSlug("mesmo")?.id).toBe(legado.id);
    expect(b.store.listarProjetos()).toEqual([]);
    b.store.criarProjeto({ nome: "Mesmo", pedido: "pedido privado de B" });
    const ta = await token(a.cookie);
    const tb = await token(b.cookie);
    expect((await rpc(ta.token, "resources/read", { uri: "capivara://mesmo/pedido" })).dado.result.contents[0].text).toBe("pedido privado de A");
    expect((await rpc(tb.token, "resources/read", { uri: "capivara://mesmo/pedido" })).dado.result.contents[0].text).toBe("pedido privado de B");
    expect((await rpc(tb.token, "prompts/get", { name: "mesmo/privado" })).dado.error).toBeTruthy();
    const pagina = await pedir("/projetos/mesmo", "GET", undefined, b.headers);
    expect(await pagina.text()).not.toContain("pedido privado de A");
  });

  it("protege documentos, seleções e arquivos mesmo quando o ID do outro usuário é conhecido", async () => {
    const a = await conta("a@example.com");
    const b = await conta("b@example.com");
    const pa = a.store.criarProjeto({ nome: "A", pedido: "A" });
    b.store.criarProjeto({ nome: "B", pedido: "B" });
    const doc = a.store.criarDocumento({ tipo: "skill", titulo: "Segredo", conteudo: "conteúdo privado", arquivos: [{ caminho: "ref.md", conteudo: Buffer.from("arquivo secreto"), binario: false }] });
    expect((await pedir("/api/tokens", "POST", { nome: "Inválido", projeto: "a" }, b.headers)).status).toBe(400);
    expect((await pedir("/api/tokens", "POST", { nome: "Inválido", projeto: 123 }, b.headers)).status).toBe(400);
    a.store.selecionar(pa.id, doc.id);
    expect((await pedir(`/api/documentos/${doc.id}`, "GET", undefined, b.headers)).status).toBe(404);
    expect((await pedir(`/api/documentos/${doc.id}`, "PUT", { conteudo: "invadido" }, b.headers)).status).toBe(400);
    expect((await pedir(`/api/documentos/${doc.id}`, "DELETE", undefined, b.headers)).status).toBe(400);
    expect((await pedir(`/api/projetos/b/selecoes/${doc.id}`, "POST", undefined, b.headers)).status).toBe(400);
    const tb = await token(b.cookie);
    const lista = await rpc(tb.token, "resources/list");
    expect(JSON.stringify(lista.dado)).not.toContain("segredo");
    expect((await rpc(tb.token, "resources/read", { uri: "capivara://geral/docs/skill/segredo/ref.md" })).dado.error).toBeTruthy();
    expect((await rpc(tb.token, "tools/call", { name: "ler_documento", arguments: { uri: "capivara://geral/docs/skill/segredo/ref.md" } })).dado.result.isError).toBe(true);
    expect(a.store.documentoPorId(doc.id)?.conteudo).toBe("conteúdo privado");
  });

  it("limita o token ao projeto e seu material selecionado", async () => {
    const a = await conta("a@example.com");
    const p = a.store.criarProjeto({ nome: "Permitido", pedido: "um pedido" });
    a.store.criarProjeto({ nome: "Outro", pedido: "pedido do outro" });
    const selecionado = a.store.criarDocumento({ tipo: "skill", titulo: "Selecionada", conteudo: "skill selecionada" });
    a.store.criarDocumento({ tipo: "skill", titulo: "Fora", conteudo: "não selecionada" });
    a.store.selecionar(p.id, selecionado.id);
    const t = await token(a.cookie, { projeto: "permitido" });
    const lista = JSON.stringify((await rpc(t.token, "resources/list")).dado);
    expect(lista).toContain("selecionada");
    expect(lista).not.toContain("outro");
    expect(lista).not.toContain("/fora");
    expect((await rpc(t.token, "resources/read", { uri: "capivara://outro/pedido" })).dado.error).toBeTruthy();
    expect((await rpc(t.token, "resources/read", { uri: "capivara://geral/docs/skill/fora" })).dado.error).toBeTruthy();
    const memoria = await rpc(t.token, "tools/call", { name: "registrar_memoria", arguments: { projeto: "permitido", natureza: "decisao", titulo: "Escolha", conteudo: "feito" } });
    expect(memoria.dado.result.content[0].text).toContain("rascunho");
    expect(a.store.rascunhos(p.id)).toHaveLength(1);
    const proibido = await rpc(t.token, "tools/call", { name: "registrar_levantamento", arguments: { projeto: "invasao", conteudo: "x" } });
    expect(proibido.status).toBe(200);
    expect(proibido.dado.jsonrpc).toBe("2.0");
    expect(proibido.dado.result.isError).toBe(true);
    expect(a.store.projetoPorSlug("invasao")).toBeNull();
  });

  it("token de leitura não escreve e credenciais de CLI não administram a conta", async () => {
    const a = await conta("a@example.com");
    const p = a.store.criarProjeto({ nome: "P" });
    a.store.criarDocumento({ projetoId: p.id, tipo: "documentacao", titulo: "Contrato", conteudo: "documento para qualquer CLI" });
    const t = await token(a.cookie, { permissao: "leitura" });
    const ferramentas = (await rpc(t.token, "tools/list")).dado.result.tools;
    expect(ferramentas.map((f: { name: string }) => f.name)).toEqual(["abrir_projeto", "listar_historico", "obter_contexto", "listar_material", "ler_documento"]);
    const documento = await rpc(t.token, "tools/call", { name: "ler_documento", arguments: { uri: "capivara://p/docs/documentacao/contrato" } });
    expect(documento.dado.result.content[0].text).toBe("documento para qualquer CLI");
    const gravar = await rpc(t.token, "tools/call", { name: "registrar_memoria", arguments: { projeto: "p", natureza: "decisao", titulo: "x", conteudo: "x" } });
    expect(gravar.dado.result?.isError || gravar.dado.error).toBeTruthy();
    expect(a.store.memorias(p.id)).toEqual([]);
    expect((await pedir("/api/tokens", "GET", undefined, { authorization: `Bearer ${t.token}` })).status).toBe(401);
    expect((await pedir("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "ping" }, a.headers)).status).toBe(401);
    const invalido = await pedir("/mcp", "POST", null, { authorization: `Bearer ${t.token}` });
    expect((await invalido.json() as any).error.code).toBe(-32600);
  });
});

describe("ciclo de vida das credenciais", () => {
  it("mostra segredo somente na criação, guarda hash, isola revogação e revoga imediatamente", async () => {
    const a = await conta("a@example.com");
    const b = await conta("b@example.com");
    const t = await token(a.cookie);
    const banco = store.banco.prepare("SELECT hash FROM tokens WHERE id = ?").get(t.credencial.id) as { hash: string };
    expect(banco.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(banco.hash).not.toBe(t.token);
    expect(await (await pedir("/api/tokens", "GET", undefined, a.headers)).text()).not.toContain(t.token);
    expect(await (await pedir("/conta", "GET", undefined, a.headers)).text()).not.toContain(t.token);
    expect((await pedir(`/api/tokens/${t.credencial.id}`, "DELETE", undefined, b.headers)).status).toBe(404);
    expect((await rpc(t.token, "ping")).status).toBe(200);
    expect((await pedir(`/api/tokens/${t.credencial.id}`, "DELETE", undefined, a.headers)).status).toBe(204);
    expect((await rpc(t.token, "ping")).status).toBe(401);
  });

  it("expira sessões e tokens e invalida o token quando o projeto é removido", async () => {
    const a = await conta("a@example.com");
    a.store.criarProjeto({ nome: "P" });
    const curto = await token(a.cookie, { dias: 1 });
    const vinculado = await token(a.cookie, { projeto: "p" });
    a.store.removerProjeto("p");
    expect((await rpc(vinculado.token, "ping")).status).toBe(401);
    agora += 86_400_001;
    expect((await rpc(curto.token, "ping")).status).toBe(401);
    agora += DURACAO_SESSAO;
    expect((await pedir("/api/auth/me", "GET", undefined, a.headers)).status).toBe(401);
  });

  it("persiste credenciais e isolamento após reabrir o banco", async () => {
    const pasta = await mkdtemp(join(tmpdir(), "doc-center-auth-"));
    const arquivo = join(pasta, "persistente.db");
    let persistente = new Store({ file: arquivo });
    try {
      let contas = new AuthStore(persistente);
      const usuario = await contas.registrar({ nome: "Pessoa", email: "pessoa@example.com", senha: SENHA });
      persistente.forUser(usuario.id).criarProjeto({ nome: "P", pedido: "privado" });
      const sessao = contas.criarSessao(usuario.id);
      const t = contas.criarToken(usuario.id, { nome: "CLI", projeto: "p" });
      persistente.close();
      persistente = new Store({ file: arquivo });
      contas = new AuthStore(persistente);
      expect(contas.usuarioDaSessao(sessao)?.id).toBe(usuario.id);
      expect(contas.identidadeDoToken(t.token)?.credencial?.projeto).toBe("p");
      expect(await contas.entrar(usuario.email, SENHA)).toMatchObject({ id: usuario.id });
      expect(persistente.listarProjetos()).toEqual([]);
      expect(persistente.forUser(usuario.id).projetoPorSlug("p")?.pedido).toBe("privado");
    } finally { persistente.close(); await rm(pasta, { recursive: true, force: true }); }
  });
});
