import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { criarPluginOpenCode } from "./opencode-plugin.js";

export interface OpcoesIntegracao {
  cliente: "codex" | "claude" | "opencode";
  diretorio: string;
  comando: string[];
  projeto?: string;
  url?: string;
}

type Objeto = Record<string, unknown>;
function objeto(valor: unknown, nome: string): Objeto {
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) throw new Error(`${nome} deve ser um objeto`);
  return valor as Objeto;
}
function subobjeto(pai: Objeto, chave: string): Objeto {
  const atual = pai[chave] === undefined ? {} : objeto(pai[chave], chave);
  pai[chave] = atual;
  return atual;
}

/** Aspas POSIX; conteúdo de configuração nunca vira expansão de shell. */
function citar(valor: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(valor) ? valor : `'${valor.replaceAll("'", "'\"'\"'")}'`;
}

function semComentariosJSON(texto: string): string {
  let saida = "";
  let string = false;
  let escapado = false;
  for (let i = 0; i < texto.length; i++) {
    const char = texto[i]!;
    if (string) {
      saida += char;
      if (escapado) escapado = false;
      else if (char === "\\") escapado = true;
      else if (char === '"') string = false;
    } else if (char === '"') { string = true; saida += char; }
    else if (char === "/" && texto[i + 1] === "/") {
      while (i < texto.length && texto[i] !== "\n") i++;
      saida += "\n";
    } else if (char === "/" && texto[i + 1] === "*") {
      i += 2;
      while (i < texto.length && !(texto[i] === "*" && texto[i + 1] === "/")) i++;
      if (i >= texto.length) throw new Error("comentário JSONC não terminado");
      i++;
      saida += " ";
    } else if (char === ",") {
      let proximo = i + 1;
      while (/\s/.test(texto[proximo] ?? "")) proximo++;
      if (texto[proximo] !== "}" && texto[proximo] !== "]") saida += char;
    } else saida += char;
  }
  // Segunda passagem trata vírgulas seguidas de comentários.
  if (saida !== texto && /\/[/\*]/.test(texto)) return semComentariosJSON(saida);
  return saida;
}

function configurarHooks(config: Objeto, command: string, cliente: string): void {
  const hooks = subobjeto(config, "hooks");
  const marcador = ` # doc-center-managed:${cliente}`;
  const gerenciado = command + marcador;
  for (const evento of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    const grupos = hooks[evento] === undefined ? [] : hooks[evento];
    if (!Array.isArray(grupos)) throw new Error(`hooks.${evento} deve ser uma lista`);
    let encontrado = false;
    for (const grupo of grupos) {
      const entrada = objeto(grupo, `hooks.${evento}`);
      if (!Array.isArray(entrada.hooks)) throw new Error(`hooks.${evento}.hooks deve ser uma lista`);
      for (const item of entrada.hooks) {
        const hook = objeto(item, `hooks.${evento}.hooks`);
        if (hook.type === "command" && typeof hook.command === "string" &&
          (hook.command === command || hook.command.endsWith(marcador))) {
          hook.command = gerenciado;
          hook.timeout = 60;
          encontrado = true;
        }
      }
    }
    if (!encontrado) grupos.push({ hooks: [{ type: "command", command: gerenciado, timeout: 60 }] });
    hooks[evento] = grupos;
  }
}

interface EstadoToml { aspas: string; profundidade: number }
/** Reconhece limites de declarações sem tocar em strings/arrays multilinha. */
function avancarToml(linha: string, estado: EstadoToml): void {
  for (let i = 0; i < linha.length; i++) {
    const char = linha[i]!;
    if (estado.aspas) {
      if (estado.aspas.startsWith('"') && char === "\\") { i++; continue; }
      if (linha.startsWith(estado.aspas, i)) { i += estado.aspas.length - 1; estado.aspas = ""; }
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") {
      estado.aspas = linha.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      i += estado.aspas.length - 1;
    } else if (char === "[" || char === "{") estado.profundidade++;
    else if (char === "]" || char === "}") estado.profundidade--;
  }
}

