/**
 * O que o banco garante, com atenção ao que é destrutivo.
 *
 * Excluir um projeto apaga coisas, e a pergunta que importa não é se apaga: é
 * **o que sobrevive**. Um documento da área geral que dois projetos usam não
 * pode desaparecer porque um deles foi excluído — a seleção aponta, não copia,
 * e essa é a diferença que faz o acervo valer a pena.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";

let store: Store;

beforeEach(() => {
  store = new Store({ file: ":memory:" });
});

afterEach(() => {
  store.close();
});

describe("excluir um projeto", () => {
  it("leva o que nasceu nele e preserva o acervo que ele usava", () => {
    const alvo = store.criarProjeto({ nome: "Alvo" });
    const vizinho = store.criarProjeto({ nome: "Vizinho" });

    const daGeral = store.criarDocumento({ tipo: "skill", titulo: "Compartilhada", conteudo: "usada por dois" });
    const proprio = store.criarDocumento({ projetoId: alvo.id, tipo: "memoria", titulo: "Só do alvo", conteudo: "some junto" });

    store.selecionar(alvo.id, daGeral.id);
    store.selecionar(vizinho.id, daGeral.id);

    store.removerProjeto("alvo");

    expect(store.projetoPorSlug("alvo")).toBeNull();
    expect(store.documentoPorId(proprio.id), "o documento do projeto vai junto").toBeNull();
    expect(store.documentoPorId(daGeral.id), "o da área geral fica").not.toBeNull();
    // E o vizinho continua usando o que selecionou.
    expect(store.idsSelecionados(vizinho.id)).toEqual([daGeral.id]);
    expect(store.listarDoProjeto(vizinho.id).map((documento) => documento.titulo)).toEqual(["Compartilhada"]);
  });

  it("não deixa seleção órfã para trás", () => {
    const projeto = store.criarProjeto({ nome: "Some" });
    const documento = store.criarDocumento({ tipo: "hook", titulo: "Um hook", conteudo: "x" });
    store.selecionar(projeto.id, documento.id);

    const id = projeto.id;
    store.removerProjeto("some");
    // A linha de seleção apontava para um projeto que não existe mais; sem o
    // CASCADE ligado ela ficaria no banco, e um id reaproveitado a ressuscitaria
    // dentro de outro projeto.
    expect(store.idsSelecionados(id)).toEqual([]);
  });

  it("excluir projeto que não existe não explode", () => {
    expect(() => store.removerProjeto("nunca-existiu")).not.toThrow();
  });
});

describe("as regras que protegem o significado da seleção", () => {
  it("só documento da área geral é selecionável", () => {
    const projeto = store.criarProjeto({ nome: "P" });
    const proprio = store.criarDocumento({ projetoId: projeto.id, tipo: "skill", titulo: "Dele", conteudo: "x" });
    expect(() => store.selecionar(projeto.id, proprio.id)).toThrow(/área geral/);
  });

  it("dois documentos do mesmo tipo e slug no mesmo lugar seriam a mesma URI", () => {
    store.criarDocumento({ tipo: "skill", titulo: "Revisar PR", conteudo: "a" });
    expect(() => store.criarDocumento({ tipo: "skill", titulo: "Revisar PR", conteudo: "b" })).toThrow(/já existe/);

    // O mesmo título dentro de um projeto é outro lugar, e por isso é permitido.
    const projeto = store.criarProjeto({ nome: "P" });
    expect(() => store.criarDocumento({ projetoId: projeto.id, tipo: "skill", titulo: "Revisar PR", conteudo: "c" })).not.toThrow();
  });

  it("selecionar duas vezes não duplica", () => {
    const projeto = store.criarProjeto({ nome: "P" });
    const documento = store.criarDocumento({ tipo: "skill", titulo: "S", conteudo: "x" });
    store.selecionar(projeto.id, documento.id);
    store.selecionar(projeto.id, documento.id);
    expect(store.idsSelecionados(projeto.id)).toEqual([documento.id]);
    expect(store.listarDoProjeto(projeto.id)).toHaveLength(1);
  });
});

describe("um projeto novo", () => {
  it("nasce sem documento nenhum — os contêineres são da tela, não do banco", () => {
    const projeto = store.criarProjeto({ nome: "Recém-criado" });
    expect(store.listarProprios(projeto.id)).toEqual([]);
    expect(store.listarDoProjeto(projeto.id)).toEqual([]);
    expect(projeto.pedido).toBe("");
  });

  it("recusa nome que não vira slug, em vez de criar um projeto sem endereço", () => {
    expect(() => store.criarProjeto({ nome: "!!!" })).toThrow(/slug/);
  });
});
