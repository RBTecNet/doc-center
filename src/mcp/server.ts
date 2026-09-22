/**
 * O lado servidor do MCP.
 *
 * O contrato de URI é o mesmo que o harness já lê:
 *
 *     capivara://<projeto>/pedido
 *     capivara://<projeto>/docs/<tipo>/<slug>
 *     capivara://geral/docs/<tipo>/<slug>
 *
 * Sob um projeto aparece o que ele USA — o que é dele mais o que selecionou da
 * área geral. Um documento da área geral escolhido por dois projetos aparece sob
 * os dois, com o mesmo conteúdo e o mesmo id: quem corrige o original corrige
 * para todos, que é a razão de a seleção apontar em vez de copiar.
 *
 * A área geral inteira também é exposta, sob `geral`. Ela existe para quem
 * estiver navegando, não para um run: o harness pede o material de UM projeto, e
 * é por isso que ele nunca leva o acervo todo para dentro do contexto.
 *
 * Este módulo é puro: recebe uma requisição JSON-RPC e devolve a resposta. Quem
 * fala HTTP é o servidor; quem guarda é o Store. Assim o protocolo inteiro é
 * testável sem abrir porta nenhuma.
 */

import type { Store } from "../db/store.js";
import type { Documento } from "../db/schema.js";
import { comoSlug } from "../db/schema.js";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "doc-center", version: "0.1.0" } as const;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Códigos do JSON-RPC 2.0 que usamos. */
const METODO_DESCONHECIDO = -32601;
const PARAMETRO_INVALIDO = -32602;

export function uriDoPedido(projeto: string): string {
  return `capivara://${projeto}/pedido`;
}

export function uriDoDocumento(escopo: string, documento: Documento): string {
  return `capivara://${escopo}/docs/${documento.tipo}/${documento.slug}`;
}

/**
 * `capivara://x/docs/memoria/estilo` → escopo `x`, tipo `memoria`, slug `estilo`.
 *
 * Um pacote acrescenta um nível: tudo depois do slug é o caminho do arquivo
 * dentro dele — `capivara://x/docs/skill/frontend/references/typography.md`. É o
 * mesmo caminho que o SKILL.md cita e que o harness materializa no disco, então
 * ele viaja inteiro, com as barras.
 */
export function lerUri(
  uri: string,
): { escopo: string; tipo: string; slug: string; pedido: boolean; arquivo: string } | null {
  const resto = uri.startsWith("capivara://") ? uri.slice("capivara://".length) : "";
  if (resto === "") return null;

  const partes = resto.split("/");
  const escopo = partes[0] ?? "";
  if (escopo === "") return null;

  if (partes.length === 2 && partes[1] === "pedido") return { escopo, tipo: "", slug: "", pedido: true, arquivo: "" };
  if (partes.length >= 4 && partes[1] === "docs") {
    return {
      escopo,
      tipo: partes[2] ?? "",
      slug: partes[3] ?? "",
      pedido: false,
      arquivo: partes.slice(4).join("/"),
    };
  }
  return null;
}

function texto(conteudo: string, uri: string): { contents: { uri: string; mimeType: string; text: string }[] } {
  return { contents: [{ uri, mimeType: "text/markdown", text: conteudo }] };
}

