/**
 * O esquema da base documental.
 *
 * Três ideias, e o resto decorre delas.
 *
 * **O documento é a unidade.** Skill, memória, documentação técnica, hook,
 * prompt — tudo é documento com um tipo. Tabelas separadas por tipo pareceriam
 * mais organizadas e obrigariam a inventar uma tabela nova a cada tipo que
 * aparecer; o tipo é um campo porque é isso que ele é.
 *
 * **A área geral é o acervo; o projeto é uma seleção dele.** Um documento nasce
 * na área geral ou dentro de um projeto, e um projeto pode anexar documentos da
 * área geral. É a diferença entre ter e usar: sem ela, todo run levaria o acervo
 * inteiro para dentro do contexto, que é justamente o que esta aplicação existe
 * para evitar.
 *
 * **O pedido é do projeto, e é um só.** Ele não é um documento entre outros: é o
 * que o harness lê para saber o que construir. Fica como coluna do projeto,
 * porque ter dois pedidos é um estado que não queremos representar.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projetos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  nome        TEXT NOT NULL,
  descricao   TEXT NOT NULL DEFAULT '',
  -- O que construir. Vazio significa projeto cadastrado e ainda sem pedido.
  pedido      TEXT NOT NULL DEFAULT '',
  criado_em   TEXT NOT NULL,
  alterado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documentos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nulo significa área geral: o documento existe para ser reusado por projetos.
  projeto_id  INTEGER REFERENCES projetos(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  titulo      TEXT NOT NULL,
  conteudo    TEXT NOT NULL,
  -- A vitrine de uma skill ou hook: o que se lê antes de decidir adotá-la.
  -- Vazio em memória e documentação, que não são escolhidas num catálogo.
  descricao   TEXT NOT NULL DEFAULT '',
  categoria   TEXT NOT NULL DEFAULT '',
  gatilhos    TEXT NOT NULL DEFAULT '',
  restricoes  TEXT NOT NULL DEFAULT '',
  criado_em   TEXT NOT NULL,
  alterado_em TEXT NOT NULL
);

-- Dois documentos com o mesmo tipo e slug no mesmo lugar seriam duas URIs
-- iguais apontando para conteúdos diferentes, e o harness leria um dos dois sem
-- saber que havia outro. O índice trata a área geral como um "lugar" próprio.
CREATE UNIQUE INDEX IF NOT EXISTS documentos_unicos
  ON documentos (IFNULL(projeto_id, 0), tipo, slug);

-- Quais documentos da área geral cada projeto usa. O projeto não copia o
-- documento: aponta para ele, e uma correção na área geral chega a todos os
-- projetos que a escolheram.
CREATE TABLE IF NOT EXISTS selecoes (
  projeto_id   INTEGER NOT NULL REFERENCES projetos(id) ON DELETE CASCADE,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  criado_em    TEXT NOT NULL,
  PRIMARY KEY (projeto_id, documento_id)
);

CREATE INDEX IF NOT EXISTS documentos_por_projeto ON documentos (projeto_id);
`;

/**
 * Colunas que nasceram depois do primeiro banco.
 *
 * SQLite não tem `ADD COLUMN IF NOT EXISTS`, e um banco que já existe no disco
 * não pode ser recriado só porque a vitrine das skills apareceu. A migração
 * pergunta o que existe e acrescenta o que falta.
 */
export const COLUNAS_NOVAS: { tabela: string; coluna: string; definicao: string }[] = [
  { tabela: "documentos", coluna: "descricao", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "categoria", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "gatilhos", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "restricoes", definicao: "TEXT NOT NULL DEFAULT ''" },
];

/**
 * Onde o projeto escolhe em vez de escrever.
 *
 * Skill e hook são reusáveis por natureza: existem no catálogo e um projeto os
 * adota. Memória e documentação são do projeto — nascem dentro dele e não fazem
 * sentido fora. Por isso o projeto não tem formulário de skill: teria duas
 * skills iguais em projetos diferentes, divergindo em silêncio.
 */
export const TIPOS_DE_CATALOGO: readonly string[] = ["skill", "hook"];

export function ehDeCatalogo(tipo: string): boolean {
  return TIPOS_DE_CATALOGO.includes(tipo);
}

/** O rótulo de quem não declarou categoria. */
export const SEM_CATEGORIA = "Sem categoria";

/**
 * Os contêineres de um projeto — e da área geral.
 *
 * Eles existem desde o instante em que o projeto é criado, vazios, e não são
 * linhas no banco: são estruturais. Criar registros só para representar "a
 * pasta de skills existe" produziria estado que pode divergir (uma pasta
 * faltando num projeto, duplicada em outro) para representar uma verdade que é
 * sempre a mesma.
 *
 * O pedido fica à parte porque é do projeto, não uma pasta de documentos: é
 * único, e é o que o harness lê para saber o que construir.
 */
export const CONTEINERES = [
  { tipo: "skill", titulo: "Skills", singular: "skill" },
  { tipo: "memoria", titulo: "Memórias", singular: "memória" },
  { tipo: "hook", titulo: "Hooks", singular: "hook" },
  { tipo: "documentacao", titulo: "Documentação", singular: "documento" },
] as const;

export type TipoDocumento = (typeof CONTEINERES)[number]["tipo"];

/** Os tipos que a interface oferece ao criar. */
export const TIPOS = CONTEINERES.map((conteiner) => conteiner.tipo);

/** O rótulo de um tipo; um tipo que não conhecemos aparece com o próprio nome. */
export function tituloDoTipo(tipo: string): string {
  return CONTEINERES.find((conteiner) => conteiner.tipo === tipo)?.titulo ?? tipo;
}

/**
 * Os contêineres a mostrar para uma lista de documentos.
 *
 * Os quatro fixos, na ordem, mais qualquer tipo que exista no banco e não esteja
 * entre eles. Um documento com tipo antigo não pode sumir da tela porque a lista
 * de tipos mudou depois que ele foi escrito.
 */
export function conteineresPara(documentos: readonly { tipo: string }[]): { tipo: string; titulo: string }[] {
  const fixos = CONTEINERES.map((conteiner) => ({ tipo: conteiner.tipo as string, titulo: conteiner.titulo as string }));
  const conhecidos = new Set(fixos.map((conteiner) => conteiner.tipo));
  const extras = [...new Set(documentos.map((documento) => documento.tipo))]
    .filter((tipo) => !conhecidos.has(tipo))
    .map((tipo) => ({ tipo, titulo: tituloDoTipo(tipo) }));
  return [...fixos, ...extras];
}

export interface Projeto {
  id: number;
  slug: string;
  nome: string;
  descricao: string;
  pedido: string;
  criadoEm: string;
  alteradoEm: string;
}

export interface Documento {
  id: number;
  projetoId: number | null;
  tipo: string;
  slug: string;
  titulo: string;
  conteudo: string;
  /** A vitrine: o que se lê no catálogo antes de adotar a skill ou o hook. */
  descricao: string;
  categoria: string;
  gatilhos: string;
  restricoes: string;
  criadoEm: string;
  alteradoEm: string;
}

/**
 * Um slug estável a partir de um título.
 *
 * Ele entra na URI que o harness registra no stamp de um run: mudar de regra
 * depois renomeia documento que já foi citado em plano publicado. Por isso é
 * conservador — só minúsculas, números e hífen.
 */
export function comoSlug(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
