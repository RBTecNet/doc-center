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
  -- Zero identifica dados locais anteriores à criação da primeira conta.
  usuario_id  INTEGER NOT NULL DEFAULT 0,
  slug        TEXT NOT NULL,
  nome        TEXT NOT NULL,
  descricao   TEXT NOT NULL DEFAULT '',
  -- Identidade portátil do Git remoto, sem credenciais nem caminhos locais.
  repositorio TEXT NOT NULL DEFAULT '',
  -- O que construir. Vazio significa projeto cadastrado e ainda sem pedido.
  pedido      TEXT NOT NULL DEFAULT '',
  criado_em   TEXT NOT NULL,
  alterado_em TEXT NOT NULL,
  UNIQUE (usuario_id, slug)
);

CREATE TABLE IF NOT EXISTS documentos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL DEFAULT 0,
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
-- O índice inclui o usuário e é instalado por Store.migrar(), depois de
-- acrescentar usuario_id a bancos existentes.

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

-- Os arquivos que acompanham um documento: as referências de uma skill, os
-- prints, o que vier no pacote. O SKILL.md continua no "conteudo" do documento,
-- porque é a base — o que entra no prompt e o que a vitrine descreve.
CREATE TABLE IF NOT EXISTS arquivos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE,
  -- Relativo à raiz do pacote: "references/typography.md". É este caminho que o
  -- SKILL.md cita, e é com ele que o harness materializa no disco.
  caminho      TEXT NOT NULL,
  conteudo     BLOB NOT NULL,
  -- Binário é guardado como veio e nunca convertido para texto: um print de
  -- interface é a melhor referência de layout que existe, e vira lixo se passar
  -- por uma conversão de codificação.
  binario      INTEGER NOT NULL DEFAULT 0,
  criado_em    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS arquivos_unicos ON arquivos (documento_id, caminho);

-- Marca a adoção única dos dados locais pela primeira conta, inclusive quando
-- o banco começa vazio. Arquivos e seleções conservam seus IDs e proprietários
-- por meio dos documentos e projetos aos quais pertencem.
CREATE TABLE IF NOT EXISTS doc_center_metadados (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

-- Conversas são eventos, não documentos editáveis. A chave vem da CLI e
-- permite retomar uma sincronização sem duplicar mensagens já recebidas.
CREATE TABLE IF NOT EXISTS historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projeto_id INTEGER NOT NULL REFERENCES projetos(id) ON DELETE CASCADE,
  evento_id TEXT NOT NULL,
  origem TEXT NOT NULL,
  sessao TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('user', 'assistant', 'tool', 'system')),
  conteudo TEXT NOT NULL,
  modelo TEXT NOT NULL DEFAULT '',
  maquina TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL,
  registrado_em TEXT NOT NULL,
  metadados TEXT NOT NULL DEFAULT '',
  UNIQUE (projeto_id, origem, sessao, evento_id)
);
CREATE INDEX IF NOT EXISTS historico_por_projeto ON historico (projeto_id, id);
CREATE TRIGGER IF NOT EXISTS historico_imutavel
  BEFORE UPDATE ON historico BEGIN
    SELECT RAISE(ABORT, 'o histórico é imutável');
  END;
