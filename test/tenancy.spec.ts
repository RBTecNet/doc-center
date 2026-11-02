import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COLUNAS_NOVAS, SCHEMA } from "../src/db/schema.js";
import { ErroDeUso, Store } from "../src/db/store.js";
import { exportarProjeto, importarProjeto } from "../src/projeto-zip.js";

let raiz: Store;
let ana: Store;
let bruno: Store;
const temporarios: string[] = [];
const conexoes: Store[] = [];

beforeEach(() => {
  raiz = new Store({ file: ":memory:", now: () => "2026-10-10T12:00:00.000Z" });
  ana = raiz.forUser(101);
  bruno = raiz.forUser(202);
});

afterEach(() => {
  raiz.close();
  for (const store of conexoes.splice(0)) store.close();
  for (const diretorio of temporarios.splice(0)) rmSync(diretorio, { recursive: true, force: true });
});

describe("propriedade dos dados", () => {
  it("permite slugs iguais e mantém as visões independentes", () => {
    const projetoAna = ana.criarProjeto({ nome: "Produto", pedido: "pedido de Ana" });
    const projetoBruno = bruno.criarProjeto({ nome: "Produto", pedido: "pedido de Bruno" });
    const skillAna = ana.criarDocumento({ tipo: "skill", titulo: "Design", conteudo: "Ana", categoria: "Frontend" });
    const skillBruno = bruno.criarDocumento({ tipo: "skill", titulo: "Design", conteudo: "Bruno", categoria: "Privada" });
    ana.selecionar(projetoAna.id, skillAna.id);
    bruno.selecionar(projetoBruno.id, skillBruno.id);

    expect(ana.projetoPorSlug("produto")?.pedido).toBe("pedido de Ana");
    expect(bruno.projetoPorSlug("produto")?.pedido).toBe("pedido de Bruno");
    expect(ana.listarProjetos().map((projeto) => projeto.id)).toEqual([projetoAna.id]);
    expect(bruno.listarProjetos().map((projeto) => projeto.id)).toEqual([projetoBruno.id]);
    expect(ana.documento(null, "skill", "design")?.conteudo).toBe("Ana");
    expect(bruno.documento(null, "skill", "design")?.conteudo).toBe("Bruno");
    expect(ana.categorias("skill")).toEqual([{ categoria: "Frontend", quantos: 1 }]);
    expect(bruno.categorias("skill")).toEqual([{ categoria: "Privada", quantos: 1 }]);
    expect(ana.listarDoProjeto(projetoAna.id).map((documento) => documento.id)).toEqual([skillAna.id]);
    expect(bruno.listarDoProjeto(projetoBruno.id).map((documento) => documento.id)).toEqual([skillBruno.id]);
    expect(raiz.listarProjetos()).toEqual([]);
    expect(raiz.listarGerais()).toEqual([]);

    // Encerrar uma visão de requisição não encerra o banco de outra requisição.
    ana.close();
    expect(bruno.projetoPorSlug("produto")?.id).toBe(projetoBruno.id);
    expect(() => ana.forUser(202)).toThrow(ErroDeUso);
    expect(() => raiz.forUser(0)).toThrow(ErroDeUso);
  });

  it("IDs de outra conta não expõem documentos, arquivos, seleções nem memórias", () => {
    const projeto = bruno.criarProjeto({ nome: "Privado" });
    const skill = bruno.criarDocumento({
      tipo: "skill", titulo: "Pacote privado", conteudo: "segredo",
      arquivos: [{ caminho: "tela.png", conteudo: Buffer.from([0, 1, 255]), binario: true }],
    });
    bruno.selecionar(projeto.id, skill.id);
    const memoria = bruno.registrarMemoria({ projetoId: projeto.id, natureza: "decisao", titulo: "Stack", conteudo: "privado" });

    expect(ana.projetoPorSlug("privado")).toBeNull();
    expect(ana.documentoPorId(skill.id)).toBeNull();
    expect(ana.documentoPorId(memoria.id)).toBeNull();
    expect(ana.documento(projeto.id, "memoria", memoria.slug)).toBeNull();
    expect(ana.arquivos(skill.id)).toEqual([]);
    expect(ana.arquivo(skill.id, "tela.png")).toBeNull();
    expect(ana.listarGerais()).toEqual([]);
    expect(ana.listarProprios(projeto.id)).toEqual([]);
    expect(ana.listarDoProjeto(projeto.id)).toEqual([]);
    expect(ana.idsSelecionados(projeto.id)).toEqual([]);
    expect(ana.memorias(projeto.id)).toEqual([]);
    expect(ana.rascunhos()).toEqual([]);
    expect(ana.rascunhos(projeto.id)).toEqual([]);
  });

  it("recusa escritas por IDs externos e não altera os dados da outra conta", () => {
    const proprio = ana.criarProjeto({ nome: "Meu" });
    const projeto = bruno.criarProjeto({ nome: "Privado", pedido: "pedido privado" });
    const skill = bruno.criarDocumento({ tipo: "skill", titulo: "Privada", conteudo: "privado" });
    const skillAna = ana.criarDocumento({ tipo: "skill", titulo: "Minha", conteudo: "minha" });
    bruno.gravarArquivo(skill.id, { caminho: "referencia.md", conteudo: Buffer.from("referência privada"), binario: false });
    bruno.selecionar(projeto.id, skill.id);
    const memoria = bruno.registrarMemoria({ projetoId: projeto.id, natureza: "estado", titulo: "Estado", conteudo: "privado" });

    const tentativas = [
      () => ana.atualizarProjeto("privado", { pedido: "invadido" }),
      () => ana.removerProjeto("privado"),
      () => ana.criarDocumento({ projetoId: projeto.id, tipo: "memoria", titulo: "Invasão", conteudo: "x" }),
      () => ana.atualizarDocumento(skill.id, { conteudo: "invadido" }),
      () => ana.removerDocumento(skill.id),
      () => ana.aprovar(memoria.id),
      () => ana.registrarMemoria({ projetoId: projeto.id, natureza: "estado", titulo: "Estado", conteudo: "invadido" }),
      () => ana.gravarArquivo(skill.id, { caminho: "referencia.md", conteudo: Buffer.from("invadido"), binario: false }),
      () => ana.removerArquivos(skill.id),
      () => ana.selecionar(proprio.id, skill.id),
      () => ana.selecionar(projeto.id, skillAna.id),
      () => ana.desselecionar(projeto.id, skill.id),
      () => ana.desselecionar(proprio.id, skill.id),
    ];
    for (const tentativa of tentativas) expect(tentativa).toThrow(ErroDeUso);

    expect(bruno.projetoPorSlug("privado")?.pedido).toBe("pedido privado");
    expect(bruno.documentoPorId(skill.id)?.conteudo).toBe("privado");
    expect(bruno.documentoPorId(memoria.id)?.status).toBe("rascunho");
    expect(bruno.memorias(projeto.id)).toHaveLength(1);
    expect(bruno.arquivo(skill.id, "referencia.md")?.conteudo.toString()).toBe("referência privada");
    expect(bruno.idsSelecionados(projeto.id)).toEqual([skill.id]);
  });

  it("a exclusão em uma conta conserva projetos e catálogos da outra", () => {
    const projetoAna = ana.criarProjeto({ nome: "Mesmo slug" });
    const projetoBruno = bruno.criarProjeto({ nome: "Mesmo slug" });
    const documentoAna = ana.criarDocumento({ projetoId: projetoAna.id, tipo: "documentacao", titulo: "Guia", conteudo: "Ana" });
    const documentoBruno = bruno.criarDocumento({ projetoId: projetoBruno.id, tipo: "documentacao", titulo: "Guia", conteudo: "Bruno" });

    ana.removerProjeto("mesmo-slug");
    expect(ana.documentoPorId(documentoAna.id)).toBeNull();
    expect(bruno.projetoPorSlug("mesmo-slug")?.id).toBe(projetoBruno.id);
    expect(bruno.documentoPorId(documentoBruno.id)?.conteudo).toBe("Bruno");
  });

  it("pacotes importados pertencem à conta receptora sem atualizar projetos de outra conta", () => {
    const projetoAna = ana.criarProjeto({ nome: "Produto", pedido: "pedido Ana" });
    const skill = ana.criarDocumento({ projetoId: projetoAna.id, tipo: "skill", titulo: "Skill", conteudo: "## guia", area: "frontend" });
    ana.gravarArquivo(skill.id, { caminho: "referencia.png", conteudo: Buffer.from([0, 1, 255]), binario: true });
    ana.registrarMemoria({ projetoId: projetoAna.id, natureza: "decisao", titulo: "Escolha", conteudo: "a escolha", status: "ativo" });
    const projetoBruno = bruno.criarProjeto({ nome: "Produto", pedido: "pedido Bruno" });

    const resultado = importarProjeto(bruno, exportarProjeto(ana, projetoAna).zip);
    expect(resultado.projeto.id).toBe(projetoBruno.id);
    expect(resultado.projeto.pedido).toBe("pedido Bruno");
    const importada = bruno.documento(projetoBruno.id, "skill", "skill")!;
    expect(importada.id).not.toBe(skill.id);
    expect(bruno.arquivo(importada.id, "referencia.png")?.conteudo).toEqual(Buffer.from([0, 1, 255]));
    expect(ana.documentoPorId(importada.id)).toBeNull();
    expect(ana.projetoPorSlug("produto")?.pedido).toBe("pedido Ana");
    expect(ana.listarProprios(projetoAna.id)).toHaveLength(2);
    expect(bruno.memorias(projetoBruno.id)).toHaveLength(1);
  });
});

