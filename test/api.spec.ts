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

let store: Store;
let server: Server;
let base = "";

async function pedir(metodo: string, caminho: string, corpo?: unknown): Promise<{ status: number; dado: any }> {
  const resposta = await fetch(`${base}${caminho}`, {
    method: metodo,
    ...(corpo === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) }),
  });
  return { status: resposta.status, dado: await resposta.json() };
}

beforeEach(async () => {
  store = new Store({ file: ":memory:" });
  server = createApp({ store });
  base = `http://127.0.0.1:${await listen(server, 0)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
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
