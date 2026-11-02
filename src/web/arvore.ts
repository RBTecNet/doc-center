/**
 * A árvore da lateral.
 *
 * Dois níveis que abrem: o projeto, e dentro dele cada contêiner. É a mesma
 * forma da referência do console — pasta âmbar quando aberta, cinza quando
 * fechada, e uma guia vertical marcando a profundidade.
 *
 * Os contêineres aparecem sempre, mesmo vazios. Um projeto recém-criado mostra
 * Prompt, Skills, Memórias, Hooks e Documentação de cara, e a pergunta "onde eu
 * ponho isto?" já tem resposta na tela antes de existir qualquer conteúdo.
 *
 * `<details>` faz o trabalho de abrir e fechar sem JavaScript; o script só
 * lembra o que estava aberto entre uma navegação e outra.
 */

import type { Documento, Projeto } from "../db/schema.js";
import { conteineresPara } from "../db/schema.js";
import { escapar } from "./escapar.js";
import { ARQUIVO_SVG, LIXEIRA_SVG, PASTA_ABERTA_SVG, PASTA_SVG, SETA_SVG, TEXTO_SVG } from "./tema.js";

export interface ConteudoDoProjeto {
  projeto: Projeto;
  documentos: Documento[];
}

function item(href: string, icone: string, rotulo: string, profundidade: number, ativo = false): string {
  return `<a class="folha${ativo ? " ativo" : ""}" href="${href}" style="--nivel:${profundidade}">
    ${guias(profundidade)}${icone}<span class="rotulo-item">${escapar(rotulo)}</span></a>`;
}

/** As guias verticais que marcam a profundidade, como na referência. */
function guias(quantas: number): string {
  return '<span class="guia"></span>'.repeat(quantas);
}

function conteiner(
  chave: string,
  titulo: string,
  documentos: Documento[],
  hrefBase: string,
  profundidade: number,
  aberto: boolean,
): string {
  const filhos =
    documentos.length === 0
      ? `<div class="folha vazia" style="--nivel:${profundidade + 1}">${guias(profundidade + 1)}<span class="rotulo-item">vazio</span></div>`
      : documentos
          .map((documento) => item(`${hrefBase}#doc-${documento.id}`, TEXTO_SVG, documento.titulo, profundidade + 1))
          .join("");

  return `<details class="ramo" data-chave="${escapar(chave)}"${aberto ? " open" : ""}>
    <summary style="--nivel:${profundidade}">
      ${guias(profundidade)}${SETA_SVG}
      <span class="icone-pasta">${PASTA_SVG}</span><span class="icone-pasta-aberta">${PASTA_ABERTA_SVG}</span>
      <span class="rotulo-item">${escapar(titulo)}</span>
      <span class="contador">${documentos.length}</span>
    </summary>
    ${filhos}
  </details>`;
}

export function renderArvore(
  gerais: Documento[],
  projetos: ConteudoDoProjeto[],
  atual: string,
): string {
  const areaGeral = `<details class="ramo" data-chave="geral"${atual === "geral" ? " open" : ""}>
    <summary style="--nivel:0">
      ${SETA_SVG}
      <span class="icone-pasta">${PASTA_SVG}</span><span class="icone-pasta-aberta">${PASTA_ABERTA_SVG}</span>
      <a class="titulo-ramo${atual === "geral" ? " ativo" : ""}" href="/">Área geral</a>
      <span class="contador">${gerais.length}</span>
    </summary>
    ${conteineresPara(gerais)
      .map((tipo) =>
        conteiner(
          `geral:${tipo.tipo}`,
          tipo.titulo,
          gerais.filter((documento) => documento.tipo === tipo.tipo),
          "/",
          1,
          false,
        ),
      )
      .join("")}
  </details>`;

  const ramos = projetos
    .map(({ projeto, documentos }) => {
      const ativo = projeto.slug === atual;
      const href = `/projetos/${escapar(projeto.slug)}`;
      const pedido = `<a class="folha${projeto.pedido.trim() === "" ? " vazia" : ""}" href="${href}#pedido" style="--nivel:1">
        ${guias(1)}${ARQUIVO_SVG}<span class="rotulo-item">Prompt</span>
        <span class="contador">${projeto.pedido.trim() === "" ? "vazio" : "1"}</span></a>`;

      return `<details class="ramo" data-chave="projeto:${escapar(projeto.slug)}"${ativo ? " open" : ""}>
        <summary style="--nivel:0">
          ${SETA_SVG}
          <span class="icone-pasta">${PASTA_SVG}</span><span class="icone-pasta-aberta">${PASTA_ABERTA_SVG}</span>
          <a class="titulo-ramo${ativo ? " ativo" : ""}" href="${href}">${escapar(projeto.nome)}</a>
          <span class="contador">${documentos.length}</span>
          <button class="lixeira" title="excluir projeto"
            data-remover-projeto="${escapar(projeto.slug)}"
            data-nome="${escapar(projeto.nome)}"
            data-proprios="${documentos.filter((documento) => documento.projetoId === projeto.id).length}">${LIXEIRA_SVG}</button>
        </summary>
        ${pedido}
        ${item(`${href}#historico`, TEXTO_SVG, "Histórico de conversas", 1)}
        ${conteineresPara(documentos)
          .map((tipo) =>
            conteiner(
              `projeto:${projeto.slug}:${tipo.tipo}`,
              tipo.titulo,
              documentos.filter((documento) => documento.tipo === tipo.tipo),
              href,
              1,
              false,
            ),
          )
          .join("")}
      </details>`;
    })
    .join("");

  return `<div class="rotulo">Acervo</div>
    ${areaGeral}
    <div class="rotulo" style="margin-top:12px">Projetos</div>
    ${ramos || '<div class="folha vazia" style="--nivel:0"><span class="rotulo-item">nenhum ainda</span></div>'}`;
}