describe("token vinculado a um projeto", () => {
  it("lê somente o projeto vinculado e os documentos gerais selecionados nele", () => {
    const alvo = ana.criarProjeto({ nome: "Alvo" });
    const vizinho = ana.criarProjeto({ nome: "Vizinho" });
    const selecionada = ana.criarDocumento({ tipo: "skill", titulo: "Selecionada", conteudo: "permitido", categoria: "Usada" });
    const restante = ana.criarDocumento({ tipo: "skill", titulo: "Restante", conteudo: "restrito", categoria: "Outra" });
    ana.gravarArquivo(selecionada.id, { caminho: "referencia.md", conteudo: Buffer.from("permitido"), binario: false });
    ana.selecionar(alvo.id, selecionada.id);
    ana.selecionar(vizinho.id, restante.id);
    const memoriaAlvo = ana.registrarMemoria({ projetoId: alvo.id, natureza: "decisao", titulo: "Alvo", conteudo: "alvo" });
    const memoriaVizinha = ana.registrarMemoria({ projetoId: vizinho.id, natureza: "decisao", titulo: "Vizinha", conteudo: "restrito" });
    const token = raiz.forUser(101, "alvo");

    expect(token.listarProjetos().map((projeto) => projeto.id)).toEqual([alvo.id]);
    expect(token.projetoPorSlug("vizinho")).toBeNull();
    expect(token.listarGerais().map((documento) => documento.id)).toEqual([selecionada.id]);
    expect(token.categorias("skill")).toEqual([{ categoria: "Usada", quantos: 1 }]);
    expect(token.documento(null, "skill", "restante")).toBeNull();
    expect(token.documentoPorId(restante.id)).toBeNull();
    expect(token.documentoPorId(memoriaVizinha.id)).toBeNull();
    expect(token.arquivo(selecionada.id, "referencia.md")?.conteudo.toString()).toBe("permitido");
    expect(token.listarDoProjeto(alvo.id).map((documento) => documento.id).sort()).toEqual([selecionada.id, memoriaAlvo.id].sort());
    expect(token.listarDoProjeto(vizinho.id)).toEqual([]);
    expect(token.listarProprios(vizinho.id)).toEqual([]);
    expect(token.idsSelecionados(vizinho.id)).toEqual([]);
    expect(token.memorias(vizinho.id)).toEqual([]);
    expect(token.rascunhos().map((documento) => documento.id)).toEqual([memoriaAlvo.id]);
    expect(() => token.forUser(101)).toThrow(ErroDeUso);
    expect(() => token.forUser(101, "vizinho")).toThrow(ErroDeUso);
  });

  it("escreve levantamento e memória, conservando a revisão e o catálogo", () => {
    const alvo = ana.criarProjeto({ nome: "Alvo" });
    const vizinho = ana.criarProjeto({ nome: "Vizinho" });
    const skill = ana.criarDocumento({ tipo: "skill", titulo: "Design", conteudo: "catálogo" });
    ana.selecionar(alvo.id, skill.id);
    const token = raiz.forUser(101, "alvo");
    const levantamento = token.criarDocumento({ projetoId: alvo.id, tipo: "documentacao", titulo: "Levantamento", conteudo: "evidências" });
    token.atualizarDocumento(levantamento.id, { conteudo: "mais evidências" });
    const memoria = token.registrarMemoria({ projetoId: alvo.id, natureza: "estado", titulo: "Estado", conteudo: "em construção", status: "ativo" });
    expect(memoria.status).toBe("rascunho");
    ana.aprovar(memoria.id);
    expect(token.atualizarDocumento(memoria.id, { conteudo: "mudou" }).status).toBe("rascunho");

    const tentativas = [
      () => token.criarProjeto({ nome: "Outro" }),
      () => token.atualizarProjeto("alvo", { pedido: "mudança" }),
      () => token.removerProjeto("alvo"),
      () => token.criarDocumento({ tipo: "skill", titulo: "Nova", conteudo: "x" }),
      () => token.criarDocumento({ projetoId: alvo.id, tipo: "skill", titulo: "Nova", conteudo: "x" }),
      () => token.criarDocumento({ projetoId: vizinho.id, tipo: "documentacao", titulo: "Guia", conteudo: "x" }),
      () => token.registrarMemoria({ projetoId: vizinho.id, natureza: "estado", titulo: "Estado", conteudo: "x" }),
      () => token.atualizarDocumento(skill.id, { conteudo: "x" }),
      () => token.removerDocumento(skill.id),
      () => token.gravarArquivo(skill.id, { caminho: "novo.md", conteudo: Buffer.from("x"), binario: false }),
      () => token.removerArquivos(skill.id),
      () => token.aprovar(memoria.id),
      () => token.selecionar(alvo.id, skill.id),
      () => token.desselecionar(alvo.id, skill.id),
    ];
    for (const tentativa of tentativas) expect(tentativa).toThrow(ErroDeUso);
    expect(ana.documentoPorId(skill.id)?.conteudo).toBe("catálogo");
    expect(ana.documentoPorId(levantamento.id)?.conteudo).toBe("mais evidências");
    expect(ana.idsSelecionados(alvo.id)).toEqual([skill.id]);
  });

  it("pode iniciar somente o projeto declarado no token", () => {
    const token = raiz.forUser(101, "novo-projeto");
    expect(token.listarProjetos()).toEqual([]);
    const projeto = token.criarProjeto({ nome: "Novo projeto", pedido: "semente" });
    expect(ana.projetoPorSlug("novo-projeto")?.id).toBe(projeto.id);
    expect(() => token.criarProjeto({ nome: "Outro projeto" })).toThrow(ErroDeUso);
    expect(() => raiz.forUser(101, "../escape")).toThrow(ErroDeUso);
  });
});

