/**
 * O catálogo de skills e hooks.
 *
 * A diferença entre isto e uma lista de documentos é a pergunta que cada uma
 * responde. Uma lista responde "o que existe aqui". Um catálogo responde "isto
 * serve para o meu caso?" — e para responder essa, o cartão precisa dizer o que
 * a skill faz, **quando usá-la** e **quando não**. Esses três campos são o que
 * separa um acervo navegável de uma pasta com arquivos dentro.
 *
 * No lugar do comando de instalação que um catálogo público exibiria, aqui vai o
 * gesto que faz sentido para nós: adotar no projeto. É um clique, e o efeito é
 * imediato — a skill passa a fazer parte do que o harness recebe.
 */

import type { Documento } from "../db/schema.js";
import { AREAS, SEM_CATEGORIA } from "../db/schema.js";
import { escapar } from "./escapar.js";
import { MAIS_SVG } from "./tema.js";

export function categoriaDe(documento: Documento): string {
  return documento.categoria.trim() === "" ? SEM_CATEGORIA : documento.categoria.trim();
}

/** Uma linha de "quando usar" ou "quando não usar", quando houver. */
function faixa(rotulo: string, texto: string, classe: string): string {
  if (texto.trim() === "") return "";
  return `<div class="faixa ${classe}"><span class="faixa-rotulo">${escapar(rotulo)}</span>
    <span>${escapar(texto)}</span></div>`;
}

export interface OpcaoDeAdocao {
  /** O projeto que está adotando; ausente no catálogo geral. */
  projetoSlug?: string;
  adotado?: boolean;
}

export function cartaoDeCatalogo(documento: Documento, adocao: OpcaoDeAdocao = {}): string {
  const acao = adocao.projetoSlug
    ? `<button class="${adocao.adotado ? "discreto" : ""}" data-adotar="${documento.id}"
         data-projeto="${escapar(adocao.projetoSlug)}" data-estado="${adocao.adotado ? "sim" : "nao"}">
         ${adocao.adotado ? "remover do projeto" : `${MAIS_SVG} adicionar ao projeto`}</button>`
    : `<button class="discreto" data-editar="${documento.id}">editar</button>
       <button class="discreto perigo" data-remover="${documento.id}">remover</button>`;

  const pacote = documento.arquivos ?? [];
  const arquivos =
    pacote.length === 0
      ? ""
      : `<details class="pacote"><summary>${pacote.length} arquivo(s) no pacote</summary>
         <ul>${pacote
           .map(
             (arquivo) =>
               `<li><code>${escapar(arquivo.caminho)}</code>${arquivo.binario ? '<span class="binario">binário</span>' : ""}</li>`,
           )
           .join("")}</ul></details>`;

  const procedencia =
    documento.versao || documento.fonte
      ? `<div class="procedencia">${escapar(documento.versao ? `v${documento.versao}` : "")}
         ${documento.fonte ? `<a href="${escapar(documento.fonte)}" target="_blank" rel="noreferrer">origem</a>` : ""}</div>`
      : "";

  return `<article class="vitrine${adocao.adotado ? " adotado" : ""}" data-id="${documento.id}"
    data-categoria="${escapar(categoriaDe(documento))}"
    data-busca="${escapar(`${documento.titulo} ${documento.descricao} ${documento.gatilhos} ${categoriaDe(documento)} ${documento.area}`.toLowerCase())}">
  <header>
    <h3>${escapar(documento.titulo)}</h3>
    <span class="area area-${escapar(documento.area)}">${escapar(documento.area)}</span>
    <span class="categoria">${escapar(categoriaDe(documento))}</span>
  </header>
  ${documento.descricao.trim() === "" ? '<p class="sem-descricao">sem descrição</p>' : `<p class="descricao">${escapar(documento.descricao)}</p>`}
  ${faixa("usar quando", documento.gatilhos, "usar")}
  ${faixa("não usar para", documento.restricoes, "evitar")}
  ${arquivos}
  ${procedencia}
  <footer>
    <code>${escapar(documento.tipo)}/${escapar(documento.slug)}</code>
    <div class="acoes">${acao}</div>
  </footer>
</article>`;
}

/** A barra de busca e categorias. Filtra no cliente: o acervo é pequeno. */
export function filtros(categorias: { categoria: string; quantos: number }[], total: number): string {
  const botoes = categorias
    .map(
      (categoria) =>
        `<button class="filtro" data-categoria="${escapar(categoria.categoria)}">
          ${escapar(categoria.categoria)} <span class="contagem">${categoria.quantos}</span></button>`,
    )
    .join("");

  return `<div class="filtros">
    <input class="busca" type="search" placeholder="buscar por nome, descrição ou gatilho" data-busca>
    <div class="categorias">
      <button class="filtro ativo" data-categoria="">Todas <span class="contagem">${total}</span></button>
      ${botoes}
    </div>
  </div>`;
}

/**
 * O formulário de cadastro de uma skill ou hook.
 *
 * Os campos da vitrine são opcionais no banco e pedidos aqui, porque uma skill
 * sem "quando usar" é uma skill que ninguém vai saber escolher — e escolher é a
 * única coisa que se faz com ela.
 */
export function formularioDeCatalogo(tipo: string, singular: string): string {
  return `<details class="dobra">
  <summary>${MAIS_SVG} ${escapar(singular)}</summary>
  <div class="corpo">
    <form class="campos" data-json method="post" action="/api/documentos">
      <input type="hidden" name="tipo" value="${escapar(tipo)}">
      <div class="dois">
        <label>título <input name="titulo" required autocomplete="off"></label>
        <label>categoria <input name="categoria" placeholder="Desenvolvimento, Qualidade…" autocomplete="off"></label>
      </div>
      <label>área <select name="area">${AREAS.map((area) => `<option value="${area}">${area}</option>`).join("")}</select></label>
      <label>descrição <input name="descricao" placeholder="o que faz, em uma linha" autocomplete="off"></label>
      <div class="dois">
        <label>usar quando <input name="gatilhos" placeholder="revisar PR, escrever teste…" autocomplete="off"></label>
        <label>não usar para <input name="restricoes" placeholder="o que está fora do escopo" autocomplete="off"></label>
      </div>
      <label>conteúdo <textarea name="conteudo" rows="14" required
        placeholder="as instruções que o agente vai receber"></textarea></label>
      <div class="linha-acoes"><button type="submit">salvar</button></div>
    </form>
  </div>
</details>`;
}

/**
 * Importar um pacote.
 *
 * O zip é o formato em que as skills circulam, e o frontmatter dentro dele já
 * descreve a skill — por isso aqui se pede quase nada: o arquivo e a área. O
 * resto é lido de dentro.
 */
export function formularioDePacote(tipo: string): string {
  return `<details class="dobra">
  <summary>${MAIS_SVG} importar pacote (.zip)</summary>
  <div class="corpo">
    <form class="campos" data-pacote data-tipo="${escapar(tipo)}">
      <label>arquivo <input type="file" name="zip" accept=".zip,application/zip" required></label>
      <label>área <select name="area">${AREAS.map((area) => `<option value="${area}">${area}</option>`).join("")}</select></label>
      <label>categoria <input name="categoria" placeholder="opcional; o pacote não declara" autocomplete="off"></label>
      <p class="explicacao">Nome, descrição, quando usar e procedência saem do frontmatter do SKILL.md.</p>
      <div class="linha-acoes"><button type="submit">importar</button></div>
    </form>
  </div>
</details>`;
}
