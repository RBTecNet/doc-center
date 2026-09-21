/**
 * As páginas da interface.
 *
 * HTML montado no servidor, sem framework: a aplicação tem zero dependências de
 * runtime e não há razão para essa conta mudar por causa de telas de CRUD.
 *
 * O layout é o do console de referência — lateral com a árvore, painel central,
 * e uma terceira coluna à direita. Essa coluna mostra **o que o harness vai
 * receber**: as URIs exatas, na ordem em que ele as lê. É a pergunta que se faz
 * o tempo todo ao organizar documentação para um agente — "o que disto vai
 * junto?" — e a resposta estava só do outro lado do protocolo.
 */

import type { Store } from "../db/store.js";
import type { Documento, Projeto } from "../db/schema.js";
import { conteineresPara, ehDeCatalogo } from "../db/schema.js";
import { cartaoDeCatalogo, filtros, formularioDeCatalogo } from "./catalogo.js";
import { uriDoDocumento, uriDoPedido } from "../mcp/server.js";
import { renderArvore } from "./arvore.js";
import { escapar } from "./escapar.js";
import { CSS, FONTES, MAIS_SVG, PASTA_SVG, RAIO_SVG } from "./tema.js";

export { escapar };

interface Moldura {
  titulo: string;
  caminho: string;
  pilula?: string;
  corpo: string;
  direita: { titulo: string; corpo: string };
  atual: string;
}

function moldura(store: Store, pagina: Moldura): string {
  const arvore = renderArvore(
    store.listarGerais(),
    store.listarProjetos().map((projeto) => ({ projeto, documentos: store.listarDoProjeto(projeto.id) })),
    pagina.atual,
  );

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(pagina.titulo)} · doc-center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTES}">
<style>${CSS}</style>
</head>
<body>
<div class="console">
  <aside class="lateral">
    <div class="marca">
      <div class="linha">
        <div class="simbolo">${RAIO_SVG}</div>
        <div class="nome">doc-center</div>
        <div class="versao">v0.1</div>
      </div>
      <button class="acao-principal" data-novo-projeto>${MAIS_SVG} Novo projeto</button>
    </div>
    <nav class="arvore">${arvore}</nav>
  </aside>

  <main class="central">
    <header class="topo">
      ${PASTA_SVG}
      <h1>${escapar(pagina.titulo)}</h1>
      <div class="caminho">${escapar(pagina.caminho)}</div>
      <div class="acoes-topo">${pagina.pilula ? `<div class="pilula">${escapar(pagina.pilula)}</div>` : ""}</div>
    </header>
    <div class="rolagem"><div class="coluna">${pagina.corpo}</div></div>
  </main>

  <aside class="direita">
    <header><h2>${escapar(pagina.direita.titulo)}</h2></header>
    <div class="corpo">${pagina.direita.corpo}</div>
  </aside>
</div>
<script type="module" src="/app.js"></script>
</body>
</html>`;
}

function cartao(documento: Documento, uri: string, daGeral = false): string {
  return `<article class="cartao" data-id="${documento.id}">
  <header>
    <span class="etiqueta${daGeral ? " geral" : ""}">${escapar(documento.tipo)}</span>
    <h3>${escapar(documento.titulo)}</h3>
    <span class="uri">${escapar(uri)}</span>
  </header>
  <pre class="previa">${escapar(documento.conteudo.slice(0, 600))}</pre>
  <div class="acoes">
    <button class="discreto" data-editar="${documento.id}">editar</button>
    <button class="discreto perigo" data-remover="${documento.id}">remover</button>
  </div>
</article>`;
}

/**
 * O formulário de um contêiner.
 *
 * O tipo não é escolhido numa lista: ele é o contêiner em que se clicou. Um
 * seletor de tipo dentro da pasta de skills permitiria criar uma memória ali, e
 * o documento apareceria noutro lugar — quem clicou já disse o que queria.
 */
function formulario(projetoSlug: string | null, tipo: string, singular: string): string {
  return `<details class="dobra">
  <summary>${MAIS_SVG} ${escapar(singular)}</summary>
  <div class="corpo">
    <form class="campos" data-json method="post" action="/api/documentos">
      ${projetoSlug ? `<input type="hidden" name="projeto" value="${escapar(projetoSlug)}">` : ""}
      <input type="hidden" name="tipo" value="${escapar(tipo)}">
      <label>título <input name="titulo" required autocomplete="off"></label>
      <label>conteúdo <textarea name="conteudo" rows="12" required></textarea></label>
      <div class="linha-acoes"><button type="submit">salvar</button></div>
    </form>
  </div>
