/**
 * A borda HTTP, onde o dado entra.
 *
 * O defeito que motivou este arquivo: a API criava a skill sem descrição,
 * categoria, gatilhos nem restrições. O store sabia guardar, a tela sabia
 * mostrar, e no meio os campos eram descartados em silêncio — a skill chegava
 * ao catálogo sem nada do que se lê para escolhê-la. Nada falhava; só ficava
 * vazio.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";
import { autenticarTeste } from "./auth-fixture.js";

let store: Store;
let root: Store;
let server: Server;
let base = "";
let headers: Record<string, string>;

async function pedir(metodo: string, caminho: string, corpo?: unknown): Promise<{ status: number; dado: any }> {
  const resposta = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers: { ...headers, ...(corpo === undefined ? {} : { "content-type": "application/json" }) },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
  return { status: resposta.status, dado: await resposta.json() };
}

beforeEach(async () => {
  root = new Store({ file: ":memory:" });
  server = createApp({ store: root });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
  ({ store, headers } = await autenticarTeste(root, base));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  root.close();
});

const SKILL = {
  tipo: "skill",
  titulo: "Revisar diff",
  categoria: "Qualidade",
  descricao: "Lê o diff inteiro e aponta defeito de correção.",
  gatilhos: "revisar PR, antes de commitar",
  restricoes: "formatação, que a ferramenta já pega",
  conteudo: "Leia o diff inteiro antes de comentar.",
};

describe("cadastrar no catálogo", () => {
  it("guarda a vitrine inteira, não só o conteúdo", async () => {
    const { status, dado } = await pedir("POST", "/api/documentos", SKILL);
    expect(status).toBe(201);
    expect(dado.documento).toMatchObject({
      categoria: "Qualidade",
      descricao: "Lê o diff inteiro e aponta defeito de correção.",
      gatilhos: "revisar PR, antes de commitar",
      restricoes: "formatação, que a ferramenta já pega",
    });

    // E sobrevive à ida ao banco: o defeito original só aparecia ao reler.
    const lido = await pedir("GET", `/api/documentos/${dado.documento.id}`);
    expect(lido.dado.documento.gatilhos).toBe("revisar PR, antes de commitar");
  });

  it("editar preserva o que não foi enviado", async () => {
    const { dado } = await pedir("POST", "/api/documentos", SKILL);
    await pedir("PUT", `/api/documentos/${dado.documento.id}`, { conteudo: "outro conteúdo" });

    const lido = await pedir("GET", `/api/documentos/${dado.documento.id}`);
    expect(lido.dado.documento.conteudo).toBe("outro conteúdo");
    expect(lido.dado.documento.categoria, "a categoria não foi tocada").toBe("Qualidade");
  });

  it("memória não precisa de vitrine", async () => {
    const { status, dado } = await pedir("POST", "/api/documentos", {
      tipo: "memoria",
      titulo: "Estilo",
      conteudo: "português no código",
    });
    expect(status).toBe(201);
    expect(dado.documento.categoria).toBe("");
  });
});

describe("os códigos de resposta", () => {
  /*
   * "Já existe" é resposta legítima a pedido legítimo. Responder 500 mandaria o
   * operador procurar defeito no servidor, e um monitor contaria falha onde não
   * houve.
   */
  it("duplicado é 400 com a razão, não 500", async () => {
    await pedir("POST", "/api/documentos", SKILL);
    const repetido = await pedir("POST", "/api/documentos", SKILL);
    expect(repetido.status).toBe(400);
    expect(repetido.dado.erro).toContain("já existe");
  });

  it("projeto inexistente é 404", async () => {
    const { status } = await pedir("GET", "/api/projetos/inventado");
    expect(status).toBe(404);
  });

  it("rota desconhecida é 404 e diz qual era", async () => {
    const { status, dado } = await pedir("GET", "/api/nada");
    expect(status).toBe(404);
    expect(dado.erro).toContain("/api/nada");
  });
});