function tabelaToml(linha: string): string | undefined {
  if (/^\s*\[\[[^\[\]]+\]\]\s*(?:#.*)?$/.test(linha)) return `array:${linha.trim()}`;
  const match = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(linha);
  if (!match) return undefined;
  return match[1]!.replace(/"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'/g, "$1$2").replace(/\s+/g, "");
}

function configurarToml(texto: string, comando: string[], argumentos: string[]): string {
  const linhas = texto.split(/\r?\n/);
  const estado: EstadoToml = { aspas: "", profundidade: 0 };
  let inicio = -1;
  let fim = linhas.length;
  let tabela = "";
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i]!;
    if (!estado.aspas && estado.profundidade === 0) {
      const cabecalho = tabelaToml(linha);
      if (cabecalho !== undefined) {
        if (inicio >= 0 && fim === linhas.length) fim = i;
        tabela = cabecalho;
        if (cabecalho === "mcp_servers.doc_center") {
          if (inicio >= 0) throw new Error("mcp_servers.doc_center está definido mais de uma vez");
          inicio = i;
        }
        continue;
      }
      if ((tabela === "" && /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=/.test(linha)) ||
        (tabela === "mcp_servers" && /^\s*(?:doc_center|"doc_center"|'doc_center')\s*(?:=|\.)/.test(linha)) ||
        /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:doc_center|"doc_center"|'doc_center')\s*(?:=|\.)/.test(linha)) {
        throw new Error("use uma tabela [mcp_servers.doc_center] antes de instalar a integração");
      }
    }
    avancarToml(linha, estado);
  }
  if (estado.aspas || estado.profundidade !== 0) throw new Error("config.toml contém um valor não terminado");
  const desejado: Record<string, string> = {
    command: JSON.stringify(comando[0]), args: JSON.stringify([...comando.slice(1), ...argumentos]),
    env_vars: '["DOC_CENTER_URL", "DOC_CENTER_TOKEN"]',
  };
  if (inicio < 0) return `${texto.trimEnd()}${texto.trim() ? "\n\n" : ""}[mcp_servers.doc_center]\n` +
    Object.entries(desejado).map(([chave, valor]) => `${chave} = ${valor}`).join("\n") + "\n";
  const novas: string[] = [];
  const encontrados = new Set<string>();
  const remoto = new Set(["url", "bearer_token_env_var", "http_headers", "env_http_headers"]);
  for (let i = inicio + 1; i < fim; i++) {
    const linha = linhas[i]!;
    const match = /^\s*(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')\s*=/.exec(linha);
    if (!match) { novas.push(linha); continue; }
    const chave = (match[1] ?? match[2] ?? match[3])!;
    const valor: string[] = [linha.slice(linha.indexOf("=") + 1)];
    const valorEstado: EstadoToml = { aspas: "", profundidade: 0 };
    avancarToml(valor[0]!, valorEstado);
    while ((valorEstado.aspas || valorEstado.profundidade !== 0) && i + 1 < fim) {
      const seguinte = linhas[++i]!; valor.push(seguinte); avancarToml(seguinte, valorEstado);
    }
    if (chave in desejado) {
      if (encontrados.has(chave)) throw new Error(`mcp_servers.doc_center.${chave} está duplicado`);
      if (chave === "env_vars") {
        const atual = valor.join("\n");
        const semComentario = atual.replace(/#[^\n]*/g, "").trim();
        if (!semComentario.startsWith("[") || !semComentario.endsWith("]")) throw new Error("env_vars deve ser uma lista TOML");
        const existentes = [...semComentario.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]!);
        desejado.env_vars = JSON.stringify([...new Set([...existentes, "DOC_CENTER_URL", "DOC_CENTER_TOKEN"])]);
      }
      novas.push(`${chave} = ${desejado[chave]}`);
      encontrados.add(chave);
    } else if (!remoto.has(chave)) {
      novas.push(linha, ...valor.slice(1));
    }
  }
  for (const [chave, valor] of Object.entries(desejado)) if (!encontrados.has(chave)) novas.push(`${chave} = ${valor}`);
  return [...linhas.slice(0, inicio + 1), ...novas, ...linhas.slice(fim)].join("\n").trimEnd() + "\n";
}

async function verificarCaminho(raiz: string, relativo: string): Promise<string> {
  let atual = raiz;
  for (const parte of relativo.split("/")) {
    atual = join(atual, parte);
    try {
      const info = await lstat(atual);
      if (info.isSymbolicLink()) throw new Error(`não sobrescrever link simbólico: ${relativo}`);
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code !== "ENOENT") throw erro;
    }
  }
  if (!atual.startsWith(raiz + sep)) throw new Error("configuração fora do projeto");
  return atual;
}