export function handle(store: Store, request: RpcRequest): RpcResponse | null {
  const id = request.id ?? null;
  const responder = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
  const recusar = (code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

  // Notificação não tem id e não tem resposta. `initialized` é a mais comum.
  if (request.id === undefined) return null;

  switch (request.method) {
    case "initialize":
      return responder({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return responder({});

    case "resources/list": {
      const recursos: { uri: string; name: string; description?: string; mimeType: string }[] = [];

      for (const projeto of store.listarProjetos()) {
        if (projeto.pedido.trim() !== "") {
          recursos.push({
            uri: uriDoPedido(projeto.slug),
            name: `pedido — ${projeto.nome}`,
            description: projeto.descricao || `o que construir no projeto ${projeto.nome}`,
            mimeType: "text/markdown",
          });
        }
        for (const documento of store.listarDoProjeto(projeto.id)) {
          // Rascunho não é material de run: ele existe para ser revisado, e
          // entregá-lo antes disso anularia a revisão.
          if (documento.status === "rascunho") continue;
          recursos.push({
            uri: uriDoDocumento(projeto.slug, documento),
            name: documento.titulo,
            // `area=` sem acento e sem espaço: é dado para o cliente ler, não
            // prosa. Acento aqui já custou uma seleção de skills inteira, porque
            // `\b` antes de caractere acentuado não casa em JavaScript.
            description: `${documento.tipo} · area=${documento.area} · usado pelo projeto ${projeto.nome}`,
            mimeType: "text/markdown",
          });
          // Os arquivos do pacote entram como recursos próprios: é assim que o
          // harness sabe o que materializar sem adivinhar.
          for (const arquivo of store.arquivos(documento.id)) {
            recursos.push({
              uri: `${uriDoDocumento(projeto.slug, documento)}/${arquivo.caminho}`,
              name: `${documento.titulo} · ${arquivo.caminho}`,
              description: arquivo.binario ? "arquivo binário do pacote" : "arquivo do pacote",
              mimeType: arquivo.binario ? "application/octet-stream" : "text/markdown",
            });
          }
        }
      }

      for (const documento of store.listarGerais()) {
        recursos.push({
          uri: uriDoDocumento("geral", documento),
          name: documento.titulo,
          description: `${documento.tipo} na área geral`,
          mimeType: "text/markdown",
        });
      }

      return responder({ resources: recursos });
    }

    case "resources/read": {
      const uri = String(request.params?.uri ?? "");
      const alvo = lerUri(uri);
      if (!alvo) return recusar(PARAMETRO_INVALIDO, `URI fora do contrato: ${uri}`);

      if (alvo.pedido) {
        const projeto = store.projetoPorSlug(alvo.escopo);
        if (!projeto) return recusar(PARAMETRO_INVALIDO, `projeto "${alvo.escopo}" não existe`);
        return responder(texto(projeto.pedido, uri));
      }

      if (alvo.escopo === "geral") {
        const documento = store.documento(null, alvo.tipo, alvo.slug);
        if (!documento) return recusar(PARAMETRO_INVALIDO, `documento não existe na área geral: ${uri}`);
        if (alvo.arquivo === "") return responder(texto(documento.conteudo, uri));

        const arquivo = store.arquivo(documento.id, alvo.arquivo);
        if (!arquivo) return recusar(PARAMETRO_INVALIDO, `${alvo.tipo}/${alvo.slug} não tem o arquivo ${alvo.arquivo}`);
        return responder(
          arquivo.binario
            ? { contents: [{ uri, mimeType: "application/octet-stream", blob: arquivo.conteudo.toString("base64") }] }
            : texto(arquivo.conteudo.toString("utf8"), uri),
        );
      }

      const projeto = store.projetoPorSlug(alvo.escopo);
      if (!projeto) return recusar(PARAMETRO_INVALIDO, `projeto "${alvo.escopo}" não existe`);

      /*
       * Procura entre os documentos que o projeto USA, e não no banco inteiro.
       * Ler pelo par tipo/slug direto acharia um documento da área geral que
       * este projeto não escolheu — e a seleção deixaria de significar algo.
       */
      const usado = store.listarDoProjeto(projeto.id).find((doc) => doc.tipo === alvo.tipo && doc.slug === alvo.slug);
      if (!usado) return recusar(PARAMETRO_INVALIDO, `o projeto ${projeto.slug} não usa ${alvo.tipo}/${alvo.slug}`);
      if (alvo.arquivo === "") return responder(texto(usado.conteudo, uri));

      const arquivo = store.arquivo(usado.id, alvo.arquivo);
      if (!arquivo) return recusar(PARAMETRO_INVALIDO, `${alvo.tipo}/${alvo.slug} não tem o arquivo ${alvo.arquivo}`);
      // Binário viaja em base64, como o protocolo prevê: convertê-lo para texto
      // destruiria justamente o print que alguém guardou para servir de referência.
      return responder(
        arquivo.binario
          ? { contents: [{ uri, mimeType: "application/octet-stream", blob: arquivo.conteudo.toString("base64") }] }
          : texto(arquivo.conteudo.toString("utf8"), uri),
      );
    }

    case "prompts/list":
      return responder({
        prompts: store
          .listarProjetos()
          .filter((projeto) => projeto.pedido.trim() !== "")
          .map((projeto) => ({
            name: projeto.slug,
            title: `pedido — ${projeto.nome}`,
            description: projeto.descricao || `o que construir no projeto ${projeto.nome}`,
          })),
      });

    case "prompts/get": {
      const nome = String(request.params?.name ?? "");
      const projeto = store.projetoPorSlug(nome);
      if (!projeto) return recusar(PARAMETRO_INVALIDO, `não há pedido para o projeto "${nome}"`);
      return responder({
        description: projeto.descricao,
        messages: [{ role: "user", content: { type: "text", text: projeto.pedido } }],
      });
    }

    case "tools/list":
      return responder({
        tools: [
          {
            name: "registrar_memoria",
            description:
              "Registra uma memória do projeto: o que alguém precisa saber para continuar o trabalho. " +
              "Entra como rascunho e vale depois de aprovada na interface. " +
              "Naturezas: decisao, armadilha, convencao (acumulam) e estado (substitui o anterior).",
            inputSchema: {
              type: "object",
              properties: {
                projeto: { type: "string", description: "o slug do projeto" },
                natureza: { type: "string", enum: ["decisao", "armadilha", "convencao", "estado"] },
                titulo: { type: "string", description: "uma linha que identifica a memória" },
                conteudo: { type: "string", description: "o que precisa ser sabido, em markdown" },
                procedencia: { type: "string", description: "o run e a fase que a produziram" },
              },
              required: ["projeto", "natureza", "titulo", "conteudo"],
            },
          },
          {
            name: "registrar_levantamento",
            description:
              "Grava o levantamento de uma aplicação existente como projeto desta base. " +
              "Cria o projeto quando ele ainda não existe, guarda o documento e semeia o pedido " +
              "com um rascunho de reescrita para o desenvolvedor editar. Rodar de novo atualiza o " +
              "documento e nunca sobrescreve um pedido que já foi escrito.",
            inputSchema: {
              type: "object",
              properties: {
                projeto: { type: "string", description: "o slug do projeto a criar ou atualizar" },
                nome: { type: "string", description: "o nome da aplicação levantada" },
                titulo: { type: "string", description: "o título do documento; o padrão é Levantamento" },
                conteudo: { type: "string", description: "o levantamento em markdown" },
                procedencia: { type: "string", description: "o run que o produziu" },
              },
              required: ["projeto", "conteudo"],
            },
          },
          {
            name: "listar_material",
            description:
              "O material de um projeto: o pedido e os documentos que ele usa. " +
              "Devolve só o que foi selecionado para aquele projeto, nunca o acervo inteiro.",
            inputSchema: {
              type: "object",
              properties: { projeto: { type: "string", description: "o slug do projeto" } },
              required: ["projeto"],
            },
          },
        ],
      });

    case "tools/call": {
      const nome = String(request.params?.name ?? "");
      const argumentos = (request.params?.arguments ?? {}) as Record<string, string>;

      if (nome === "registrar_levantamento") {
        const slug = String(argumentos.projeto ?? "").trim();
        const conteudo = String(argumentos.conteudo ?? "").trim();
        if (slug === "" || conteudo === "") {
          return responder({ isError: true, content: [{ type: "text", text: "o levantamento precisa do slug do projeto e do conteúdo" }] });
        }

        const aplicacao = String(argumentos.nome ?? "").trim() || slug;
        /*
         * O pedido nasce como rascunho de reescrita, e não vazio.
         *
         * Quem acabou de levantar uma aplicação quer reescrevê-la; a página do
         * projeto abrindo com um campo em branco faz cada um inventar a própria
         * forma de dizer isso. O texto é editável e some no primeiro salvamento
         * de quem souber melhor — e por isso ele NUNCA sobrescreve um pedido
         * que já existe.
         */
        const semente = [
          `Reescrever a aplicação ${aplicacao}, a partir do levantamento deste projeto.`,
          "",
          "O levantamento descreve o que a aplicação faz hoje, com a evidência de onde cada",
          "regra foi lida. Ele é a autoridade sobre o COMPORTAMENTO; a stack de origem é",
          "informação, não obrigação.",
          "",
          "Edite as duas linhas abaixo antes de rodar o init:",
          "",
          "- Stack de destino: (a mesma de hoje | outra — diga qual)",
          "- Fica de fora: (nada | os domínios ou funcionalidades que não serão reescritos)",
        ].join("\n");

        const projeto =
          store.projetoPorSlug(slug) ??
          store.criarProjeto({ nome: aplicacao, slug, descricao: `Levantamento de ${aplicacao}`, pedido: semente });

        const titulo = String(argumentos.titulo ?? "").trim() || "Levantamento";
        const existente = store.documento(projeto.id, "documentacao", comoSlug(titulo));

        const documento = existente
          ? store.atualizarDocumento(existente.id, { conteudo })
          : store.criarDocumento({
              projetoId: projeto.id,
              tipo: "documentacao",
              titulo,
              conteudo,
              procedencia: String(argumentos.procedencia ?? ""),
            });

        return responder({
          content: [
            {
              type: "text",
              text:
                `${existente ? "levantamento atualizado" : "levantamento gravado"} em ${projeto.slug}: ` +
                `${uriDoDocumento(projeto.slug, documento)}`,
            },
          ],
        });
      }

      if (nome === "registrar_memoria") {
        const projeto = store.projetoPorSlug(String(argumentos.projeto ?? ""));
        if (!projeto) {
          return responder({ isError: true, content: [{ type: "text", text: `projeto "${argumentos.projeto}" não existe` }] });
        }

        const natureza = String(argumentos.natureza ?? "decisao");
        if (!["decisao", "armadilha", "convencao", "estado"].includes(natureza)) {
          return responder({
            isError: true,
            content: [{ type: "text", text: `natureza desconhecida: ${natureza}. Use decisao, armadilha, convencao ou estado.` }],
          });
        }

        const titulo = String(argumentos.titulo ?? "").trim();
        const conteudo = String(argumentos.conteudo ?? "").trim();
        if (titulo === "" || conteudo === "") {
          return responder({ isError: true, content: [{ type: "text", text: "memória precisa de título e conteúdo" }] });
        }

        const memoria = store.registrarMemoria({
          projetoId: projeto.id,
          natureza,
          titulo,
          conteudo,
          procedencia: String(argumentos.procedencia ?? ""),
        });

        return responder({
          content: [
            {
              type: "text",
              text: `memória "${memoria.titulo}" registrada como rascunho em ${projeto.slug} (natureza ${natureza})`,
            },
          ],
        });
      }

      if (nome !== "listar_material") return recusar(PARAMETRO_INVALIDO, `ferramenta desconhecida: ${nome}`);
      const projeto = store.projetoPorSlug(String(argumentos.projeto ?? ""));
      if (!projeto) {
        // Erro DA FERRAMENTA, não do protocolo: o cliente pediu certo, o dado é
        // que não existe. A distinção importa para quem trata a resposta.
        return responder({
          isError: true,
          content: [{ type: "text", text: `projeto "${argumentos.projeto}" não existe` }],
        });
      }

      const usados = store.listarDoProjeto(projeto.id);
      const linhas = [
        `# ${projeto.nome}`,
        "",
        projeto.pedido.trim() === "" ? "_sem pedido cadastrado_" : `## Pedido\n\n${projeto.pedido}`,
        "",
        `## Documentos (${usados.length})`,
        ...usados.map((documento) => `- ${documento.tipo}/${documento.slug} — ${documento.titulo}`),
      ];
      return responder({ content: [{ type: "text", text: linhas.join("\n") }] });
    }

    default:
      return recusar(METODO_DESCONHECIDO, `método não suportado: ${request.method}`);
  }
}
