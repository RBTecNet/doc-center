/**
 * O acesso ao banco, num lugar só.
 *
 * Toda leitura e escrita passa por aqui — a web e o MCP são duas portas para o
 * mesmo dado, e duas portas com SQL próprio divergem no dia em que uma regra
 * muda. É a mesma razão pela qual o harness mantém a gramática do plano num
 * módulo só.
 *
 * `node:sqlite` é do próprio Node: a aplicação inteira roda sem instalar nada.
 */

import { DatabaseSync } from "node:sqlite";
import { COLUNAS_NOVAS, SCHEMA, SEM_CATEGORIA, acumula, areaValida, comoSlug, type ArquivoDoDocumento, type Documento, type Projeto } from "./schema.js";

/**
 * Erro de quem usou, não do servidor.
 *
 * "Já existe uma skill com esse nome" é uma resposta legítima a um pedido
 * legítimo, e responder 500 a ela faz o operador procurar defeito no lugar
 * errado — e um monitor futuro contar falha onde não houve.
 */
export class ErroDeUso extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErroDeUso";
  }
}

export interface StoreOptions {
  /** Caminho do arquivo, ou `:memory:` nos testes. */
  file: string;
  now?: () => string;
}

interface LinhaProjeto {
  id: number;
  slug: string;
  nome: string;
  descricao: string;
  pedido: string;
  criado_em: string;
  alterado_em: string;
}

interface LinhaDocumento {
  id: number;
  projeto_id: number | null;
  tipo: string;
  slug: string;
  titulo: string;
  conteudo: string;
  descricao: string;
  categoria: string;
  gatilhos: string;
  restricoes: string;
  area: string;
  versao: string;
  fonte: string;
  status: string;
  natureza: string;
  procedencia: string;
  criado_em: string;
  alterado_em: string;
}

interface LinhaArquivo {
  id: number;
  documento_id: number;
  caminho: string;
  conteudo: Buffer | Uint8Array;
  binario: number;
  criado_em: string;
}

const comoProjeto = (linha: LinhaProjeto): Projeto => ({
  id: linha.id,
  slug: linha.slug,
  nome: linha.nome,
  descricao: linha.descricao,
  pedido: linha.pedido,
  criadoEm: linha.criado_em,
  alteradoEm: linha.alterado_em,
});

const comoDocumento = (linha: LinhaDocumento): Documento => ({
  id: linha.id,
  projetoId: linha.projeto_id,
  tipo: linha.tipo,
  slug: linha.slug,
  titulo: linha.titulo,
  conteudo: linha.conteudo,
  descricao: linha.descricao ?? "",
  categoria: linha.categoria ?? "",
  gatilhos: linha.gatilhos ?? "",
  restricoes: linha.restricoes ?? "",
  area: linha.area ?? "geral",
  versao: linha.versao ?? "",
  fonte: linha.fonte ?? "",
  status: linha.status ?? "ativo",
  natureza: linha.natureza ?? "",
  procedencia: linha.procedencia ?? "",
  criadoEm: linha.criado_em,
  alteradoEm: linha.alterado_em,
});

export class Store {
  private readonly db: DatabaseSync;
  private readonly agora: () => string;

