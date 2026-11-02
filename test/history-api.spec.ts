import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";
import { autenticarTeste } from "./auth-fixture.js";
import type { EntradaHistorico } from "../src/db/schema.js";
import type { contextoDoProjeto, paginaDoHistorico } from "../src/mcp/server.js";

let root: Store;
let store: Store;
let server: Server;
let base: string;
let headers: Record<string, string>;
let mcpHeaders: Record<string, string>;

beforeEach(async () => {
  root = new Store({ file: ":memory:" });
  server = createApp({ store: root });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
  ({ store, headers, mcpHeaders } = await autenticarTeste(root, base));
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); root.close(); });

const registrar = (projetoId: number, id: string, conteudo: string, papel: "user" | "assistant" = "user") =>
  store.registrarHistorico(projetoId, { eventoId: id, origem: papel === "user" ? "codex" : "claude", sessao: "conversa", papel,
    conteudo, modelo: papel === "user" ? "modelo-a" : "modelo-b", maquina: "computador", criadoEm: "2026-10-10T10:00:00Z" }).entrada;

describe("histórico e contexto na área logada", () => {
  it("pagina prévias e permite buscar a mensagem completa sem editar o pedido", async () => {
    const projeto = store.criarProjeto({ nome: "Aplicação", slug: "aplicacao", pedido: "PEDIDO_ATUAL" });
    const primeira = registrar(projeto.id, "evento-1", "PRIMEIRA " + "x".repeat(5_000));
    registrar(projeto.id, "evento-2", "RESPOSTA_HISTORICA", "assistant");
    registrar(projeto.id, "evento-3", "ULTIMA_MENSAGEM");
    const pagina = await (await fetch(`${base}/api/projetos/aplicacao/historico?limite=2`, { headers })).json() as ReturnType<typeof paginaDoHistorico>;
    expect(pagina).toMatchObject({ total: 3, temMais: true });
    expect(pagina.entradas).toHaveLength(2);
    expect(pagina.entradas[0]!.previa.length).toBe(600);
    expect(pagina.entradas[0]).not.toHaveProperty("conteudo");
    const ultima = await (await fetch(`${base}/api/projetos/aplicacao/historico?limite=2&depois=${pagina.proximo}`, { headers })).json() as ReturnType<typeof paginaDoHistorico>;
    expect(ultima).toMatchObject({ temMais: false, proximo: null });
    expect(ultima.entradas[0]!.previa).toBe("ULTIMA_MENSAGEM");
    const completa = await (await fetch(`${base}/api/projetos/aplicacao/historico/${primeira.id}`, { headers })).json() as { entrada: EntradaHistorico };
    expect(completa.entrada.conteudo).toBe("PRIMEIRA " + "x".repeat(5_000));
    expect(store.projetoPorSlug("aplicacao")?.pedido).toBe("PEDIDO_ATUAL");
    expect((await fetch(`${base}/api/projetos/aplicacao/historico?limite=101`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/api/projetos/aplicacao/historico?depois=-1`, { headers })).status).toBe(400);
  });

  it("mantém histórico e contexto protegidos por sessão e isolados entre contas", async () => {
    const projeto = store.criarProjeto({ nome: "Aplicação", slug: "aplicacao", pedido: "PEDIDO_PRIVADO" });
    const entrada = registrar(projeto.id, "privado", "HISTORICO_PRIVADO");
    expect((await fetch(`${base}/api/projetos/aplicacao/historico`)).status).toBe(401);
    expect((await fetch(`${base}/api/projetos/aplicacao/contexto`, { headers: mcpHeaders })).status).toBe(401);
    expect((await fetch(`${base}/api/projetos/aplicacao/contexto`, { headers: { ...headers, ...mcpHeaders } })).status).toBe(403);
    const registro = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Outra pessoa", email: "outra@example.com", senha: "senha-segura-da-outra-pessoa" }) });
    expect(registro.status).toBe(201);
    const { usuario } = await registro.json() as { usuario: { id: number } };
    const outraHeaders = { cookie: registro.headers.get("set-cookie")!.split(";")[0]! };
    const outraStore = root.forUser(usuario.id);
    outraStore.criarProjeto({ nome: "Mesmo slug, outra conta", slug: "aplicacao", pedido: "PEDIDO_DA_OUTRA_CONTA" });
    const historico = await (await fetch(`${base}/api/projetos/aplicacao/historico`, { headers: outraHeaders })).json() as ReturnType<typeof paginaDoHistorico>;
    expect(historico.total).toBe(0);
    expect((await fetch(`${base}/api/projetos/aplicacao/historico/${entrada.id}`, { headers: outraHeaders })).status).toBe(404);
    const contexto = await (await fetch(`${base}/api/projetos/aplicacao/contexto`, { headers: outraHeaders })).json() as ReturnType<typeof contextoDoProjeto>;
    expect(contexto.pedido.conteudo).toBe("PEDIDO_DA_OUTRA_CONTA");
    expect(JSON.stringify(contexto)).not.toMatch(/HISTORICO_PRIVADO|PEDIDO_PRIVADO/);
  });

  it("apresenta papéis e origens, escapa conteúdo e oferece cópia e reutilização explícitas", async () => {
    const projeto = store.garantirProjeto({ slug: "aplicacao", nome: "Aplicação", repositorio: "git@github.com:exemplo/aplicacao.git" }).projeto;
    registrar(projeto.id, "evento-1", '<script>alert("historico")</script>\n' + "x".repeat(4_000));
    registrar(projeto.id, "evento-2", "RESPOSTA_HISTORICA", "assistant");
    const resposta = await fetch(`${base}/projetos/aplicacao`, { headers });
    expect(resposta.status).toBe(200);
    const html = await resposta.text();
    expect(html).toContain("Histórico de conversas");
    expect(html).toContain("codex");
    expect(html).toContain("claude");
    expect(html).toContain("modelo-b");
    expect(html).toContain("assistente");
    expect(html).toContain("&lt;script&gt;alert(&quot;historico&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("historico")</script>');
    expect(html).not.toContain("x".repeat(1_000));
    expect(html).toContain("data-historico-detalhe");
    expect(html).toContain("data-copiar-historico");
    expect(html).toContain("Salvar como prompt reutilizável");
    expect(html).toContain('href="https://github.com/exemplo/aplicacao"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("mostra conversas recentes e permite percorrer mensagens anteriores em ordem", async () => {
    const projeto = store.criarProjeto({ nome: "Aplicação", slug: "aplicacao" });
    for (let indice = 0; indice < 35; indice++) registrar(projeto.id, `evento-${indice}`, `MENSAGEM_${indice}_HISTORICA`);
    const recente = await (await fetch(`${base}/projetos/aplicacao`, { headers })).text();
    expect(recente).toContain("MENSAGEM_34_HISTORICA");
    expect(recente).not.toContain("MENSAGEM_0_HISTORICA");
    expect(recente).toContain("Ver histórico desde o início");
    const inicial = await (await fetch(`${base}/projetos/aplicacao?historico_depois=0`, { headers })).text();
    expect(inicial).toContain("MENSAGEM_0_HISTORICA");
    expect(inicial).toContain("MENSAGEM_29_HISTORICA");
    expect(inicial).not.toContain("MENSAGEM_34_HISTORICA");
    expect(inicial).toContain("Próximas mensagens");
    expect(inicial).toContain("Mensagens mais recentes");
    const primeiraPagina = await (await fetch(`${base}/api/projetos/aplicacao/historico?limite=30`, { headers })).json() as ReturnType<typeof paginaDoHistorico>;
    const seguintes = await (await fetch(`${base}/projetos/aplicacao?historico_depois=${primeiraPagina.proximo}`, { headers })).text();
    expect(seguintes).toContain("MENSAGEM_34_HISTORICA");
    expect(seguintes).not.toContain("MENSAGEM_29_HISTORICA");
  });
});
