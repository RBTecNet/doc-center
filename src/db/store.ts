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
import { COLUNAS_NOVAS, PAPEIS_HISTORICO, SCHEMA, SEM_CATEGORIA, acumula, areaValida, comoSlug, type ArquivoDoDocumento, type Documento, type EntradaHistorico, type PapelHistorico, type Projeto } from "./schema.js";

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
  usuario_id: number;
  slug: string;
  nome: string;
  descricao: string;
  pedido: string;
  repositorio: string;
  criado_em: string;
  alterado_em: string;
}

interface LinhaDocumento {
  id: number;
  usuario_id: number;
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

interface ContextoCompartilhado {
  db: DatabaseSync;
  agora: () => string;
  usuarioId: number;
  projetoSlug: string | undefined;
}

interface LinhaHistorico {
  id: number;
  projeto_id: number;
  evento_id: string;
  origem: string;
  sessao: string;
  papel: PapelHistorico;
  conteudo: string | Uint8Array;
  modelo: string;
  maquina: string;
  criado_em: string;
  registrado_em: string;
  metadados: string;
}

export interface RegistroHistorico {
  eventoId: string;
  origem: string;
  sessao: string;
  papel: PapelHistorico;
  conteudo: string;
  modelo?: string;
  maquina?: string;
  criadoEm?: string;
  metadados?: string;
}

/** HTTPS e SSH identificam o mesmo repositório; nunca persistimos segredos. */
function repositorioCanonico(valor: string | undefined): string {
  if (valor === undefined || valor === "") return "";
  if (typeof valor !== "string" || valor.length > 2048 || /[\x00-\x20\x7f\\]/.test(valor) || /^[A-Za-z]:\//.test(valor)) {
    throw new ErroDeUso("informe um repositório Git remoto válido, sem caminho local");
  }
  const scp = /^(?:[^@\s/:]+@)?(\[[^\]]+\]|[^/:@\s]+):(.+)$/.exec(valor);
  let url: URL;
  try { url = new URL(scp && !valor.includes("://") ? `ssh://${scp[1]}/${scp[2]}` : valor); }
  catch { throw new ErroDeUso("informe um repositório Git remoto válido, sem caminho local"); }
  if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) {
    throw new ErroDeUso("informe um repositório Git remoto HTTP(S) ou SSH");
  }
  const caminho = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (caminho === "" || caminho === "/") throw new ErroDeUso("o repositório remoto precisa de um caminho");
  // Portas SSH identificam o transporte, não o endereço HTTPS portátil.
  const host = url.protocol === "ssh:" || url.protocol === "git:" ? url.hostname : url.host;
  return `https://${host}${caminho}`;
}

function identificadorHistorico(valor: string, nome: string, opcional = false): string {
  if (typeof valor !== "string" || valor.length > 256 || valor.trim() !== valor || /[\x00-\x1f\x7f]/.test(valor) || (!opcional && valor === "")) {
    throw new ErroDeUso(`${nome} precisa ser um texto ${opcional ? "de até" : "de 1 a"} 256 caracteres, sem controles`);
  }
  return valor;
}

function instanteHistorico(valor: string): string {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(valor)) {
    throw new ErroDeUso("criadoEm precisa ser uma data ISO 8601 com fuso horário");
  }
  const instante = new Date(valor);
  const data = valor.slice(0, 10);
  const [ano, mes, dia] = data.split("-").map(Number) as [number, number, number];
  const calendario = new Date(`${data}T00:00:00Z`);
  if (Number.isNaN(instante.getTime()) || calendario.getUTCFullYear() !== ano || calendario.getUTCMonth() + 1 !== mes || calendario.getUTCDate() !== dia || Number(valor.slice(11, 13)) > 23) {
    throw new ErroDeUso("criadoEm precisa ser uma data ISO 8601 válida");
  }
  return instante.toISOString();
}

function limiteHistorico(valor: number | undefined, padrao: number): number {
  if (valor === undefined) return padrao;
  if (!Number.isSafeInteger(valor) || valor < 1) throw new ErroDeUso("limite precisa ser um inteiro positivo");
  return Math.min(valor, 500);
}

const ORCAMENTO_HISTORICO = 4 * 1024 * 1024;

// O node:sqlite corta a leitura de TEXT no primeiro NUL. O SQLite armazena
// todos os bytes; a projeção BLOB preserva inclusive mensagens já gravadas.
const COLUNAS_HISTORICO = `id, projeto_id, evento_id, origem, sessao, papel,
  CAST(conteudo AS BLOB) AS conteudo, modelo, maquina, criado_em, registrado_em, metadados`;