describe("adoção e migração dos dados locais", () => {
  it("adota somente os registros de usuário zero, uma única vez", () => {
    const legado = raiz.criarProjeto({ nome: "Legado" });
    const skillLegada = raiz.criarDocumento({ tipo: "skill", titulo: "Legada", conteudo: "legado" });
    raiz.gravarArquivo(skillLegada.id, { caminho: "foto.png", conteudo: Buffer.from([0, 2, 255]), binario: true });
    raiz.selecionar(legado.id, skillLegada.id);
    const projetoBruno = bruno.criarProjeto({ nome: "Outro" });
    const documentoBruno = bruno.criarDocumento({ projetoId: projetoBruno.id, tipo: "documentacao", titulo: "Guia", conteudo: "Bruno" });

    expect(raiz.adotarLegado(101)).toBe(true);
    expect(raiz.listarProjetos()).toEqual([]);
    expect(ana.projetoPorSlug("legado")?.id).toBe(legado.id);
    expect(ana.idsSelecionados(legado.id)).toEqual([skillLegada.id]);
    expect(ana.arquivo(skillLegada.id, "foto.png")?.conteudo).toEqual(Buffer.from([0, 2, 255]));
    expect(bruno.documentoPorId(documentoBruno.id)?.conteudo).toBe("Bruno");
    expect(ana.documentoPorId(documentoBruno.id)).toBeNull();
    const novoLegado = raiz.criarProjeto({ nome: "Não adotar depois" });
    expect(raiz.adotarLegado(202)).toBe(false);
    expect(bruno.projetoPorSlug(novoLegado.slug)).toBeNull();
    expect(raiz.projetoPorSlug(novoLegado.slug)?.id).toBe(novoLegado.id);
    expect(() => ana.adotarLegado(202)).toThrow(ErroDeUso);
  });

  it("a adoção compõe com a transação de cadastro e volta inteira em rollback", () => {
    const legado = raiz.criarProjeto({ nome: "Legado" });
    raiz.banco.exec("BEGIN IMMEDIATE");
    expect(raiz.adotarLegado(101)).toBe(true);
    expect(ana.projetoPorSlug("legado")?.id).toBe(legado.id);
    raiz.banco.exec("ROLLBACK");
    expect(ana.projetoPorSlug("legado")).toBeNull();
    expect(raiz.projetoPorSlug("legado")?.id).toBe(legado.id);
    expect(raiz.adotarLegado(202)).toBe(true);
    expect(bruno.projetoPorSlug("legado")?.id).toBe(legado.id);
  });

  it("uma colisão aborta a adoção inteira e não marca o legado como adotado", () => {
    const projeto = raiz.criarProjeto({ nome: "Legado" });
    const legado = raiz.criarDocumento({ tipo: "skill", titulo: "Design", conteudo: "legado" });
    const existente = ana.criarDocumento({ tipo: "skill", titulo: "Design", conteudo: "Ana" });
    expect(() => raiz.adotarLegado(101)).toThrow();
    expect(raiz.projetoPorSlug("legado")?.id).toBe(projeto.id);
    expect(raiz.documentoPorId(legado.id)?.conteudo).toBe("legado");
    expect(ana.projetoPorSlug("legado")).toBeNull();
    expect(ana.documentoPorId(existente.id)?.conteudo).toBe("Ana");
    expect(raiz.adotarLegado(202)).toBe(true);
    expect(bruno.projetoPorSlug("legado")?.id).toBe(projeto.id);
    expect(bruno.documentoPorId(legado.id)?.conteudo).toBe("legado");
  });

  it("migra o UNIQUE global preservando IDs, metadados, seleções, binários e autoincremento", () => {
    const diretorio = mkdtempSync(join(tmpdir(), "doc-center-tenancy-"));
    temporarios.push(diretorio);
    const file = join(diretorio, "legacy.db");
    const legado = new DatabaseSync(file);
    // O esquema anterior à propriedade por usuário, incluindo a vitrine e as
    // memórias da última versão local. A restrição global precisa desaparecer.
    const schemaAnterior = SCHEMA
      .replaceAll("  usuario_id  INTEGER NOT NULL DEFAULT 0,\n", "")
      .replace("  slug        TEXT NOT NULL,", "  slug        TEXT NOT NULL UNIQUE,")
      .replace("  alterado_em TEXT NOT NULL,\n  UNIQUE (usuario_id, slug)", "  alterado_em TEXT NOT NULL");
    legado.exec(schemaAnterior);
    for (const coluna of COLUNAS_NOVAS.filter((coluna) => coluna.coluna !== "usuario_id")) {
      const existentes = legado.prepare(`PRAGMA table_info(${coluna.tabela})`).all() as unknown as { name: string }[];
      if (existentes.some((existente) => existente.name === coluna.coluna)) continue;
      legado.exec(`ALTER TABLE ${coluna.tabela} ADD COLUMN ${coluna.coluna} ${coluna.definicao}`);
    }
    legado.exec(`
      CREATE UNIQUE INDEX documentos_unicos ON documentos (IFNULL(projeto_id, 0), tipo, slug);
      INSERT INTO projetos (id, slug, nome, descricao, pedido, criado_em, alterado_em)
        VALUES (7, 'legado', 'Legado', 'descrição', 'pedido salvo', 'antes', 'depois');
      INSERT INTO projetos (id, slug, nome, criado_em, alterado_em) VALUES (19, 'apagado', 'Apagado', 'antes', 'depois');
      DELETE FROM projetos WHERE id = 19;
      INSERT INTO documentos (id, projeto_id, tipo, slug, titulo, conteudo, descricao, categoria, gatilhos, restricoes, area, versao, fonte, criado_em, alterado_em)
        VALUES (11, NULL, 'skill', 'design', 'Design', 'corpo', 'vitrine', 'categoria', 'gatilho', 'restrição', 'frontend', '2.0', 'fonte', 'antes', 'depois');
      INSERT INTO documentos (id, projeto_id, tipo, slug, titulo, conteudo, status, natureza, procedencia, criado_em, alterado_em)
        VALUES (12, 7, 'memoria', 'estado-atual', 'Estado', 'estado salvo', 'rascunho', 'estado', 'run-1', 'antes', 'depois');
      INSERT INTO selecoes (projeto_id, documento_id, criado_em) VALUES (7, 11, 'antes');
    `);
    legado.prepare("INSERT INTO arquivos (id, documento_id, caminho, conteudo, binario, criado_em) VALUES (17, 11, 'tela.png', ?, 1, 'antes')")
      .run(Buffer.from([0, 255, 1]));
    legado.close();

    const migrado = new Store({ file });
    conexoes.push(migrado);
    expect(migrado.projetoPorSlug("legado")).toMatchObject({ id: 7, pedido: "pedido salvo", criadoEm: "antes", alteradoEm: "depois" });
    expect(migrado.documentoPorId(11)).toMatchObject({
      id: 11, conteudo: "corpo", descricao: "vitrine", categoria: "categoria", gatilhos: "gatilho", restricoes: "restrição",
      area: "frontend", versao: "2.0", fonte: "fonte", arquivos: [{ id: 17, caminho: "tela.png", binario: true, tamanho: 3 }],
    });
    expect(migrado.documentoPorId(12)).toMatchObject({ projetoId: 7, status: "rascunho", natureza: "estado", procedencia: "run-1" });
    expect(migrado.idsSelecionados(7)).toEqual([11]);
    expect(migrado.arquivo(11, "tela.png")?.conteudo).toEqual(Buffer.from([0, 255, 1]));
    expect(migrado.criarProjeto({ nome: "Próximo" }).id).toBe(20);
    expect(migrado.adotarLegado(101)).toBe(true);
    const conta = migrado.forUser(101);
    expect(conta.projetoPorSlug("legado")?.id).toBe(7);
    expect(conta.listarDoProjeto(7)).toHaveLength(2);
    expect(migrado.forUser(202).criarProjeto({ nome: "Legado" }).id).toBe(21);
    expect(migrado.forUser(202).criarDocumento({ tipo: "skill", titulo: "Design", conteudo: "outro usuário" }).id).toBeGreaterThan(12);
    conta.removerProjeto("legado");
    expect(conta.documentoPorId(12)).toBeNull();
    expect(conta.documentoPorId(11)).not.toBeNull();
    expect(migrado.banco.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrado.close();
    conexoes.splice(conexoes.indexOf(migrado), 1);

    const reaberto = new Store({ file });
    conexoes.push(reaberto);
    expect(reaberto.forUser(202).projetoPorSlug("legado")?.id).toBe(21);
    expect(reaberto.forUser(101).arquivo(11, "tela.png")?.conteudo).toEqual(Buffer.from([0, 255, 1]));
    expect(reaberto.adotarLegado(202)).toBe(false);
  });
});