async function ler(arquivo: string): Promise<string | undefined> {
  try { return await readFile(arquivo, "utf8"); }
  catch (erro) { if ((erro as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw erro; }
}

/** Instala somente configurações locais. Credenciais vêm do ambiente da CLI. */
export async function configurarIntegracao(opcoes: OpcoesIntegracao): Promise<{ arquivos: string[]; instrucoes: string[] }> {
  if (!["codex", "claude", "opencode"].includes(opcoes.cliente)) throw new Error("cliente deve ser codex, claude ou opencode");
  if (!opcoes.comando.length || opcoes.comando.some((parte) => !parte || /[\0\r\n]/.test(parte))) throw new Error("comando de integração inválido");
  if (opcoes.projeto !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(opcoes.projeto)) throw new Error("projeto inválido");
  if (opcoes.url !== undefined) {
    const url = new URL(opcoes.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("URL da integração inválida");
  }
  const raiz = await realpath(resolve(opcoes.diretorio));
  const extras = [...(opcoes.projeto ? ["--project", opcoes.projeto] : []), ...(opcoes.url ? ["--url", opcoes.url] : [])];
  const hookArgs = ["hook", "--client", opcoes.cliente, ...extras];
  const hookCommand = [...opcoes.comando, ...hookArgs].map(citar).join(" ");
  const connectArgs = ["connect", ...extras];
  const arquivos: Array<{ caminho: string; anterior?: string; conteudo: string }> = [];
  const preparar = async (relativo: string, transformar: (texto: string | undefined) => string): Promise<void> => {
    const caminho = await verificarCaminho(raiz, relativo);
    const anterior = await ler(caminho);
    arquivos.push({ caminho, ...(anterior !== undefined ? { anterior } : {}), conteudo: transformar(anterior) });
  };
  const json = (texto: string | undefined, nome: string, jsonc = false): Objeto => {
    try { return texto === undefined ? {} : objeto(JSON.parse(jsonc ? semComentariosJSON(texto) : texto), nome); }
    catch { throw new Error(`${nome} inválido; corrija o arquivo antes de instalar`); }
  };
  const serializar = (config: Objeto): string => JSON.stringify(config, null, 2) + "\n";
  const instrucoes = ["Exporte DOC_CENTER_URL e DOC_CENTER_TOKEN no terminal antes de abrir a CLI; o token não foi gravado na configuração."];
  if (opcoes.cliente === "codex") {
    await preparar(".codex/config.toml", (texto) => configurarToml(texto ?? "", opcoes.comando, connectArgs));
    await preparar(".codex/hooks.json", (texto) => {
      const config = json(texto, ".codex/hooks.json"); configurarHooks(config, hookCommand, "codex"); return serializar(config);
    });
    instrucoes.push("Abra o Codex neste projeto confiável e use /hooks para revisar e autorizar os hooks instalados. Confira /mcp.",
      "Hooks Codex precisam estar habilitados (features.hooks não pode ser false). Hooks inline existentes continuam ativos e são combinados com hooks.json.");
  } else if (opcoes.cliente === "claude") {
    await preparar(".mcp.json", (texto) => {
      const config = json(texto, ".mcp.json"); const servidores = subobjeto(config, "mcpServers");
      const anterior = servidores.doc_center === undefined ? {} : objeto(servidores.doc_center, "mcpServers.doc_center");
      const { url: _url, headers: _headers, ...mantido } = anterior;
      servidores.doc_center = { ...mantido, type: "stdio", command: opcoes.comando[0], args: [...opcoes.comando.slice(1), ...connectArgs],
        env: { ...subobjeto(anterior, "env"), DOC_CENTER_URL: "${DOC_CENTER_URL:-http://127.0.0.1:7777/mcp}", DOC_CENTER_TOKEN: "${DOC_CENTER_TOKEN}" } };
      return serializar(config);
    });
    await preparar(".claude/settings.json", (texto) => {
      const config = json(texto, ".claude/settings.json"); configurarHooks(config, hookCommand, "claude"); return serializar(config);
    });
    instrucoes.push("Abra Claude Code neste projeto, aprove os hooks e o servidor MCP do projeto e confira /mcp.");
  } else {
    const jsonc = await ler(await verificarCaminho(raiz, "opencode.json")) === undefined && await ler(await verificarCaminho(raiz, "opencode.jsonc")) !== undefined;
    await preparar(jsonc ? "opencode.jsonc" : "opencode.json", (texto) => {
      const config = json(texto, "opencode.json", jsonc); config.$schema ??= "https://opencode.ai/config.json";
      const mcp = subobjeto(config, "mcp");
      const servidores = mcp;
      const anterior = servidores.doc_center === undefined ? {} : objeto(servidores.doc_center, "mcp.doc_center");
      const { url: _url, headers: _headers, oauth: _oauth, ...mantido } = anterior;
      const { DOC_CENTER_URL: _envUrl, ...ambiente } = subobjeto(anterior, "environment");
      servidores.doc_center = { ...mantido, type: "local", command: [...opcoes.comando, ...connectArgs], enabled: true,
        environment: { ...ambiente, DOC_CENTER_TOKEN: "{env:DOC_CENTER_TOKEN}" } };
      return serializar(config);
    });
    await preparar(".opencode/plugins/doc-center.js", (texto) => {
      if (texto !== undefined && !texto.startsWith("// doc-center managed OpenCode integration v1\n")) throw new Error("doc-center.js já existe e não é uma integração gerenciada");
      return criarPluginOpenCode(opcoes.comando, hookArgs);
    });
    instrucoes.push("Reinicie o OpenCode no projeto e confira opencode mcp list. O plugin local é descoberto automaticamente.",
      "O plugin injeta contexto por sessão pelo hook experimental de sistema; doc-center resume fornece uma alternativa portátil explícita.");
    if (jsonc) instrucoes.push("O opencode.jsonc foi normalizado como JSON; suas opções e lista de plugins foram preservadas.");
  }
  // Validar todos os arquivos antes de começar a escrever evita instalações parciais por JSON inválido.
  for (const arquivo of arquivos) {
    if (arquivo.anterior === arquivo.conteudo) continue;
    await mkdir(dirname(arquivo.caminho), { recursive: true });
    await verificarCaminho(raiz, arquivo.caminho.slice(raiz.length + 1).split(sep).join("/"));
    const temporario = `${arquivo.caminho}.doc-center-${randomUUID()}.tmp`;
    try {
      await writeFile(temporario, arquivo.conteudo, { flag: "wx", mode: 0o600 });
      await rename(temporario, arquivo.caminho);
    } finally { try { await unlink(temporario); } catch (erro) { if ((erro as NodeJS.ErrnoException).code !== "ENOENT") throw erro; } }
  }
  return { arquivos: arquivos.map((arquivo) => arquivo.caminho), instrucoes };
}