const conteudoHistorico = (linha: LinhaHistorico): string =>
  typeof linha.conteudo === "string" ? linha.conteudo : Buffer.from(linha.conteudo).toString("utf8");

const comoHistorico = (linha: LinhaHistorico): EntradaHistorico => ({
  id: linha.id,
  projetoId: linha.projeto_id,
  eventoId: linha.evento_id,
  origem: linha.origem,
  sessao: linha.sessao,
  papel: linha.papel,
  conteudo: conteudoHistorico(linha),
  modelo: linha.modelo,
  maquina: linha.maquina,
  criadoEm: linha.criado_em,
  registradoEm: linha.registrado_em,
  ...(linha.metadados === "" ? {} : { metadados: linha.metadados }),
});

const comoProjeto = (linha: LinhaProjeto): Projeto => ({
  id: linha.id,
  slug: linha.slug,
  nome: linha.nome,
  descricao: linha.descricao,
  pedido: linha.pedido,
  repositorio: linha.repositorio ?? "",
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
  private readonly usuarioId: number;
  private readonly projetoSlug: string | undefined;
  private readonly donoDaConexao: boolean;

  constructor(options: StoreOptions, compartilhado?: ContextoCompartilhado) {
    this.usuarioId = compartilhado?.usuarioId ?? 0;
    this.projetoSlug = compartilhado?.projetoSlug;
    this.donoDaConexao = compartilhado === undefined;
    this.agora = compartilhado?.agora ?? options.now ?? (() => new Date().toISOString());
    if (compartilhado) {
      this.db = compartilhado.db;
      return;
    }
    this.db = new DatabaseSync(options.file);
    // Chave estrangeira não vem ligada por padrão no SQLite, e sem ela o ON
    // DELETE CASCADE das seleções é decoração: apagar um projeto deixaria
    // seleções órfãs apontando para nada.
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrar();
  }

  close(): void {
    if (this.donoDaConexao) this.db.close();
  }

  /** Acesso exclusivo da infraestrutura confiável de autenticação. */
  get banco(): DatabaseSync {
    return this.db;
  }

  /** Uma visão imutável por requisição; nunca muda o usuário de outra visão. */
  forUser(usuarioId: number, projetoSlug?: string): Store {
    if (!Number.isSafeInteger(usuarioId) || usuarioId <= 0) throw new ErroDeUso("usuário inválido");
    if (projetoSlug !== undefined && (projetoSlug === "" || comoSlug(projetoSlug) !== projetoSlug)) {
      throw new ErroDeUso("slug de projeto inválido");
    }
    if (this.usuarioId !== 0 && this.usuarioId !== usuarioId) throw new ErroDeUso("usuário fora do escopo");
    if (this.projetoSlug !== undefined && this.projetoSlug !== projetoSlug) throw new ErroDeUso("projeto fora do escopo");
    return new Store({ file: "" }, { db: this.db, agora: this.agora, usuarioId, projetoSlug });
  }

  /** A primeira conta recebe somente os registros que ainda são locais. */
  adotarLegado(usuarioId: number): boolean {
    if (this.usuarioId !== 0 || this.projetoSlug !== undefined || !Number.isSafeInteger(usuarioId) || usuarioId <= 0) {
      throw new ErroDeUso("adoção dos dados locais exige a primeira conta válida");
    }
    // SAVEPOINT compõe com a transação que cria a conta: nenhuma parte fica
    // adotada se o cadastro falhar depois.
    this.db.exec("SAVEPOINT adotar_legado");
    try {
      if (this.db.prepare("SELECT 1 FROM doc_center_metadados WHERE chave = 'legado_adotado_por'").get()) {
        this.db.exec("RELEASE adotar_legado");
        return false;
      }
      this.db.prepare("UPDATE projetos SET usuario_id = ? WHERE usuario_id = 0").run(usuarioId);
      this.db.prepare("UPDATE documentos SET usuario_id = ? WHERE usuario_id = 0").run(usuarioId);
      this.db.prepare("INSERT INTO doc_center_metadados (chave, valor) VALUES ('legado_adotado_por', ?)").run(String(usuarioId));
      this.db.exec("RELEASE adotar_legado");
      return true;
    } catch (erro) {
      this.db.exec("ROLLBACK TO adotar_legado; RELEASE adotar_legado");
      throw erro;
    }
  }

  /** Acrescenta o que falta num banco que já existia. Idempotente por natureza. */
  private migrar(): void {
    for (const { tabela, coluna, definicao } of COLUNAS_NOVAS) {
      const colunas = this.db.prepare(`PRAGMA table_info(${tabela})`).all() as unknown as { name: string }[];
      if (colunas.some((existente) => existente.name === coluna)) continue;
      this.db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    }

    const indices = this.db.prepare("PRAGMA index_list(projetos)").all() as unknown as { name: string; unique: number }[];
    const slugGlobal = indices.some((indice) => {
      if (indice.unique !== 1) return false;
      const colunas = this.db.prepare(`PRAGMA index_info('${indice.name.replaceAll("'", "''")}')`).all() as unknown as { name: string }[];
      return colunas.length === 1 && colunas[0]?.name === "slug";
    });

    // SQLite não remove o UNIQUE da definição de uma tabela. Reconstruímos
    // apenas o pai, com FKs suspensas antes da transação; os filhos e seus IDs
    // permanecem intactos, sem disparar ON DELETE CASCADE durante a migração.
    this.db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      if (slugGlobal) {
        const sequencia = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'projetos'").get() as { seq: number } | undefined;
        this.db.exec(`
          CREATE TABLE projetos_por_usuario (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario_id INTEGER NOT NULL DEFAULT 0,
            slug TEXT NOT NULL,
            nome TEXT NOT NULL,
            descricao TEXT NOT NULL DEFAULT '',
            pedido TEXT NOT NULL DEFAULT '',
            repositorio TEXT NOT NULL DEFAULT '',
            criado_em TEXT NOT NULL,
            alterado_em TEXT NOT NULL,
            UNIQUE (usuario_id, slug)
          );
          INSERT INTO projetos_por_usuario (id, usuario_id, slug, nome, descricao, pedido, repositorio, criado_em, alterado_em)
            SELECT id, usuario_id, slug, nome, descricao, pedido, repositorio, criado_em, alterado_em FROM projetos;
          DROP TABLE projetos;
          ALTER TABLE projetos_por_usuario RENAME TO projetos;
        `);
        if (sequencia) {
          const atualizado = this.db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'projetos'").run(sequencia.seq);
          if (atualizado.changes === 0) this.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('projetos', ?)").run(sequencia.seq);
        }
      }
      const colunasDoIndice = this.db.prepare("PRAGMA index_info(documentos_unicos)").all() as unknown as { name: string | null }[];
      if (colunasDoIndice.length > 0 && colunasDoIndice[0]?.name !== "usuario_id") this.db.exec("DROP INDEX documentos_unicos");
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS documentos_unicos ON documentos (usuario_id, IFNULL(projeto_id, 0), tipo, slug);
        CREATE INDEX IF NOT EXISTS projetos_por_dono ON projetos (usuario_id, slug);
        CREATE INDEX IF NOT EXISTS documentos_por_dono ON documentos (usuario_id, projeto_id);
      `);
      const violacoes = this.db.prepare("PRAGMA foreign_key_check").all();
      if (violacoes.length > 0) throw new Error("a migração encontrou referências inválidas no banco");
      this.db.exec("COMMIT");
    } catch (erro) {
      this.db.exec("ROLLBACK");
      throw erro;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  private projetoPermitido(projetoId: number): boolean {
    const linha = this.db.prepare("SELECT slug FROM projetos WHERE id = ? AND usuario_id = ?").get(projetoId, this.usuarioId) as { slug: string } | undefined;
    return linha !== undefined && (this.projetoSlug === undefined || linha.slug === this.projetoSlug);
  }

  private exigirProjeto(projetoId: number): void {
    if (!this.projetoPermitido(projetoId)) throw new ErroDeUso(`projeto ${projetoId} não existe`);
  }

  /** Inclui a propriedade do pai e, para tokens, somente o projeto vinculado. */
  private filtroDocumentos(alias = "d"): { sql: string; parametros: (string | number)[] } {
    if (this.projetoSlug === undefined) {
      return {
        sql: `${alias}.usuario_id = ? AND (${alias}.projeto_id IS NULL OR EXISTS (SELECT 1 FROM projetos p WHERE p.id = ${alias}.projeto_id AND p.usuario_id = ?))`,
        parametros: [this.usuarioId, this.usuarioId],
      };
    }
    return {
      sql: `${alias}.usuario_id = ? AND (
        EXISTS (SELECT 1 FROM projetos p WHERE p.id = ${alias}.projeto_id AND p.usuario_id = ? AND p.slug = ?)
        OR (${alias}.projeto_id IS NULL AND EXISTS (
          SELECT 1 FROM selecoes s JOIN projetos p ON p.id = s.projeto_id
          WHERE s.documento_id = ${alias}.id AND p.usuario_id = ? AND p.slug = ?
        )))`,
      parametros: [this.usuarioId, this.usuarioId, this.projetoSlug, this.usuarioId, this.projetoSlug],
    };
  }

  private linhaDocumento(id: number): LinhaDocumento | undefined {
    const filtro = this.filtroDocumentos();
    return this.db.prepare(`SELECT d.* FROM documentos d WHERE d.id = ? AND ${filtro.sql}`).get(id, ...filtro.parametros) as unknown as LinhaDocumento | undefined;
  }

  private exigirDocumentoGravavel(id: number): LinhaDocumento {
    const linha = this.linhaDocumento(id);
    if (!linha) throw new ErroDeUso(`documento ${id} não existe`);
    this.exigirDestino(linha.projeto_id, linha.tipo);
    return linha;
  }

  private exigirDestino(projetoId: number | null, tipo: string): void {
    if (projetoId !== null) this.exigirProjeto(projetoId);
    if (this.projetoSlug !== undefined && (projetoId === null || (tipo !== "memoria" && tipo !== "documentacao"))) {
      throw new ErroDeUso("token de projeto só pode escrever memórias e documentação do projeto vinculado");
    }
  }

  // ---------------------------------------------------------------- projetos

  listarProjetos(): Projeto[] {
    const linhas = this.db.prepare("SELECT * FROM projetos WHERE usuario_id = ? AND (? IS NULL OR slug = ?) ORDER BY nome")
      .all(this.usuarioId, this.projetoSlug ?? null, this.projetoSlug ?? null) as unknown as LinhaProjeto[];
    return linhas.map(comoProjeto);
  }

  projetoPorSlug(slug: string): Projeto | null {
    if (this.projetoSlug !== undefined && this.projetoSlug !== slug) return null;
    const linha = this.db.prepare("SELECT * FROM projetos WHERE usuario_id = ? AND slug = ?").get(this.usuarioId, slug) as unknown as LinhaProjeto | undefined;
    return linha ? comoProjeto(linha) : null;
  }

  /** Vincular uma CLI é idempotente e conserva o material já cadastrado. */
  garantirProjeto(entrada: { slug: string; nome?: string; repositorio?: string }): { projeto: Projeto; criado: boolean } {
    if (typeof entrada.slug !== "string" || entrada.slug === "" || comoSlug(entrada.slug) !== entrada.slug) {
      throw new ErroDeUso("informe um slug canônico de projeto");
    }
    if (this.projetoSlug !== undefined && this.projetoSlug !== entrada.slug) throw new ErroDeUso("projeto fora do escopo do token");
    if (entrada.nome !== undefined && (typeof entrada.nome !== "string" || entrada.nome.length > 256 || /[\x00-\x1f\x7f]/.test(entrada.nome))) {
      throw new ErroDeUso("o nome do projeto precisa ser um texto de até 256 caracteres, sem controles");
    }
    const repositorio = repositorioCanonico(entrada.repositorio);
    const nome = entrada.nome?.trim() || entrada.slug;
    const instante = this.agora();
    this.db.exec("SAVEPOINT garantir_projeto");
    try {
      const resultado = this.db.prepare(`INSERT INTO projetos (usuario_id, slug, nome, repositorio, criado_em, alterado_em)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (usuario_id, slug) DO NOTHING`)
        .run(this.usuarioId, entrada.slug, nome, repositorio, instante, instante);
      const atual = this.projetoPorSlug(entrada.slug)!;
      if (repositorio !== "" && atual.repositorio !== "" && atual.repositorio !== repositorio) {
        throw new ErroDeUso("o projeto já está vinculado a outro repositório; escolha outro slug em DOC_CENTER_PROJECT");
      }
      if (repositorio !== "" && atual.repositorio === "") {
        this.db.prepare("UPDATE projetos SET repositorio = ?, alterado_em = ? WHERE id = ? AND usuario_id = ? AND repositorio = ''")
          .run(repositorio, instante, atual.id, this.usuarioId);
      }
      const projeto = this.projetoPorSlug(entrada.slug)!;
      this.db.exec("RELEASE garantir_projeto");
      return { projeto, criado: resultado.changes !== 0 };
    } catch (erro) {
      this.db.exec("ROLLBACK TO garantir_projeto; RELEASE garantir_projeto");
      throw erro;
    }
  }

  criarProjeto(entrada: { nome: string; slug?: string; descricao?: string; pedido?: string }): Projeto {
    const slug = comoSlug(entrada.slug || entrada.nome);
    if (slug === "") throw new ErroDeUso("o projeto precisa de um nome que vire slug");
    if (this.projetoSlug !== undefined && this.projetoSlug !== slug) throw new ErroDeUso("projeto fora do escopo do token");
    if (this.projetoPorSlug(slug)) throw new ErroDeUso(`já existe um projeto com o slug "${slug}"`);

    const instante = this.agora();
    this.db
      .prepare("INSERT INTO projetos (usuario_id, slug, nome, descricao, pedido, criado_em, alterado_em) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.usuarioId, slug, entrada.nome, entrada.descricao ?? "", entrada.pedido ?? "", instante, instante);
    return this.projetoPorSlug(slug)!;
  }

  atualizarProjeto(slug: string, campos: { nome?: string; descricao?: string; pedido?: string }): Projeto {
    if (this.projetoSlug !== undefined) throw new ErroDeUso("token de projeto não pode editar o cadastro do projeto");
    const atual = this.projetoPorSlug(slug);
    if (!atual) throw new ErroDeUso(`projeto "${slug}" não existe`);

    this.db
      .prepare("UPDATE projetos SET nome = ?, descricao = ?, pedido = ?, alterado_em = ? WHERE usuario_id = ? AND id = ?")
      .run(campos.nome ?? atual.nome, campos.descricao ?? atual.descricao, campos.pedido ?? atual.pedido, this.agora(), this.usuarioId, atual.id);
    return this.projetoPorSlug(slug)!;
  }

  removerProjeto(slug: string): void {
    if (this.projetoSlug !== undefined) throw new ErroDeUso("token de projeto não pode excluir o projeto");
    if (this.usuarioId !== 0 && !this.projetoPorSlug(slug)) throw new ErroDeUso(`projeto "${slug}" não existe`);
    this.db.prepare("DELETE FROM projetos WHERE usuario_id = ? AND slug = ?").run(this.usuarioId, slug);
  }

  // ------------------------------------------------------- histórico de CLIs

  /** Acrescenta o evento original; uma retransmissão igual não cria outra linha. */
  registrarHistorico(projetoId: number, entrada: RegistroHistorico): { entrada: EntradaHistorico; criado: boolean } {
    this.exigirProjeto(projetoId);
    const eventoId = identificadorHistorico(entrada.eventoId, "eventoId");
    const origem = identificadorHistorico(entrada.origem, "origem");
    const sessao = identificadorHistorico(entrada.sessao, "sessao");
    if (!(PAPEIS_HISTORICO as readonly string[]).includes(entrada.papel)) throw new ErroDeUso("papel precisa ser user, assistant, tool ou system");
    if (typeof entrada.conteudo !== "string" || Buffer.byteLength(entrada.conteudo, "utf8") > 1024 * 1024) {
      throw new ErroDeUso("o conteúdo do evento precisa ser um texto de até 1 MiB");
    }
    const modelo = identificadorHistorico(entrada.modelo === undefined ? "" : entrada.modelo, "modelo", true);
    const maquina = identificadorHistorico(entrada.maquina === undefined ? "" : entrada.maquina, "maquina", true);
    const observado = entrada.criadoEm === undefined ? undefined : instanteHistorico(entrada.criadoEm);
    let metadados = entrada.metadados === undefined ? "" : entrada.metadados;
    if (typeof metadados !== "string" || Buffer.byteLength(metadados, "utf8") > 16 * 1024) {
      throw new ErroDeUso("metadados precisa ser um JSON de até 16 KiB");
    }
    metadados = metadados.trim();
    if (metadados !== "") {
      try { JSON.parse(metadados); }
      catch { throw new ErroDeUso("metadados precisa ser JSON válido"); }
    }
    const registrado = this.agora();
    const resultado = this.db.prepare(`INSERT INTO historico
      (projeto_id, evento_id, origem, sessao, papel, conteudo, modelo, maquina, criado_em, registrado_em, metadados)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (projeto_id, origem, sessao, evento_id) DO NOTHING`)
      .run(projetoId, eventoId, origem, sessao, entrada.papel, entrada.conteudo, modelo, maquina, observado ?? registrado, registrado, metadados);
    const linha = this.db.prepare(`SELECT ${COLUNAS_HISTORICO} FROM historico WHERE projeto_id = ? AND origem = ? AND sessao = ? AND evento_id = ?`)
      .get(projetoId, origem, sessao, eventoId) as unknown as LinhaHistorico;
    if (linha.papel !== entrada.papel || conteudoHistorico(linha) !== entrada.conteudo || linha.modelo !== modelo || linha.maquina !== maquina ||
      linha.metadados !== metadados || (observado !== undefined && linha.criado_em !== observado)) {
      throw new ErroDeUso("o evento já existe com dados diferentes; use um eventoId novo para outra mensagem");
    }
    return { entrada: comoHistorico(linha), criado: resultado.changes !== 0 };
  }

  /** Cursor por ID não perde eventos quando outras CLIs registram mensagens. */
  listarHistorico(projetoId: number, options: { depois?: number; limite?: number; papel?: string } = {}): EntradaHistorico[] {
    if (!this.projetoPermitido(projetoId)) return [];
    const depois = options.depois ?? 0;
    if (!Number.isSafeInteger(depois) || depois < 0) throw new ErroDeUso("depois precisa ser um ID inteiro não negativo");
    const limite = limiteHistorico(options.limite, 100);
    if (options.papel !== undefined && !(PAPEIS_HISTORICO as readonly string[]).includes(options.papel)) {
      throw new ErroDeUso("papel precisa ser user, assistant, tool ou system");
    }
    return this.paginaHistorico(`SELECT ${COLUNAS_HISTORICO} FROM historico WHERE projeto_id = ? AND id > ?
      ${options.papel === undefined ? "" : "AND papel = ?"} ORDER BY id ASC LIMIT ?`,
      [projetoId, depois, ...(options.papel === undefined ? [] : [options.papel]), limite]);
  }

  entradaDoHistorico(projetoId: number, id: number): EntradaHistorico | null {
    if (!this.projetoPermitido(projetoId) || !Number.isSafeInteger(id) || id <= 0) return null;
    const linha = this.db.prepare(`SELECT ${COLUNAS_HISTORICO} FROM historico WHERE projeto_id = ? AND id = ?`).get(projetoId, id) as unknown as LinhaHistorico | undefined;
    return linha ? comoHistorico(linha) : null;
  }

  contarHistorico(projetoId: number): number {
    if (!this.projetoPermitido(projetoId)) return 0;
    const linha = this.db.prepare("SELECT COUNT(*) AS quantos FROM historico WHERE projeto_id = ?").get(projetoId) as { quantos: number };
    return linha.quantos;
  }

  /** Últimas entradas para retomar contexto, entregues na ordem de registro. */
  ultimasDoHistorico(projetoId: number, limite = 20): EntradaHistorico[] {
    if (!this.projetoPermitido(projetoId)) return [];
    return this.paginaHistorico(`SELECT ${COLUNAS_HISTORICO} FROM historico WHERE projeto_id = ? ORDER BY id DESC LIMIT ?`,
      [projetoId, limiteHistorico(limite, 20)]).reverse();
  }

  /** Iterar evita carregar 500 mensagens de 1 MiB antes de aplicar o teto. */
  private paginaHistorico(sql: string, parametros: (string | number)[]): EntradaHistorico[] {
    const entradas: EntradaHistorico[] = [];
    let tamanho = 2; // Colchetes do array JSON.
    const linhas = this.db.prepare(sql).iterate(...parametros) as unknown as Iterable<LinhaHistorico>;
    for (const linha of linhas) {
      const entrada = comoHistorico(linha);
      const bytes = Buffer.byteLength(JSON.stringify(entrada), "utf8") + (entradas.length === 0 ? 0 : 1);
      if (entradas.length > 0 && tamanho + bytes > ORCAMENTO_HISTORICO) break;
      entradas.push(entrada);
      tamanho += bytes;
    }
    return entradas;
  }

  // -------------------------------------------------------------- documentos

  /** A área geral: o acervo do qual os projetos escolhem. */
  listarGerais(): Documento[] {
    const filtro = this.filtroDocumentos();
    const linhas = this.db
      .prepare(`SELECT d.* FROM documentos d WHERE d.projeto_id IS NULL AND ${filtro.sql} ORDER BY d.tipo, d.titulo`)
      .all(...filtro.parametros) as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  /** Os documentos que nasceram dentro do projeto. */
  listarProprios(projetoId: number): Documento[] {
    if (!this.projetoPermitido(projetoId)) return [];
    const linhas = this.db
      .prepare("SELECT * FROM documentos WHERE usuario_id = ? AND projeto_id = ? ORDER BY tipo, titulo")
      .all(this.usuarioId, projetoId) as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  /**
   * Tudo que um projeto USA: o que é dele mais o que ele selecionou da geral.
   *
   * É esta lista — e só ela — que o MCP expõe sob o projeto. O harness pede "o
   * material deste projeto" e recebe exatamente o que alguém escolheu para ele.
   */
  listarDoProjeto(projetoId: number): Documento[] {
    if (!this.projetoPermitido(projetoId)) return [];
    const linhas = this.db
      .prepare(
        `SELECT d.* FROM documentos d WHERE d.usuario_id = ? AND d.projeto_id = ?
         UNION
         SELECT d.* FROM documentos d
           JOIN selecoes s ON s.documento_id = d.id
          WHERE d.usuario_id = ? AND d.projeto_id IS NULL AND s.projeto_id = ?
         ORDER BY tipo, titulo`,
      )
      .all(this.usuarioId, projetoId, this.usuarioId, projetoId) as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  documento(projetoId: number | null, tipo: string, slug: string): Documento | null {
    if (projetoId !== null && !this.projetoPermitido(projetoId)) return null;
    const filtro = this.filtroDocumentos();
    const linha = this.db
      .prepare(`SELECT d.* FROM documentos d WHERE IFNULL(d.projeto_id, 0) = IFNULL(?, 0) AND d.tipo = ? AND d.slug = ? AND ${filtro.sql}`)
      .get(projetoId, tipo, slug, ...filtro.parametros) as unknown as LinhaDocumento | undefined;
    return linha ? comoDocumento(linha) : null;
  }

  documentoPorId(id: number): Documento | null {
    const linha = this.linhaDocumento(id);
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
    this.exigirDestino(projetoId, entrada.tipo);
    if (this.documento(projetoId, entrada.tipo, slug)) {
      throw new ErroDeUso(`já existe um documento ${entrada.tipo}/${slug} ${projetoId === null ? "na área geral" : "neste projeto"}`);
    }

    const instante = this.agora();
    this.db
      .prepare(
        "INSERT INTO documentos (usuario_id, projeto_id, tipo, slug, titulo, conteudo, descricao, categoria, gatilhos, restricoes, area, versao, fonte, status, natureza, procedencia, criado_em, alterado_em)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.usuarioId,
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
        this.projetoSlug !== undefined && entrada.tipo === "memoria" ? "rascunho" : entrada.status ?? "ativo",
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
    this.exigirDocumentoGravavel(id);
    const atual = this.documentoPorId(id);
    if (!atual) throw new ErroDeUso(`documento ${id} não existe`);

    this.db
      .prepare(
        "UPDATE documentos SET titulo = ?, conteudo = ?, descricao = ?, categoria = ?, gatilhos = ?, restricoes = ?, area = ?, status = ?, alterado_em = ? WHERE usuario_id = ? AND id = ?",
      )
      .run(
        campos.titulo ?? atual.titulo,
        campos.conteudo ?? atual.conteudo,
        campos.descricao ?? atual.descricao,
        campos.categoria ?? atual.categoria,
        campos.gatilhos ?? atual.gatilhos,
        campos.restricoes ?? atual.restricoes,
        campos.area === undefined ? atual.area : areaValida(campos.area),
        this.projetoSlug !== undefined && atual.tipo === "memoria" ? "rascunho" : atual.status,
        this.agora(),
        this.usuarioId,
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
    const filtro = this.filtroDocumentos();
    const linhas = this.db
      .prepare(
        "SELECT CASE WHEN TRIM(categoria) = '' THEN ? ELSE categoria END AS categoria, COUNT(*) AS quantos" +
          ` FROM documentos d WHERE d.projeto_id IS NULL AND d.tipo = ? AND ${filtro.sql} GROUP BY 1 ORDER BY 1`,
      )
      .all(SEM_CATEGORIA, tipo, ...filtro.parametros) as unknown as { categoria: string; quantos: number }[];
    return linhas;
  }

  removerDocumento(id: number): void {
    this.exigirDocumentoGravavel(id);
    this.db.prepare("DELETE FROM documentos WHERE usuario_id = ? AND id = ?").run(this.usuarioId, id);
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
    this.exigirDestino(entrada.projetoId, "memoria");
    const status = this.projetoSlug !== undefined ? "rascunho" : entrada.status ?? "rascunho";
    const slug = acumula(entrada.natureza) ? comoSlug(entrada.titulo) : "estado-atual";
    const instante = this.agora();

    const existente = this.documento(entrada.projetoId, "memoria", slug);
    if (existente) {
      this.db
        .prepare(
          "UPDATE documentos SET titulo = ?, conteudo = ?, natureza = ?, procedencia = ?, status = ?, alterado_em = ? WHERE usuario_id = ? AND id = ?",
        )
        .run(entrada.titulo, entrada.conteudo, entrada.natureza, entrada.procedencia ?? "", status, instante, this.usuarioId, existente.id);
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
    if (!this.projetoPermitido(projetoId)) return [];
    const linhas = this.db
      .prepare("SELECT * FROM documentos WHERE usuario_id = ? AND projeto_id = ? AND tipo = 'memoria' ORDER BY natureza, titulo")
      .all(this.usuarioId, projetoId) as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  /** O que espera aprovação, do projeto ou de todos. */
  rascunhos(projetoId?: number): Documento[] {
    if (projetoId !== undefined && !this.projetoPermitido(projetoId)) return [];
    const filtro = this.filtroDocumentos();
    const linhas = this.db.prepare(`SELECT d.* FROM documentos d WHERE d.status = 'rascunho' AND ${filtro.sql}
      ${projetoId === undefined ? "" : "AND d.projeto_id = ?"} ORDER BY d.alterado_em DESC`)
      .all(...filtro.parametros, ...(projetoId === undefined ? [] : [projetoId])) as unknown as LinhaDocumento[];
    return linhas.map(comoDocumento);
  }

  aprovar(id: number): void {
    if (this.projetoSlug !== undefined) throw new ErroDeUso("a aprovação exige uma sessão do usuário");
    this.exigirDocumentoGravavel(id);
    this.db.prepare("UPDATE documentos SET status = 'ativo', alterado_em = ? WHERE usuario_id = ? AND id = ?").run(this.agora(), this.usuarioId, id);
  }

  // ---------------------------------------------------------------- arquivos

  /**
   * Grava um arquivo do pacote.
   *
   * Reimportar a mesma skill substitui o arquivo em vez de duplicá-lo: o par
   * documento + caminho é único, e uma skill atualizada é a mesma skill.
   */
  gravarArquivo(documentoId: number, arquivo: { caminho: string; conteudo: Buffer; binario: boolean }): void {
    this.exigirDocumentoGravavel(documentoId);
    this.db
      .prepare(
        "INSERT INTO arquivos (documento_id, caminho, conteudo, binario, criado_em) VALUES (?, ?, ?, ?, ?)" +
          " ON CONFLICT (documento_id, caminho) DO UPDATE SET conteudo = excluded.conteudo, binario = excluded.binario",
      )
      .run(documentoId, arquivo.caminho, arquivo.conteudo, arquivo.binario ? 1 : 0, this.agora());
  }

  /** Os arquivos de um documento, sem o conteúdo: listar não precisa carregar. */
  arquivos(documentoId: number): ArquivoDoDocumento[] {
    if (!this.linhaDocumento(documentoId)) return [];
    const linhas = this.db
      .prepare("SELECT id, caminho, binario, LENGTH(conteudo) AS tamanho FROM arquivos WHERE documento_id = ? ORDER BY caminho")
      .all(documentoId) as unknown as { id: number; caminho: string; binario: number; tamanho: number }[];
    return linhas.map((linha) => ({ id: linha.id, caminho: linha.caminho, binario: linha.binario === 1, tamanho: linha.tamanho }));
  }

  /** O conteúdo de um arquivo, pelo caminho. Nulo quando não existe. */
  arquivo(documentoId: number, caminho: string): { conteudo: Buffer; binario: boolean } | null {
    if (!this.linhaDocumento(documentoId)) return null;
    const linha = this.db
      .prepare("SELECT conteudo, binario FROM arquivos WHERE documento_id = ? AND caminho = ?")
      .get(documentoId, caminho) as unknown as { conteudo: Buffer | Uint8Array; binario: number } | undefined;
    return linha ? { conteudo: Buffer.from(linha.conteudo), binario: linha.binario === 1 } : null;
  }

  removerArquivos(documentoId: number): void {
    this.exigirDocumentoGravavel(documentoId);
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
    if (this.projetoSlug !== undefined) throw new ErroDeUso("token de projeto não pode alterar a seleção do catálogo");
    this.exigirProjeto(projetoId);
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
    if (this.projetoSlug !== undefined) throw new ErroDeUso("token de projeto não pode alterar a seleção do catálogo");
    this.exigirProjeto(projetoId);
    this.exigirDocumentoGravavel(documentoId);
    this.db.prepare("DELETE FROM selecoes WHERE projeto_id = ? AND documento_id = ?").run(projetoId, documentoId);
  }

  idsSelecionados(projetoId: number): number[] {
    if (!this.projetoPermitido(projetoId)) return [];
    const linhas = this.db
      .prepare("SELECT s.documento_id FROM selecoes s JOIN documentos d ON d.id = s.documento_id WHERE s.projeto_id = ? AND d.usuario_id = ? AND d.projeto_id IS NULL")
      .all(projetoId, this.usuarioId) as unknown as { documento_id: number }[];
    return linhas.map((linha) => linha.documento_id);
  }
}
