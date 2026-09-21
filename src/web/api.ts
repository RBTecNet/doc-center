/**
 * O que a interface usa.
 *
 * JSON simples sobre o Store — nenhuma regra mora aqui, porque regra que mora
 * na borda é regra que o MCP não conhece. A interface e o protocolo leem e
 * escrevem exatamente o mesmo dado, pelas mesmas funções.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../db/store.js";
import { responderJson } from "../http.js";

async function corpoJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const partes: Buffer[] = [];
  for await (const pedaco of req) partes.push(pedaco as Buffer);
  const texto = Buffer.concat(partes).toString("utf8");
  if (texto.trim() === "") return {};
  return JSON.parse(texto) as Record<string, unknown>;
}

const texto = (valor: unknown): string => (typeof valor === "string" ? valor : "");

export async function rotaApi(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const partes = url.pathname.split("/").filter((parte) => parte !== "");
  // partes[0] é sempre "api"
  const recurso = partes[1] ?? "";
  const metodo = req.method ?? "GET";

  if (recurso === "projetos") {
    const slug = partes[2];

    if (metodo === "GET" && !slug) {
      responderJson(res, 200, { projetos: store.listarProjetos() });
      return;
    }

    if (metodo === "POST" && !slug) {
      const dados = await corpoJson(req);
      const projeto = store.criarProjeto({
        nome: texto(dados.nome),
        slug: texto(dados.slug),
        descricao: texto(dados.descricao),
        pedido: texto(dados.pedido),
      });
      responderJson(res, 201, { projeto });
      return;
    }

    if (slug) {
      const projeto = store.projetoPorSlug(slug);
      if (!projeto) {
        responderJson(res, 404, { erro: `projeto "${slug}" não existe` });
        return;
      }

      if (metodo === "GET" && partes[3] === undefined) {
        responderJson(res, 200, {
          projeto,
          usados: store.listarDoProjeto(projeto.id),
          proprios: store.listarProprios(projeto.id),
          selecionados: store.idsSelecionados(projeto.id),
        });
        return;
      }

      if (metodo === "PUT" && partes[3] === undefined) {
        const dados = await corpoJson(req);
        responderJson(res, 200, {
          projeto: store.atualizarProjeto(slug, {
            ...(typeof dados.nome === "string" ? { nome: dados.nome } : {}),
            ...(typeof dados.descricao === "string" ? { descricao: dados.descricao } : {}),
            ...(typeof dados.pedido === "string" ? { pedido: dados.pedido } : {}),
          }),
        });
        return;
      }

      if (metodo === "DELETE" && partes[3] === undefined) {
        store.removerProjeto(slug);
        responderJson(res, 200, { removido: slug });
        return;
      }

      // Seleção: o projeto passa a usar (ou deixa de usar) um documento da geral.
      if (partes[3] === "selecoes") {
        const documentoId = Number(partes[4] ?? (await corpoJson(req)).documentoId);
        if (!Number.isInteger(documentoId)) {
          responderJson(res, 400, { erro: "informe o id do documento" });
          return;
        }
        if (metodo === "POST" || metodo === "PUT") {
          store.selecionar(projeto.id, documentoId);
          responderJson(res, 200, { selecionados: store.idsSelecionados(projeto.id) });
          return;
        }
        if (metodo === "DELETE") {
          store.desselecionar(projeto.id, documentoId);
          responderJson(res, 200, { selecionados: store.idsSelecionados(projeto.id) });
          return;
        }
      }
    }
  }

  if (recurso === "documentos") {
    const id = Number(partes[2] ?? "");

    if (metodo === "GET" && !partes[2]) {
      const projetoSlug = url.searchParams.get("projeto");
      if (projetoSlug) {
        const projeto = store.projetoPorSlug(projetoSlug);
        if (!projeto) {
          responderJson(res, 404, { erro: `projeto "${projetoSlug}" não existe` });
          return;
        }
        responderJson(res, 200, { documentos: store.listarProprios(projeto.id) });
        return;
      }
      responderJson(res, 200, { documentos: store.listarGerais() });
      return;
    }

    if (metodo === "POST" && !partes[2]) {
      const dados = await corpoJson(req);
      const projetoSlug = texto(dados.projeto);
      const projeto = projetoSlug ? store.projetoPorSlug(projetoSlug) : null;
      if (projetoSlug && !projeto) {
        responderJson(res, 404, { erro: `projeto "${projetoSlug}" não existe` });
        return;
      }
      const documento = store.criarDocumento({
        projetoId: projeto ? projeto.id : null,
        tipo: texto(dados.tipo) || "documento",
        titulo: texto(dados.titulo),
        slug: texto(dados.slug),
        conteudo: texto(dados.conteudo),
      });
      responderJson(res, 201, { documento });
      return;
    }

    if (Number.isInteger(id)) {
      if (metodo === "GET") {
        const documento = store.documentoPorId(id);
        if (!documento) {
          responderJson(res, 404, { erro: `documento ${id} não existe` });
          return;
        }
        responderJson(res, 200, { documento });
        return;
      }
      if (metodo === "PUT") {
        const dados = await corpoJson(req);
        responderJson(res, 200, {
          documento: store.atualizarDocumento(id, {
            ...(typeof dados.titulo === "string" ? { titulo: dados.titulo } : {}),
            ...(typeof dados.conteudo === "string" ? { conteudo: dados.conteudo } : {}),
          }),
        });
        return;
      }
      if (metodo === "DELETE") {
        store.removerDocumento(id);
        responderJson(res, 200, { removido: id });
        return;
      }
    }
  }

  responderJson(res, 404, { erro: `rota desconhecida: ${metodo} ${url.pathname}` });
}
