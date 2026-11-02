/** Uma identidade é resolvida antes de abrir qualquer porta para os dados. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AuthStore, DURACAO_SESSAO } from "./auth.js";
import { ErroDeUso, Store } from "./db/store.js";
import { handle } from "./mcp/server.js";
import { corpoJson, HttpError, lerCorpo } from "./request.js";
import { rotaApi } from "./web/api.js";
import { paginaDe } from "./web/paginas.js";
import { dentroDa, paginaDeRuns } from "./web/runs.js";
import { paginaDaConta, paginaDeEntrada } from "./web/conta.js";

export interface AppOptions {
  store: Store;
  port?: number;
  host?: string;
  /** Os runs de cada conta ficam em <runsRoot>/<usuarioId>/<projeto>/.capivara/runs. */
  runsRoot?: string;
  /** Origem pública exata. Em HTTPS, habilita cookies Secure atrás do proxy. */
  publicUrl?: string;
  /** Rotas oferecidas por este listener; o modo combinado preserva integrações existentes. */
  surface?: "web" | "mcp" | "all";
  /** Endpoint MCP absoluto mostrado na conta, inclusive quando usa outro listener. */
  mcpPublicUrl?: string;
  /** Confia em X-Real-IP somente quando um proxy local autorizado sobrescreve o cabeçalho. */
  trustedProxy?: "loopback";
  registration?: "open" | "closed";
  auth?: AuthStore;
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

function redirecionar(res: ServerResponse, caminho: string): void { res.writeHead(303, { location: caminho }).end(); }
const texto = (valor: unknown): string => typeof valor === "string" ? valor : "";

function cookie(req: IncomingMessage): string {
  const valor = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith("doc_center_session="));
  return valor?.slice("doc_center_session=".length) ?? "";
}