</details>`;
}

/** O singular de um contêiner, para o botão dizer o que vai criar. */
function singularDe(tipo: string): string {
  const conhecido: Record<string, string> = {
    skill: "nova skill",
    memoria: "nova memória",
    hook: "novo hook",
    documentacao: "novo documento",
  };
  return conhecido[tipo] ?? `novo ${tipo}`;
}

/**
 * Uma seção por contêiner, sempre presente — vazia inclusive.
 *
 * Skills e hooks não têm formulário aqui: eles vêm do catálogo. Memórias e
 * documentação têm, porque nascem do projeto e não existem fora dele.
 */
function secaoConteiner(
  documentos: Documento[],
  tipo: { tipo: string; titulo: string },
  escopo: string,
  projetoSlug: string | null,
  daGeral: boolean,
): string {
  const doTipo = documentos.filter((documento) => documento.tipo === tipo.tipo);
  const corpo = ehDeCatalogo(tipo.tipo)
    ? doTipo.map((documento) => cartaoDeCatalogo(documento, {})).join("")
    : doTipo.map((documento) => cartao(documento, uriDoDocumento(escopo, documento), daGeral)).join("");

  return `<section class="bloco" id="c-${escapar(tipo.tipo)}">
    <h2>${escapar(tipo.titulo)} <span class="contagem">${doTipo.length}</span></h2>
    ${ehDeCatalogo(tipo.tipo) ? "" : formulario(projetoSlug, tipo.tipo, singularDe(tipo.tipo))}
    ${corpo || `<p class="vazio">Nenhuma entrada em ${escapar(tipo.titulo.toLowerCase())}.</p>`}
  </section>`;
}

/**
 * O contêiner de catálogo dentro de um projeto: o que ele adotou, e o resto do
 * acervo pronto para ser adotado com um clique.
 */
function secaoDeCatalogo(
  store: Store,
  projetoSlug: string,
  tipo: { tipo: string; titulo: string },
  usados: Documento[],
): string {
  const adotados = usados.filter((documento) => documento.tipo === tipo.tipo);
  const adotadosIds = new Set(adotados.map((documento) => documento.id));
  const acervo = store.listarGerais().filter((documento) => documento.tipo === tipo.tipo && !adotadosIds.has(documento.id));

  return `<section class="bloco" id="c-${escapar(tipo.tipo)}">
    <h2>${escapar(tipo.titulo)} <span class="contagem">${adotados.length} em uso</span></h2>
    ${
      adotados.map((documento) => cartaoDeCatalogo(documento, { projetoSlug, adotado: true })).join("") ||
      `<p class="vazio">Nenhum ${escapar(tipo.titulo.toLowerCase())} em uso neste projeto.</p>`
    }
    <details class="dobra">
      <summary>${MAIS_SVG} adicionar do catálogo <span class="contagem">${acervo.length} disponíve${acervo.length === 1 ? "l" : "is"}</span></summary>
      <div class="corpo">
        ${
          acervo.length === 0
            ? `<p class="vazio">O catálogo não tem mais nada deste tipo. Cadastre na <a href="/">área geral</a>.</p>`
            : `<div class="vitrines">${acervo.map((documento) => cartaoDeCatalogo(documento, { projetoSlug, adotado: false })).join("")}</div>`
        }
      </div>
    </details>
  </section>`;
}

/** A coluna da direita: o que sai por MCP, exatamente como o harness lê. */
function oQueSai(linhas: { uri: string; nota?: string }[], nota: string): string {
  if (linhas.length === 0) return `<p class="nota">${escapar(nota)}</p>`;
  return (
    linhas
      .map((linha) => `<div class="uri">${escapar(linha.uri)}</div>`)
      .join("") + `<p class="nota">${escapar(nota)}</p>`
  );
}

function paginaGeral(store: Store): string {
  const documentos = store.listarGerais();
  const corpo = `<p class="explicacao">O acervo, independente de projeto. O que está aqui pode ser usado por
    qualquer um — mas só entra num run depois de um projeto <strong>adotar</strong>.</p>
  ${conteineresPara(documentos)
    .map((tipo) => {
      if (!ehDeCatalogo(tipo.tipo)) return secaoConteiner(documentos, tipo, "geral", null, true);
      const doTipo = documentos.filter((documento) => documento.tipo === tipo.tipo);
      return `<section class="bloco" id="c-${escapar(tipo.tipo)}">
        <h2>${escapar(tipo.titulo)} <span class="contagem">${doTipo.length}</span></h2>
        ${formularioDeCatalogo(tipo.tipo, singularDe(tipo.tipo))}
        ${doTipo.length === 0 ? `<p class="vazio">O catálogo de ${escapar(tipo.titulo.toLowerCase())} está vazio.</p>` : ""}
        ${doTipo.length > 0 ? filtros(store.categorias(tipo.tipo), doTipo.length) : ""}
        <div class="vitrines">${doTipo.map((documento) => cartaoDeCatalogo(documento)).join("")}</div>
      </section>`;
    })
    .join("")}`;

  return moldura(store, {
    titulo: "Área geral",
    caminho: "/ acervo",
    pilula: `${documentos.length} documento(s)`,
    corpo,
    atual: "geral",
    direita: {
      titulo: "Exposto como",
      corpo: oQueSai(
        documentos.map((documento) => ({ uri: uriDoDocumento("geral", documento) })),
        "A área geral fica visível para quem navega. Nenhum run a lê inteira: o harness pede o material de UM projeto.",
      ),
    },
  });
}

function paginaProjeto(store: Store, projeto: Projeto): string {
  const proprios = store.listarProprios(projeto.id);
  const usados = store.listarDoProjeto(projeto.id);
  const selecionados = new Set(store.idsSelecionados(projeto.id));
  const gerais = store.listarGerais();
  const outrosDoAcervo = gerais.filter((documento) => !ehDeCatalogo(documento.tipo));

  // Skills e hooks têm seção própria, com vitrine: repeti-los aqui daria dois
  // lugares para a mesma decisão, e eles divergiriam na cabeça de quem usa.
  const escolha = gerais
    .filter((documento) => !ehDeCatalogo(documento.tipo))
    .map(
      (documento) => `<li><label>
      <input type="checkbox" data-selecao data-projeto="${escapar(projeto.slug)}" value="${documento.id}"
        ${selecionados.has(documento.id) ? "checked" : ""}>
      <span class="etiqueta geral">${escapar(documento.tipo)}</span>
      <span class="titulo">${escapar(documento.titulo)}</span>
    </label></li>`,
    )
    .join("");

  const corpo = `<p class="explicacao">
    O harness lê este projeto com <code>--mcp-project ${escapar(projeto.slug)}</code> e recebe o pedido
    mais <strong>${usados.length}</strong> documento(s). Nada além disso.</p>

  <section class="bloco" id="pedido">
    <h2>Prompt <span class="contagem">o que construir</span></h2>
    <form class="campos" data-json method="put" action="/api/projetos/${escapar(projeto.slug)}">
      <textarea name="pedido" rows="10" placeholder="o que construir neste projeto">${escapar(projeto.pedido)}</textarea>
      <div class="linha-acoes"><button type="submit">salvar pedido</button></div>
    </form>
  </section>

  ${conteineresPara(usados)
    .map((tipo) =>
      ehDeCatalogo(tipo.tipo)
        ? secaoDeCatalogo(store, projeto.slug, tipo, usados)
        : secaoConteiner(usados, tipo, projeto.slug, projeto.slug, false),
    )
    .join("")}

  <section class="bloco">
    <h2>Outros documentos do acervo <span class="contagem">${outrosDoAcervo.filter((documento) => selecionados.has(documento.id)).length} de ${outrosDoAcervo.length}</span></h2>
    <p class="explicacao">Memórias e documentação da área geral que este projeto também usa.</p>
    <ul class="escolha">${escolha || '<li class="vazio">a área geral está vazia</li>'}</ul>
  </section>`;

  const linhas = [
    ...(projeto.pedido.trim() !== "" ? [{ uri: uriDoPedido(projeto.slug) }] : []),
    ...usados.map((documento) => ({ uri: uriDoDocumento(projeto.slug, documento) })),
  ];

  return moldura(store, {
    titulo: projeto.nome,
    caminho: `/ ${projeto.slug}`,
    pilula: projeto.pedido.trim() === "" ? "sem pedido" : `${usados.length} documento(s)`,
    corpo,
    atual: projeto.slug,
    direita: {
      titulo: "O que o harness recebe",
      corpo: oQueSai(
        linhas,
        linhas.length === 0
          ? "Sem pedido e sem documentos: um run neste projeto não teria o que ler."
          : "Nesta ordem, em uma volta só, antes da primeira chamada de modelo.",
      ),
    },
  });
}

/** A rota de uma página, ou `null` quando não existe. */
export function paginaDe(store: Store, url: URL): string | null {
  const partes = url.pathname.split("/").filter((parte) => parte !== "");

  if (partes.length === 0) return paginaGeral(store);

  if (partes[0] === "projetos" && partes[1]) {
    const projeto = store.projetoPorSlug(partes[1]);
    return projeto ? paginaProjeto(store, projeto) : null;
  }

  return null;
}
