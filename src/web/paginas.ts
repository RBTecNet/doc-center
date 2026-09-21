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
import { TIPOS } from "../db/schema.js";
import { uriDoDocumento, uriDoPedido } from "../mcp/server.js";
import { ARQUIVO_SVG, CSS, FONTES, MAIS_SVG, PASTA_SVG, RAIO_SVG } from "./tema.js";

/** Escapa o que veio do usuário. Conteúdo de documento é texto, nunca markup. */
export function escapar(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Moldura {
  titulo: string;
  caminho: string;
  pilula?: string;
  corpo: string;
  direita: { titulo: string; corpo: string };
  atual: string;
}

function moldura(store: Store, pagina: Moldura): string {
  const projetos = store.listarProjetos();
  const itens = projetos
    .map((projeto) => {
      const quantos = store.listarDoProjeto(projeto.id).length;
      return `<a class="${projeto.slug === pagina.atual ? "ativo" : ""}" href="/projetos/${escapar(projeto.slug)}">
        ${PASTA_SVG}<span>${escapar(projeto.nome)}</span><span class="contador">${quantos}</span></a>`;
    })
    .join("");

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
    <nav class="arvore">
      <div class="rotulo">Acervo</div>
      <a class="${pagina.atual === "geral" ? "ativo" : ""}" href="/">
        ${ARQUIVO_SVG}<span>Área geral</span><span class="contador">${store.listarGerais().length}</span></a>
      <div class="rotulo" style="margin-top:12px">Projetos</div>
      ${itens || '<div class="vazio">nenhum ainda</div>'}
    </nav>
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

function formulario(projetoSlug: string | null): string {
  const opcoes = TIPOS.map((tipo) => `<option value="${tipo}">${tipo}</option>`).join("");
  return `<details class="dobra">
  <summary>${MAIS_SVG} novo documento</summary>
  <div class="corpo">
    <form class="campos" data-json method="post" action="/api/documentos">
      ${projetoSlug ? `<input type="hidden" name="projeto" value="${escapar(projetoSlug)}">` : ""}
      <label>título <input name="titulo" required autocomplete="off"></label>
      <label>tipo <select name="tipo">${opcoes}</select></label>
      <label>conteúdo <textarea name="conteudo" rows="12" required></textarea></label>
      <div class="linha-acoes"><button type="submit">salvar</button></div>
    </form>
  </div>
</details>`;
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
  const corpo = `<p class="explicacao">O acervo. O que está aqui pode ser usado por qualquer projeto —
    mas só entra num run depois de o projeto <strong>selecionar</strong>.</p>
  ${formulario(null)}
  <section class="bloco">
    <h2>Documentos <span class="contagem">${documentos.length}</span></h2>
    ${documentos.map((documento) => cartao(documento, uriDoDocumento("geral", documento), true)).join("") || '<p class="vazio">Nada na área geral ainda.</p>'}
  </section>`;

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

  const escolha = gerais
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

  <section class="bloco">
    <h2>Pedido</h2>
    <form class="campos" data-json method="put" action="/api/projetos/${escapar(projeto.slug)}">
      <textarea name="pedido" rows="10" placeholder="o que construir neste projeto">${escapar(projeto.pedido)}</textarea>
      <div class="linha-acoes"><button type="submit">salvar pedido</button></div>
    </form>
  </section>

  <section class="bloco">
    <h2>Da área geral <span class="contagem">${selecionados.size} de ${gerais.length}</span></h2>
    <p class="explicacao">Marque o que este projeto usa. Desmarcado não chega ao harness.</p>
    <ul class="escolha">${escolha || '<li class="vazio">a área geral está vazia</li>'}</ul>
  </section>

  <section class="bloco">
    <h2>Documentos do projeto <span class="contagem">${proprios.length}</span></h2>
    ${formulario(projeto.slug)}
    ${proprios.map((documento) => cartao(documento, uriDoDocumento(projeto.slug, documento))).join("") || '<p class="vazio">Nenhum documento próprio.</p>'}
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
