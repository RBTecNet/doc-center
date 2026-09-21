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

/** Os tipos que a interface oferece. A lista é aberta no banco, guiada aqui. */
export const TIPOS = ["skill", "memoria", "tecnica", "projeto", "hook", "prompt"] as const;
export type TipoDocumento = (typeof TIPOS)[number];

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
