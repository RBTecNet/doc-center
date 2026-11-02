/**
 * Sobe a aplicação.
 *
 *     doc-center [--web-port 80] [--mcp-port 7777] [--db caminho.db]
 *
 * `PORT` do ambiente também vale para a interface — qualquer supervisor
 * espera poder definir, inclusive o gate 4 do capivara quando ele exercitar
 * esta aplicação.
 */

import { Store } from "./db/store.js";
import { startServers, ListenerError } from "./server.js";
import { connectStdio } from "./mcp/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { resolveProject, saveProject } from "./client/project.js";
import { RemoteClient } from "./client/remote.js";
import { readHookInput, runHook, syncProject } from "./client/hooks.js";
import { renderContext } from "./client/context.js";
import { configurarIntegracao } from "./integrations/config.js";

declare const __DOC_CENTER_VERSION__: string;

function argumento(nome: string, padrao: string): string {
  const indice = process.argv.indexOf(`--${nome}`);
  return indice >= 0 ? (process.argv[indice + 1] ?? padrao) : padrao;
}

const command = process.argv[2];
const clientOptions = {
  ...(argumento("project", "") ? { project: argumento("project", "") } : {}),
  ...(argumento("cwd", "") ? { cwd: argumento("cwd", "") } : {}),
  ...(argumento("url", "") ? { url: argumento("url", "") } : {}),
};
if (command === "connect") {
  const abortar = new AbortController();
  const encerrar = (): void => { abortar.abort(); process.stdin.destroy(); };
  process.once("SIGINT", encerrar);
  process.once("SIGTERM", encerrar);
  try {
    await connectStdio({ ...clientOptions, signal: abortar.signal });
  } catch (erro) {
    // Erros de configuração têm texto controlado; não despejamos stack, URL
    // ou variáveis de ambiente no canal de protocolo.
    const message = erro instanceof Error && (erro.message.startsWith("DOC_CENTER_URL ") ||
      erro.message.startsWith("defina DOC_CENTER_TOKEN ")) ? erro.message : "conexão MCP encerrada";
    process.stderr.write(message + "\n");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", encerrar);
    process.off("SIGTERM", encerrar);
  }
} else if (["hook", "setup", "resume", "sync"].includes(command ?? "")) {
  try {
    if (command === "hook") {
      const result = await runHook(await readHookInput(process.stdin), { ...clientOptions, client: argumento("client", "generic") });
      // Codex exige JSON também em Stop; nunca imprimir conversa/log no stdout.
      process.stdout.write(JSON.stringify(result.output) + "\n");
      if (result.warning) process.stderr.write((result.warning.startsWith("doc-center:") ? result.warning : "doc-center: " + result.warning) + "\n");
    } else if (command === "setup") {
      const cliente = argumento("client", "");
      if (cliente !== "codex" && cliente !== "claude" && cliente !== "opencode") throw new Error("--client deve ser codex, claude ou opencode; outras CLIs podem usar connect e o hook genérico");
      const project = await resolveProject(clientOptions);
      const configured = await configurarIntegracao({ cliente, diretorio: project.diretorio,
        comando: [process.execPath, fileURLToPath(import.meta.url)], projeto: project.slug,
        ...(clientOptions.url ? { url: clientOptions.url } : {}) });
      const file = await saveProject(project);
      process.stdout.write(`Projeto: ${project.slug}\n` + [...configured.arquivos, file].map((path) => `Configurado: ${path}`).join("\n") + "\n" + configured.instrucoes.join("\n") + "\n");
    } else if (command === "sync") {
      const result = await syncProject(clientOptions);
      process.stdout.write(`${result.enviados} registros sincronizados; ${result.pendentes} pendentes.\n`);
      if (result.pendentes) { process.stderr.write("Há registros de outra credencial/conta; use o token original para sincronizar.\n"); process.exitCode = 1; }
    } else {
      const project = await resolveProject(clientOptions);
      const remote = new RemoteClient(clientOptions);
      await remote.tool("abrir_projeto", { projeto: project.slug, nome: project.nome, repositorio: project.repositorio });
      const context = await remote.tool("obter_contexto", { projeto: project.slug });
      const format = argumento("format", "markdown");
      if (format !== "markdown" && format !== "json") throw new Error("--format deve ser markdown ou json");
      const content = format === "json" ? JSON.stringify(context, null, 2) + "\n" : renderContext(context);
      const output = argumento("output", "");
      if (output) {
        await writeFile(resolve(output), content);
        process.stdout.write(`Contexto salvo em ${resolve(output)}\n`);
      } else process.stdout.write(content);
    }
  } catch (error) {
    if (command === "hook") process.stdout.write("{}\n");
    const message = error instanceof Error ? error.message : "operação do doc-center falhou";
    // Não exibir erros de sistema, corpo do servidor ou strings interpoladas
    // por bibliotecas: podem conter credenciais e conteúdo da conversa.
    const safe = /^(DOC_CENTER_|defina DOC_CENTER_TOKEN|doc-center indisponível|servidor MCP respondeu|pedido MCP recusado|resposta MCP|entrada |mensagem excede|session_id |cliente do hook |timestamp |o identificador |--client |--format |\.doc-center\/project\.json)/.test(message);
    process.stderr.write((safe ? message : "operação do doc-center falhou; verifique a configuração e os arquivos locais") + "\n");
    process.exitCode = 1;
  }
} else if (command === "--help" || command === "help" || (command && !command.startsWith("--"))) {
  process.stdout.write("doc-center [--db arquivo.db] [--host 127.0.0.1] [--web-port 80] [--mcp-port 7777]\n" +
    "  --port/PORT são aliases da porta web; --public-url define o endereço público da interface web.\n" +
    "  --mcp-public-url define o endereço público do MCP, incluindo /mcp.\n" +
    "  --trust-proxy loopback / DOC_CENTER_TRUST_PROXY confia em X-Real-IP de proxy local; desativado por padrão.\n" +
    "doc-center connect [--project slug] [--cwd pasta] [--url URL]\n" +
    "doc-center setup --client codex|claude|opencode [--project slug] [--cwd pasta] [--url URL]\n" +
    "doc-center hook --client nome  (JSON do evento pelo stdin)\n" +
    "doc-center sync [--project slug] [--cwd pasta]\n" +
    "doc-center resume [--project slug] [--cwd pasta] [--format markdown|json] [--output arquivo]\n" +
    "Clientes usam DOC_CENTER_URL e DOC_CENTER_TOKEN do ambiente.\n");
  if (command !== "--help" && command !== "help") process.exitCode = 1;
} else {
  const arquivo = argumento("db", process.env.DOC_CENTER_DB ?? "doc-center.db");
  const portaWeb = Number(argumento("web-port", argumento("port", process.env.DOC_CENTER_WEB_PORT ?? process.env.PORT ?? "80")));
  const portaMcp = Number(argumento("mcp-port", process.env.DOC_CENTER_MCP_PORT ?? "7777"));
  const host = argumento("host", process.env.HOST ?? "127.0.0.1");
  /*
   * A pasta dos projetos do capivara, para o visor de runs. Vazia desliga o visor:
   * ele lê arquivos que o harness já grava, e o harness não sabe que ele existe.
   */
  const runs = argumento("runs", process.env.DOC_CENTER_RUNS ?? "");
  const publicUrl = argumento("public-url", process.env.DOC_CENTER_PUBLIC_URL ?? "");
  const mcpPublicUrl = argumento("mcp-public-url", process.env.DOC_CENTER_MCP_PUBLIC_URL ?? "");
  const trustedProxy = argumento("trust-proxy", process.env.DOC_CENTER_TRUST_PROXY ?? "");
  if (trustedProxy !== "" && trustedProxy !== "loopback") {
    process.stderr.write("DOC_CENTER_TRUST_PROXY/--trust-proxy deve ser loopback ou vazio\n");
    process.exit(1);
  }
  const registration = argumento("registration", process.env.DOC_CENTER_REGISTRATION ?? "open");
  if (registration !== "open" && registration !== "closed") {
    throw new Error("DOC_CENTER_REGISTRATION/--registration deve ser open ou closed");
  }

  const store = new Store({ file: arquivo });
  try {
    const servers = await startServers({ store, host, registration, webPort: portaWeb, mcpPort: portaMcp,
      ...(publicUrl !== "" ? { publicUrl } : {}), ...(mcpPublicUrl !== "" ? { mcpPublicUrl } : {}),
      ...(trustedProxy === "loopback" ? { trustedProxy } : {}),
      ...(runs !== "" ? { runsRoot: runs } : {}) });
    const enderecoHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
    const webUrl = publicUrl || `http://${enderecoHost.includes(":") ? `[${enderecoHost}]` : enderecoHost}${servers.webPort === 80 ? "" : `:${servers.webPort}`}/`;
    process.stdout.write(
      `doc-center ${typeof __DOC_CENTER_VERSION__ === "string" ? __DOC_CENTER_VERSION__ : ""}\n` +
        `  interface  ${webUrl}\n` +
        `  mcp        ${servers.mcpUrl}\n` +
        `  banco      ${arquivo}\n` +
        (runs !== "" ? `  runs       ${new URL("/runs", webUrl).href}  (somente leitura, de ${runs})\n` : ""),
    );
    let encerrando = false;
    const encerrar = (): void => {
      if (encerrando) return;
      encerrando = true;
      void servers.close().then(() => {
        store.close(); process.exit(0);
      }, () => { store.close(); process.exit(1); });
    };
    process.once("SIGINT", encerrar);
    process.once("SIGTERM", encerrar);
  } catch (error) {
    store.close();
    if (error instanceof ListenerError) {
      process.stderr.write(error.message + "\n");
      if (error.code === "EACCES" && error.service === "web" && error.port < 1024) {
        process.stderr.write("A porta web exige permissão do sistema. Use um serviço com CAP_NET_BIND_SERVICE ou um proxy na porta 80; para executar diretamente, use --web-port 8080.\n");
      }
    } else {
      const message = error instanceof Error ? error.message : "";
      process.stderr.write((/^(--web-port|--mcp-port|as portas |DOC_CENTER_)/.test(message) ? message : "não foi possível iniciar os servidores; verifique a configuração") + "\n");
    }
    process.exitCode = 1;
  }
}