`;

/**
 * Colunas que nasceram depois do primeiro banco.
 *
 * SQLite não tem `ADD COLUMN IF NOT EXISTS`, e um banco que já existe no disco
 * não pode ser recriado só porque a vitrine das skills apareceu. A migração
 * pergunta o que existe e acrescenta o que falta.
 */
export const COLUNAS_NOVAS: { tabela: string; coluna: string; definicao: string }[] = [
  { tabela: "projetos", coluna: "usuario_id", definicao: "INTEGER NOT NULL DEFAULT 0" },
  { tabela: "projetos", coluna: "repositorio", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "usuario_id", definicao: "INTEGER NOT NULL DEFAULT 0" },
  { tabela: "documentos", coluna: "descricao", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "categoria", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "gatilhos", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "restricoes", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "area", definicao: `TEXT NOT NULL DEFAULT '${"geral"}'` },
  { tabela: "documentos", coluna: "versao", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "fonte", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "status", definicao: `TEXT NOT NULL DEFAULT '${"ativo"}'` },
  { tabela: "documentos", coluna: "natureza", definicao: "TEXT NOT NULL DEFAULT ''" },
  { tabela: "documentos", coluna: "procedencia", definicao: "TEXT NOT NULL DEFAULT ''" },
];

/**
 * As naturezas de uma memória, e como cada uma envelhece.
 *
 * As três primeiras ACUMULAM: a lista cresce e isso é bom. `estado` SUBSTITUI —
 * há um por projeto, reescrito. Memória de estado desatualizada é pior que
 * nenhuma, porque quem lê acredita nela e trabalha sobre o que já não é verdade.
 */
export const NATUREZAS = [
  // `pasta` é escrita, não derivada: "decisao" + "s" dá "decisaos", e o zip é o
  // que alguém abre para ler sem nenhuma ferramenta nossa.
  { natureza: "decisao", titulo: "Decisões", pasta: "decisoes", acumula: true },
  { natureza: "armadilha", titulo: "Armadilhas", pasta: "armadilhas", acumula: true },
  { natureza: "convencao", titulo: "Convenções", pasta: "convencoes", acumula: true },
  { natureza: "estado", titulo: "Estado atual", pasta: "", acumula: false },
] as const;

/** A pasta de uma natureza dentro de `memoria/`. */
export function pastaDaNatureza(natureza: string): string {
  return NATUREZAS.find((entrada) => entrada.natureza === natureza)?.pasta ?? "decisoes";
}

export type Natureza = (typeof NATUREZAS)[number]["natureza"];

export function acumula(natureza: string): boolean {
  return NATUREZAS.find((entrada) => entrada.natureza === natureza)?.acumula ?? true;
}

/**
 * O que ainda não valeu.
 *
 * Tudo que um agente escreve entra como rascunho: memória errada volta em TODOS
 * os runs futuros do projeto, e o custo de aprovar é um clique enquanto o custo
 * de não revisar se paga em cada execução seguinte.
 */
export const STATUS = ["ativo", "rascunho"] as const;
export type Status = (typeof STATUS)[number];

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
 * As áreas, fechadas dos dois lados.
 *
 * A skill declara a sua; a fase declara as dela; o harness cruza. Lista fechada
 * porque lista aberta vira texto livre, e casar texto livre é onde defeito
 * silencioso mora — uma skill de frontend carregada numa fase de banco é
 * contexto pago que compete com o que importa.
 */
export const AREAS = ["frontend", "backend", "dados", "infra", "qualidade", "geral"] as const;
export type Area = (typeof AREAS)[number];

export function areaValida(valor: string): Area {
  return (AREAS as readonly string[]).includes(valor) ? (valor as Area) : "geral";
}

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
  /*
   * Prompts guardados.
   *
   * O `pedido` do projeto continua sendo o principal e único dele. Estes são os
   * outros: o pedido de mudança que você vai repetir em três projetos, o texto
   * que descreve uma funcionalidade que sempre volta, o levantamento que virou
   * pedido de reescrita. Guardados no projeto quando são dele, na área geral
   * quando servem a qualquer um.
   */
  { tipo: "prompt", titulo: "Prompts", singular: "prompt" },
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
  repositorio: string;
  criadoEm: string;
  alteradoEm: string;
}

export const PAPEIS_HISTORICO = ["user", "assistant", "tool", "system"] as const;
export type PapelHistorico = (typeof PAPEIS_HISTORICO)[number];

/** O evento original e o instante separado em que o servidor o recebeu. */
export interface EntradaHistorico {
  id: number;
  projetoId: number;
  eventoId: string;
  origem: string;
  sessao: string;
  papel: PapelHistorico;
  conteudo: string;
  modelo: string;
  maquina: string;
  criadoEm: string;
  registradoEm: string;
  /** JSON validado, preservado para que outros clientes possam importá-lo. */
  metadados?: string;
}

export interface ArquivoDoDocumento {
  id: number;
  caminho: string;
  binario: boolean;
  /** Tamanho em bytes. O conteúdo só é lido quando alguém o pede. */
  tamanho: number;
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
  /** Onde a skill se aplica. É o que decide em que fase ela entra. */
  area: string;
  /** `ativo` ou `rascunho`: o que um agente escreveu espera aprovação. */
  status: string;
  /** Para memórias: decisao, armadilha, convencao ou estado. */
  natureza: string;
  /** De onde veio: o run e a fase que a produziram. */
  procedencia: string;
  /** Procedência, quando o pacote a declara. */
  versao: string;
  fonte: string;
  /** Os arquivos que acompanham; vazio quando o documento é só texto. */
  arquivos?: ArquivoDoDocumento[];
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