  constructor(options: StoreOptions) {
    this.db = new DatabaseSync(options.file);
    // Chave estrangeira não vem ligada por padrão no SQLite, e sem ela o ON
    // DELETE CASCADE das seleções é decoração: apagar um projeto deixaria
    // seleções órfãs apontando para nada.
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrar();
    this.agora = options.now ?? (() => new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  /** Acrescenta o que falta num banco que já existia. Idempotente por natureza. */
  private migrar(): void {
    for (const { tabela, coluna, definicao } of COLUNAS_NOVAS) {
      const colunas = this.db.prepare(`PRAGMA table_info(${tabela})`).all() as unknown as { name: string }[];
      if (colunas.some((existente) => existente.name === coluna)) continue;
      this.db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    }
  }

  // ---------------------------------------------------------------- projetos

  listarProjetos(): Projeto[] {
    const linhas = this.db.prepare("SELECT * FROM projetos ORDER BY nome").all() as unknown as LinhaProjeto[];
    return linhas.map(comoProjeto);
  }

  projetoPorSlug(slug: string): Projeto | null {
    const linha = this.db.prepare("SELECT * FROM projetos WHERE slug = ?").get(slug) as unknown as LinhaProjeto | undefined;
    return linha ? comoProjeto(linha) : null;
  }

  criarProjeto(entrada: { nome: string; slug?: string; descricao?: string; pedido?: string }): Projeto {
    const slug = comoSlug(entrada.slug || entrada.nome);
    if (slug === "") throw new ErroDeUso("o projeto precisa de um nome que vire slug");
    if (this.projetoPorSlug(slug)) throw new ErroDeUso(`já existe um projeto com o slug "${slug}"`);

    const instante = this.agora();
    this.db
      .prepare("INSERT INTO projetos (slug, nome, descricao, pedido, criado_em, alterado_em) VALUES (?, ?, ?, ?, ?, ?)")
      .run(slug, entrada.nome, entrada.descricao ?? "", entrada.pedido ?? "", instante, instante);
    return this.projetoPorSlug(slug)!;
  }

  atualizarProjeto(slug: string, campos: { nome?: string; descricao?: string; pedido?: string }): Projeto {
    const atual = this.projetoPorSlug(slug);
    if (!atual) throw new ErroDeUso(`projeto "${slug}" não existe`);

    this.db
      .prepare("UPDATE projetos SET nome = ?, descricao = ?, pedido = ?, alterado_em = ? WHERE slug = ?")
      .run(campos.nome ?? atual.nome, campos.descricao ?? atual.descricao, campos.pedido ?? atual.pedido, this.agora(), slug);
    return this.projetoPorSlug(slug)!;
  }

  removerProjeto(slug: string): void {
    this.db.prepare("DELETE FROM projetos WHERE slug = ?").run(slug);
  }

  // -------------------------------------------------------------- documentos

  /** A área geral: o acervo do qual os projetos escolhem. */
  listarGerais(): Documento[] {
    const linhas = this.db
      .prepare("SELECT * FROM documentos WHERE projeto_id IS NULL ORDER BY tipo, titulo")
      .all() as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  /** Os documentos que nasceram dentro do projeto. */
  listarProprios(projetoId: number): Documento[] {
    const linhas = this.db
      .prepare("SELECT * FROM documentos WHERE projeto_id = ? ORDER BY tipo, titulo")
      .all(projetoId) as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  /**
   * Tudo que um projeto USA: o que é dele mais o que ele selecionou da geral.
   *
   * É esta lista — e só ela — que o MCP expõe sob o projeto. O harness pede "o
   * material deste projeto" e recebe exatamente o que alguém escolheu para ele.
   */
  listarDoProjeto(projetoId: number): Documento[] {
    const linhas = this.db
      .prepare(
        `SELECT d.* FROM documentos d WHERE d.projeto_id = ?
         UNION
         SELECT d.* FROM documentos d
           JOIN selecoes s ON s.documento_id = d.id
          WHERE s.projeto_id = ?
         ORDER BY tipo, titulo`,
      )
      .all(projetoId, projetoId) as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  documento(projetoId: number | null, tipo: string, slug: string): Documento | null {
    const linha = this.db
      .prepare("SELECT * FROM documentos WHERE IFNULL(projeto_id, 0) = IFNULL(?, 0) AND tipo = ? AND slug = ?")
      .get(projetoId, tipo, slug) as unknown as LinhaDocumento | undefined;
    return linha ? comoDocumento(linha) : null;
  }

  documentoPorId(id: number): Documento | null {
    const linha = this.db.prepare("SELECT * FROM documentos WHERE id = ?").get(id) as unknown as LinhaDocumento | undefined;
    if (!linha) return null;
    const documento = comoDocumento(linha);
    const arquivos = this.arquivos(documento.id);
    return arquivos.length > 0 ? { ...documento, arquivos } : documento;
  }

  criarDocumento(entrada: {
    projetoId?: number | null;
    tipo: string;
    titulo: string;
    slug?: string;
    conteudo: string;
    descricao?: string;
    categoria?: string;
    gatilhos?: string;
    restricoes?: string;
    area?: string;
    versao?: string;
    fonte?: string;
    status?: string;
    natureza?: string;
    procedencia?: string;
    /** Os arquivos que acompanham a base, quando o documento veio de um pacote. */
    arquivos?: { caminho: string; conteudo: Buffer; binario: boolean }[];
  }): Documento {
    const slug = comoSlug(entrada.slug || entrada.titulo);
    if (slug === "") throw new ErroDeUso("o documento precisa de um título que vire slug");

    const projetoId = entrada.projetoId ?? null;
    if (this.documento(projetoId, entrada.tipo, slug)) {
      throw new ErroDeUso(`já existe um documento ${entrada.tipo}/${slug} ${projetoId === null ? "na área geral" : "neste projeto"}`);
    }

    const instante = this.agora();
    this.db
      .prepare(
        "INSERT INTO documentos (projeto_id, tipo, slug, titulo, conteudo, descricao, categoria, gatilhos, restricoes, area, versao, fonte, status, natureza, procedencia, criado_em, alterado_em)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        projetoId,
        entrada.tipo,
        slug,
        entrada.titulo,
        entrada.conteudo,
        entrada.descricao ?? "",
        entrada.categoria ?? "",
        entrada.gatilhos ?? "",
        entrada.restricoes ?? "",
        areaValida(entrada.area ?? "geral"),
        entrada.versao ?? "",
        entrada.fonte ?? "",
        entrada.status ?? "ativo",
        entrada.natureza ?? "",
        entrada.procedencia ?? "",
        instante,
        instante,
      );

    const criado = this.documento(projetoId, entrada.tipo, slug)!;
    for (const arquivo of entrada.arquivos ?? []) this.gravarArquivo(criado.id, arquivo);
    return criado;
  }

  atualizarDocumento(
    id: number,
    campos: {
      titulo?: string;
      conteudo?: string;
      descricao?: string;
      categoria?: string;
      gatilhos?: string;
      restricoes?: string;
      area?: string;
    },
  ): Documento {
    const atual = this.documentoPorId(id);
    if (!atual) throw new ErroDeUso(`documento ${id} não existe`);

    this.db
      .prepare(
        "UPDATE documentos SET titulo = ?, conteudo = ?, descricao = ?, categoria = ?, gatilhos = ?, restricoes = ?, area = ?, alterado_em = ? WHERE id = ?",
      )
      .run(
        campos.titulo ?? atual.titulo,
        campos.conteudo ?? atual.conteudo,
        campos.descricao ?? atual.descricao,
        campos.categoria ?? atual.categoria,
        campos.gatilhos ?? atual.gatilhos,
        campos.restricoes ?? atual.restricoes,
        campos.area === undefined ? atual.area : areaValida(campos.area),
        this.agora(),
        id,
      );
    return this.documentoPorId(id)!;
  }

  /**
   * As categorias de um tipo, com quantos há em cada — o filtro do catálogo.
   *
   * Sai do banco em vez de ser uma lista fixa: quem cadastra uma skill inventa a
   * categoria que precisa, e uma lista fechada obrigaria a mexer no código para
   * cada área nova que aparecer.
   */
  categorias(tipo: string): { categoria: string; quantos: number }[] {
    const linhas = this.db
      .prepare(
        "SELECT CASE WHEN TRIM(categoria) = '' THEN ? ELSE categoria END AS categoria, COUNT(*) AS quantos" +
          " FROM documentos WHERE projeto_id IS NULL AND tipo = ? GROUP BY 1 ORDER BY 1",
      )
      .all(SEM_CATEGORIA, tipo) as unknown as { categoria: string; quantos: number }[];
    return linhas;
  }

  removerDocumento(id: number): void {
    this.db.prepare("DELETE FROM documentos WHERE id = ?").run(id);
  }

  // ---------------------------------------------------------------- memórias

  /**
   * Registra uma memória do projeto, vinda de um run.
   *
   * Duas regras, e as duas vêm da natureza:
   *
   * **Estado substitui.** Há um por projeto, e ele é reescrito. Guardar
   * histórico de estado produziria uma pilha de verdades vencidas, e quem
   * lesse a mais antiga trabalharia sobre o que já não é.
   *
   * **O resto acumula, sem duplicar.** Mesma natureza e mesmo título é a mesma
   * memória: o run seguinte a atualiza em vez de criar a segunda cópia — senão
   * cada execução multiplicaria o acervo do projeto.
   */
  registrarMemoria(entrada: {
    projetoId: number;
    natureza: string;
    titulo: string;
    conteudo: string;
    procedencia?: string;
    status?: string;
  }): Documento {
    const status = entrada.status ?? "rascunho";
    const slug = acumula(entrada.natureza) ? comoSlug(entrada.titulo) : "estado-atual";
    const instante = this.agora();

    const existente = this.documento(entrada.projetoId, "memoria", slug);
    if (existente) {
      this.db
        .prepare(
          "UPDATE documentos SET titulo = ?, conteudo = ?, natureza = ?, procedencia = ?, status = ?, alterado_em = ? WHERE id = ?",
        )
        .run(entrada.titulo, entrada.conteudo, entrada.natureza, entrada.procedencia ?? "", status, instante, existente.id);
      return this.documentoPorId(existente.id)!;
    }

    return this.criarDocumento({
      projetoId: entrada.projetoId,
      tipo: "memoria",
      titulo: entrada.titulo,
      slug,
      conteudo: entrada.conteudo,
      natureza: entrada.natureza,
      procedencia: entrada.procedencia ?? "",
      status,
    });
  }

  /** As memórias de um projeto, de todas as naturezas. */
  memorias(projetoId: number): Documento[] {
    const linhas = this.db
      .prepare("SELECT * FROM documentos WHERE projeto_id = ? AND tipo = 'memoria' ORDER BY natureza, titulo")
      .all(projetoId) as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  /** O que espera aprovação, do projeto ou de todos. */
  rascunhos(projetoId?: number): Documento[] {
    const linhas =
      projetoId === undefined
        ? (this.db.prepare("SELECT * FROM documentos WHERE status = 'rascunho' ORDER BY alterado_em DESC").all() as unknown as LinhaDocumento[])
        : (this.db
            .prepare("SELECT * FROM documentos WHERE status = 'rascunho' AND projeto_id = ? ORDER BY alterado_em DESC")
            .all(projetoId) as unknown as LinhaDocumento[]);
    return linhas.map(comoDocumento);
  }

  aprovar(id: number): void {
    this.db.prepare("UPDATE documentos SET status = 'ativo', alterado_em = ? WHERE id = ?").run(this.agora(), id);
  }

  // ---------------------------------------------------------------- arquivos

  /**
   * Grava um arquivo do pacote.
   *
   * Reimportar a mesma skill substitui o arquivo em vez de duplicá-lo: o par
   * documento + caminho é único, e uma skill atualizada é a mesma skill.
   */
  gravarArquivo(documentoId: number, arquivo: { caminho: string; conteudo: Buffer; binario: boolean }): void {
    this.db
      .prepare(
        "INSERT INTO arquivos (documento_id, caminho, conteudo, binario, criado_em) VALUES (?, ?, ?, ?, ?)" +
          " ON CONFLICT (documento_id, caminho) DO UPDATE SET conteudo = excluded.conteudo, binario = excluded.binario",
      )
      .run(documentoId, arquivo.caminho, arquivo.conteudo, arquivo.binario ? 1 : 0, this.agora());
  }

  /** Os arquivos de um documento, sem o conteúdo: listar não precisa carregar. */
  arquivos(documentoId: number): ArquivoDoDocumento[] {
    const linhas = this.db
      .prepare("SELECT id, caminho, binario, LENGTH(conteudo) AS tamanho FROM arquivos WHERE documento_id = ? ORDER BY caminho")
      .all(documentoId) as unknown as { id: number; caminho: string; binario: number; tamanho: number }[];
    return linhas.map((linha) => ({ id: linha.id, caminho: linha.caminho, binario: linha.binario === 1, tamanho: linha.tamanho }));
  }

  /** O conteúdo de um arquivo, pelo caminho. Nulo quando não existe. */
  arquivo(documentoId: number, caminho: string): { conteudo: Buffer; binario: boolean } | null {
    const linha = this.db
      .prepare("SELECT conteudo, binario FROM arquivos WHERE documento_id = ? AND caminho = ?")
      .get(documentoId, caminho) as unknown as { conteudo: Buffer | Uint8Array; binario: number } | undefined;
    return linha ? { conteudo: Buffer.from(linha.conteudo), binario: linha.binario === 1 } : null;
  }

  removerArquivos(documentoId: number): void {
    this.db.prepare("DELETE FROM arquivos WHERE documento_id = ?").run(documentoId);
  }

  // ---------------------------------------------------------------- seleções

  /**
   * O projeto passa a usar um documento da área geral.
   *
   * Selecionar um documento que já é do projeto não faz sentido e seria uma
   * linha que ninguém lê: o `listarDoProjeto` já o traz por ser dele.
   */
  selecionar(projetoId: number, documentoId: number): void {
    const documento = this.documentoPorId(documentoId);
    if (!documento) throw new ErroDeUso(`documento ${documentoId} não existe`);
    if (documento.projetoId !== null) {
      throw new ErroDeUso("só documentos da área geral são selecionados; os do próprio projeto já estão nele");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO selecoes (projeto_id, documento_id, criado_em) VALUES (?, ?, ?)")
      .run(projetoId, documentoId, this.agora());
  }

  desselecionar(projetoId: number, documentoId: number): void {
    this.db.prepare("DELETE FROM selecoes WHERE projeto_id = ? AND documento_id = ?").run(projetoId, documentoId);
  }

  idsSelecionados(projetoId: number): number[] {
    const linhas = this.db
      .prepare("SELECT documento_id FROM selecoes WHERE projeto_id = ?")
      .all(projetoId) as unknown as { documento_id: number }[];
    return linhas.map((linha) => linha.documento_id);
  }
}