describe("adotar do catálogo", () => {
  it("adiciona e remove do projeto pela mesma rota", async () => {
    const projeto = await pedir("POST", "/api/projetos", { nome: "Biblioteca" });
    const skill = await pedir("POST", "/api/documentos", SKILL);
    const id = skill.dado.documento.id;

    const adotada = await pedir("POST", `/api/projetos/biblioteca/selecoes/${id}`);
    expect(adotada.dado.selecionados).toEqual([id]);

    const comProjeto = await pedir("GET", "/api/projetos/biblioteca");
    expect(comProjeto.dado.usados.map((documento: { titulo: string }) => documento.titulo)).toEqual(["Revisar diff"]);
    expect(projeto.dado.projeto.slug).toBe("biblioteca");

    const removida = await pedir("DELETE", `/api/projetos/biblioteca/selecoes/${id}`);
    expect(removida.dado.selecionados).toEqual([]);
    // A skill continua no catálogo: adotar aponta, não copia nem move.
    const aindaExiste = await pedir("GET", `/api/documentos/${id}`);
    expect(aindaExiste.status).toBe(200);
  });
});

/**
 * A tela dos artefatos que o harness grava.
 *
 * Um levantamento tem dezenas de milhares de caracteres, e a prévia nasceu com
 * corte em 600 e `overflow: hidden`: servia para uma memória de três linhas e
 * escondia 90% do que o harness escreveu. Quem precisa conferir um documento
 * gerado só tem um jeito — lendo.
 */
describe("ler um artefato inteiro na tela", () => {
  it("a prévia leva o documento todo, não os primeiros 600 caracteres", async () => {
    const projeto = store.criarProjeto({ nome: "P", slug: "p", pedido: "x" });
    const longo = Array.from({ length: 200 }, (_, indice) => `linha ${indice} do levantamento`).join("\n");
    store.criarDocumento({ projetoId: projeto.id, tipo: "documentacao", titulo: "Levantamento", conteudo: longo });

    const html = await (await fetch(`${base}/projetos/p`, { headers })).text();
    expect(html).toContain("linha 0 do levantamento");
    expect(html).toContain("linha 199 do levantamento");
  });

  it("acima do teto, diz quanto ficou de fora em vez de terminar no meio", async () => {
    const projeto = store.criarProjeto({ nome: "Q", slug: "q", pedido: "x" });
    store.criarDocumento({ projetoId: projeto.id, tipo: "documentacao", titulo: "Enorme", conteudo: "a".repeat(30_000) });

    const html = await (await fetch(`${base}/projetos/q`, { headers })).text();
    expect(html).toContain("mostrando os primeiros");
    expect(html).toContain("abra em editar para ver tudo");
  });

  it("prompts têm seu próprio botão de criar, com campo de descrição", async () => {
    store.criarProjeto({ nome: "R", slug: "r", pedido: "x" });
    const html = await (await fetch(`${base}/projetos/r`, { headers })).text();

    expect(html).toContain("novo prompt");
    // A descrição é o que distingue dois prompts na hora de escolher, no wizard.
    expect(html).toContain("quando usar este prompt");
  });
});

describe("entrada e conexões da conta", () => {
  it("oferece entrada por senha e protege a tela de conexões", async () => {
    const resposta = await fetch(`${base}/conta`, { redirect: "manual" });
    expect(resposta.status).toBe(303);
    expect(resposta.headers.get("location")).toBe("/login");

    const login = await (await fetch(`${base}/login`)).text();
    expect(login).toContain('action="/api/auth/login"');
    expect(login).toContain('type="password"');
    expect(login).toContain('autocomplete="current-password"');

    const cadastro = await (await fetch(`${base}/cadastro`)).text();
    expect(cadastro).toContain('action="/api/auth/register"');
    expect(cadastro).toContain('autocomplete="new-password"');
    expect(cadastro).toContain('minlength="12"');
  });

  it("escapa nomes e mostra somente o prefixo de cada token", async () => {
    const projeto = store.criarProjeto({ nome: '<img src=x onerror="alert(1)">', slug: "projeto-seguro" });
    const ataque = '<script>alert("token")</script>';
    const criado = await pedir("POST", "/api/tokens", { nome: ataque, projeto: projeto.slug, permissao: "leitura" });
    expect(criado.status).toBe(201);

    const html = await (await fetch(`${base}/conta`, { headers })).text();
    expect(html).toContain("Minha conta");
    expect(html).toContain("Pessoa de teste");
    expect(html).toContain("&lt;script&gt;alert(&quot;token&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain(ataque);
    expect(html).not.toContain(projeto.nome);
    expect(html).toContain(criado.dado.credencial.prefixo);
    expect(html).not.toContain(criado.dado.token);
    expect(html).toContain('data-revogar-token="' + criado.dado.credencial.id + '"');
    expect(html).toContain("DOC_CENTER_TOKEN");
    expect(html).toContain("doc-center connect");
  });
});