function hostCanonico(valor: string, protocolo: string): string | null {
  if (!valor || /[\s\\/@?#]/.test(valor)) return null;
  try {
    const url = new URL(`${protocolo}//${valor}`);
    return url.hostname && !url.username && !url.password && url.pathname === "/" ? url.host.toLowerCase() : null;
  } catch { return null; }
}

function ipParaLimite(req: IncomingMessage, trustedProxy: AppOptions["trustedProxy"]): string {
  const endereco = req.socket.remoteAddress ?? "local";
  if (trustedProxy !== "loopback" || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(endereco.toLowerCase())) return endereco;
  const encaminhado = req.headers["x-real-ip"];
  // Um valor ausente, inválido ou repetido conserva a chave real da conexão.
  return typeof encaminhado === "string" && isIP(encaminhado) !== 0 && req.headersDistinct["x-real-ip"]?.length === 1
    ? encaminhado : endereco;
}

export function createApp(options: AppOptions): Server {
  const { store } = options;
  const auth = options.auth ?? new AuthStore(store);
  const superficie = options.surface ?? "all";
  if (!["web", "mcp", "all"].includes(superficie)) throw new Error("surface precisa ser web, mcp ou all");
  const enderecoPublico = options.publicUrl ? new URL(options.publicUrl) : null;
  if (enderecoPublico && (!["http:", "https:"].includes(enderecoPublico.protocol) || enderecoPublico.username || enderecoPublico.password)) {
    throw new Error("DOC_CENTER_PUBLIC_URL precisa ser HTTP ou HTTPS, sem credenciais");
  }
  const origemPublica = enderecoPublico?.origin ?? null;
  const enderecoMcp = options.mcpPublicUrl === undefined ? null : new URL(options.mcpPublicUrl);
  if (enderecoMcp && (!["http:", "https:"].includes(enderecoMcp.protocol) || enderecoMcp.username || enderecoMcp.password ||
    enderecoMcp.search || enderecoMcp.hash || enderecoMcp.pathname !== "/mcp")) {
    throw new Error("mcpPublicUrl precisa ser um endpoint HTTP ou HTTPS /mcp, sem credenciais, consulta ou fragmento");
  }
  const tentativas = new Map<string, { inicio: number; quantidade: number }>();
  let autenticacoes = 0;

  return createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("x-frame-options", "DENY");
    void (async () => {
      try {
        const endereco = req.socket.localAddress?.includes(":") ? `[${req.socket.localAddress}]` : req.socket.localAddress ?? "127.0.0.1";
        const porta = req.socket.localPort ?? 7777;
        const origemLocal = new URL(`http://${endereco}:${porta}`).origin;
        const origem = origemPublica ?? origemLocal;
        const url = new URL(req.url ?? "/", origem);
        const caminho = url.pathname;
        // Host não pode definir a lista confiável: isso permitiria DNS rebinding.
        const hostsLocais = [endereco, "127.0.0.1", "localhost", "[::1]"];
        if (options.host && !["0.0.0.0", "::"].includes(options.host)) hostsLocais.push(options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host);
        const permitidos = new Set(hostsLocais.map((host) => hostCanonico(`${host}:${porta}`, "http:")).filter((host) => host !== null));
        const host = req.headers.host ?? "";
        const hostLocal = hostCanonico(host, "http:");
        const hostPublico = enderecoPublico ? hostCanonico(host, enderecoPublico.protocol) : null;
        if (!(hostLocal && permitidos.has(hostLocal)) && !(enderecoPublico && hostPublico === enderecoPublico.host.toLowerCase())) {
          throw new HttpError(403, "host não permitido; configure DOC_CENTER_PUBLIC_URL para acesso remoto");
        }
        const permitido = (valor: string): boolean => {
          try {
            const candidato = new URL(valor);
            if (candidato.username || candidato.password || candidato.pathname !== "/" || candidato.search || candidato.hash) return false;
            if (candidato.origin === origem) return true;
            return !origemPublica && candidato.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(candidato.hostname) && (candidato.port || "80") === String(porta);
          } catch { return false; }
        };
        if (req.headers.origin && !permitido(req.headers.origin)) throw new HttpError(403, "origem não permitida");
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") && req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "requisição de outra origem recusada");
        if ((superficie === "mcp" && caminho !== "/mcp") || (superficie === "web" && caminho === "/mcp")) {
          res.writeHead(404).end();
          return;
        }
        const sessao = cookie(req);
        const usuario = auth.usuarioDaSessao(sessao);
        const seguro = origem.startsWith("https:");
        const definirSessao = (segredo: string): void => { res.setHeader("set-cookie", `doc_center_session=${segredo}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACAO_SESSAO / 1000}${seguro ? "; Secure" : ""}`); };

        if (caminho === "/app.js" && req.method === "GET") {
          const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8").catch(() => null);
          if (script === null) { res.writeHead(404).end(); return; }
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(script);
          return;
        }
        if (["/login", "/cadastro"].includes(caminho) && req.method === "GET") {
          if (usuario) { redirecionar(res, "/"); return; }
          if (caminho === "/cadastro" && options.registration === "closed" && auth.temUsuarios()) {
            responderHtml(res, 403, "<!doctype html><meta charset=utf-8><p>O cadastro de novas contas está fechado. <a href='/login'>Entrar</a></p>");
            return;
          }
          responderHtml(res, 200, paginaDeEntrada(caminho === "/login" ? "login" : "cadastro", !auth.temUsuarios()));
          return;
        }
        if (["/api/auth/register", "/api/auth/login"].includes(caminho) && req.method === "POST") {
          const chave = ipParaLimite(req, options.trustedProxy);
          const agora = Date.now();
          if (tentativas.size >= 10_000) {
            for (const [ip, limite] of tentativas) if (agora - limite.inicio >= 600_000) tentativas.delete(ip);
            if (tentativas.size >= 10_000 && !tentativas.has(chave)) throw new HttpError(429, "muitas tentativas; tente novamente mais tarde");
          }
          let limite = tentativas.get(chave);
          if (!limite || agora - limite.inicio >= 600_000) { limite = { inicio: agora, quantidade: 0 }; tentativas.set(chave, limite); }
          if (++limite.quantidade > 20 || autenticacoes >= 4) {
            res.setHeader("retry-after", "600");
            throw new HttpError(429, "muitas tentativas; tente novamente mais tarde");
          }
          const dados = await corpoJson(req, 16_384);
          // A leitura do corpo cede o processo. Pedidos simultâneos precisam
          // revalidar a capacidade antes de iniciar a derivação da senha.
          if (autenticacoes >= 4) {
            res.setHeader("retry-after", "1");
            throw new HttpError(429, "muitas tentativas; tente novamente mais tarde");
          }
          autenticacoes++;
          try {
            const conta = caminho.endsWith("register")
              ? await auth.registrar({ nome: texto(dados.nome), email: texto(dados.email), senha: texto(dados.senha) }, options.registration !== "closed")
              : await auth.entrar(texto(dados.email), texto(dados.senha));
            if (!conta) throw new HttpError(401, "email ou senha inválidos");
            definirSessao(auth.criarSessao(conta.id));
            responderJson(res, caminho.endsWith("register") ? 201 : 200, { usuario: conta });
          } finally { autenticacoes--; }
          return;
        }

        if (caminho === "/mcp") {
          const autorizacao = req.headers.authorization ?? "";
          const identidade = /^Bearer /i.test(autorizacao) ? auth.identidadeDoToken(autorizacao.slice(7)) : null;
          if (!identidade) {
            res.setHeader("www-authenticate", 'Bearer realm="doc-center"');
            throw new HttpError(401, "envie um token válido em Authorization: Bearer <token>");
          }
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
          const corpo = await lerCorpo(req, 8 * 1024 * 1024);
          let pedido: unknown;
          try { pedido = JSON.parse(corpo); }
          catch { responderJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }); return; }
          const escopo = store.forUser(identidade.usuario.id, identidade.credencial?.projeto ?? undefined);
          const resposta = handle(escopo, pedido, { readOnly: identidade.credencial?.permissao === "leitura" });
          if (resposta === null) { res.writeHead(202).end(); return; }
          responderJson(res, 200, resposta);
          return;
        }

        if (!usuario) {
          if (caminho.startsWith("/api/")) throw new HttpError(401, "entre na sua conta para continuar");
          redirecionar(res, auth.temUsuarios() ? "/login" : "/cadastro");
          return;
        }
        if (req.headers.authorization) throw new HttpError(403, "tokens de CLI são aceitos somente em /mcp");
        const escopo = store.forUser(usuario.id);
        if (caminho === "/api/auth/me" && req.method === "GET") { responderJson(res, 200, { usuario }); return; }
        if (caminho === "/api/auth/logout" && req.method === "POST") {
          auth.encerrarSessao(sessao);
          res.setHeader("set-cookie", `doc_center_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${seguro ? "; Secure" : ""}`);
          res.writeHead(204).end(); return;
        }
        if (caminho === "/api/tokens") {
          if (req.method === "GET") { responderJson(res, 200, { tokens: auth.listarTokens(usuario.id) }); return; }
          if (req.method === "POST") {
            const dados = await corpoJson(req, 16_384);
            if (dados.projeto !== undefined && typeof dados.projeto !== "string") throw new HttpError(400, "o projeto deve ser um slug em texto");
            responderJson(res, 201, auth.criarToken(usuario.id, {
              nome: texto(dados.nome),
              ...(dados.projeto === undefined || dados.projeto === "" ? {} : { projeto: texto(dados.projeto) }),
              ...(dados.permissao === undefined ? {} : { permissao: texto(dados.permissao) }),
              ...(dados.dias === undefined ? {} : { dias: Number(dados.dias) }),
            }));
            return;
          }
        }
        if (/^\/api\/tokens\/\d+$/.test(caminho) && req.method === "DELETE") {
          if (!auth.revogarToken(usuario.id, Number(caminho.split("/").at(-1)))) throw new HttpError(404, "token não encontrado");
          res.writeHead(204).end(); return;
        }
        if (caminho === "/conta" && req.method === "GET") { responderHtml(res, 200, paginaDaConta(escopo, usuario, auth.listarTokens(usuario.id), enderecoMcp?.href ?? `${origem}/mcp`)); return; }
        if (caminho.startsWith("/api/")) { await rotaApi(escopo, req, res, url); return; }
        if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }).end(); return; }
        let baseRuns: string | null = null;
        if (options.runsRoot) {
          const raiz = await realpath(options.runsRoot).catch(() => null);
          if (raiz) {
            const pasta = join(raiz, String(usuario.id));
            const real = await realpath(pasta).catch(() => pasta);
            if (dentroDa(raiz, real) && real === pasta) baseRuns = pasta;
          }
        }
        const visor = await paginaDeRuns(escopo, url, baseRuns);
        if (visor !== null) { responderHtml(res, 200, visor); return; }
        const pagina = paginaDe(escopo, url);
        responderHtml(res, pagina === null ? 404 : 200, pagina ?? "<!doctype html><meta charset=utf-8><title>não encontrado</title><p>Não encontrado.");
      } catch (erro) {
        const status = erro instanceof HttpError ? erro.status : erro instanceof ErroDeUso ? 400 : 500;
        responderJson(res, status, { erro: status === 500 ? "erro interno do servidor" : erro instanceof Error ? erro.message : String(erro) });
      }
    })();
  });
}

export async function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const endereco = server.address();
  return typeof endereco === "object" && endereco ? endereco.port : port;
}
