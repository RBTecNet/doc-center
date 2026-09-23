/**
 * As duas portas da aplicação, num processo só.
 *
 *     /            a interface, para quem escreve e organiza
 *     /mcp         o protocolo, para o harness e para os agentes
 *     /api/...     o que a interface usa, em JSON
 *
 * Um processo e um banco: a alternativa era um servidor MCP separado lendo o
 * mesmo arquivo, e dois caminhos para o mesmo dado divergem no dia em que uma
 * regra muda. Quando isto virar multi-tenant, o lugar de decidir quem vê o quê
 * já é um só.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { ErroDeUso, Store } from "./db/store.js";
import { handle, type RpcRequest } from "./mcp/server.js";
import { rotaApi } from "./web/api.js";
import { paginaDe } from "./web/paginas.js";
import { paginaDeRuns } from "./web/runs.js";

export interface AppOptions {
  store: Store;
  /** Porta 0 pede uma livre ao sistema — é o que os testes usam. */
  port?: number;
  host?: string;
  /**
   * A pasta onde moram os projetos do capivara, para o visor de runs.
   *
   * Ausente desliga o visor, e é o padrão: ele é uma comodidade sobre arquivos
   * que já existem, nunca um requisito de nada.
   */
  runsRoot?: string;
}

async function corpo(req: IncomingMessage): Promise<string> {
  const partes: Buffer[] = [];
  for await (const pedaco of req) partes.push(pedaco as Buffer);
  return Buffer.concat(partes).toString("utf8");
}

export function responderJson(res: ServerResponse, status: number, dado: unknown): void {
  const texto = JSON.stringify(dado);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(texto) });
  res.end(texto);
}

function responderHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

export function createApp(options: AppOptions): Server {
  const { store } = options;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const caminho = url.pathname;

      try {
        if (caminho === "/mcp") {
          if (req.method !== "POST") {
            // O transporte também define GET para fluxo de eventos do servidor.
            // Não temos nada a empurrar, e dizer isso é melhor que abrir um
            // fluxo que nunca emite — o cliente ficaria esperando.
            res.writeHead(405, { allow: "POST" }).end();
            return;
          }

          const texto = await corpo(req);
          let pedido: RpcRequest;
          try {
            pedido = JSON.parse(texto) as RpcRequest;
          } catch {
            responderJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } });
            return;
          }

          const resposta = handle(store, pedido);
          // Notificação: 202 sem corpo, como o protocolo pede.
          if (resposta === null) {
            res.writeHead(202).end();
            return;
          }
          responderJson(res, 200, resposta);
          return;
        }

        /*
         * O script da interface. Servir um arquivo só, por caminho fixo, evita
         * um servidor de estáticos inteiro — e evita junto a classe de defeito
         * que ele traz, que é servir qualquer coisa fora da pasta.
         */
        if (caminho === "/app.js") {
          const arquivo = new URL("../public/app.js", import.meta.url);
          const script = await readFile(arquivo, "utf8").catch(() => null);
          if (script === null) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          res.end(script);
          return;
        }

        if (caminho.startsWith("/api/")) {
          await rotaApi(store, req, res, url);
          return;
        }

        const visor = await paginaDeRuns(store, url, options.runsRoot ?? null);
        if (visor !== null) {
          responderHtml(res, 200, visor);
          return;
        }

        const pagina = paginaDe(store, url);
        if (pagina === null) {
          responderHtml(res, 404, "<!doctype html><meta charset=utf-8><title>não encontrado</title><p>Não encontrado.");
          return;
        }
        responderHtml(res, 200, pagina);
      } catch (erro) {
        // O erro vai para a resposta, não só para o log: quem está usando a
        // interface precisa saber o que aconteceu sem ir procurar no terminal.
        // E erro de uso responde 400: 500 mandaria procurar defeito no servidor.
        const status = erro instanceof ErroDeUso ? 400 : 500;
        responderJson(res, status, { erro: erro instanceof Error ? erro.message : String(erro) });
      }
    })();
  });
}

export async function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const endereco = server.address();
  return typeof endereco === "object" && endereco ? endereco.port : port;
}
