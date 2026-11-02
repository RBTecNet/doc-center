/** Entrada por sessão e credenciais para os clientes MCP do usuário. */
import type { Store } from "../db/store.js";
import { escapar } from "./escapar.js";
import { moldura } from "./paginas.js";
import { CSS, FONTES, RAIO_SVG } from "./tema.js";

export interface UsuarioDaConta {
  id: number;
  nome: string;
  email: string;
}

export interface TokenSummary {
  id: number;
  nome: string;
  prefixo: string;
  projeto: string | null;
  permissao: "leitura" | "workflow";
  criadoEm: string;
  expiraEm: string;
  ultimoUsoEm: string | null;
}

const CSS_CONTA = `
[hidden] { display: none !important; }
button:disabled { opacity: .6; cursor: wait; }
.entrada { min-height: 100dvh; height: auto; overflow: auto; display: grid; place-items: center; padding: 28px 18px; }
.entrada .caixa { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 22px; }
.entrada .marca { padding: 0; border: 0; }
.entrada h1 { font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
.entrada .subtitulo { margin-top: 8px; color: var(--texto-3); }
.entrada .painel { border: 1px solid var(--borda-forte); background: var(--painel); border-radius: 12px; padding: 24px; }
.entrada form.campos { gap: 16px; }
.entrada label { color: var(--texto-3); }
.entrada .trocar { color: var(--texto-3); font-size: 12px; text-align: center; }
.entrada a, .conta-conexao a { color: var(--verde-claro); }
.erro-formulario { color: var(--vermelho); font-size: 12px; white-space: pre-wrap; }
.aviso-conta { color: var(--texto-3); background: var(--codigo); padding: 12px; border: 1px solid var(--borda-forte); border-radius: 7px; font-size: 12px; }
.conta-identidade { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.conta-identidade h2 { font-size: 16px; }
.conta-identidade p { color: var(--texto-3); overflow-wrap: anywhere; }
.conta-formulario { padding: 16px; }
.conta-formulario .linha-acoes { margin-top: 4px; }
.conta-tokens { display: flex; flex-direction: column; gap: 10px; }
.conta-token { padding: 14px 16px; }
.conta-token .linha-token { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.conta-token h3 { font-size: 13px; overflow-wrap: anywhere; }
.conta-token .linha-token > button { margin-left: auto; }
.conta-token .token-metadados { margin: 10px 0 0; color: var(--texto-3); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.conta-token code { font: 11px var(--mono); }
.conta-token .confirmar-token { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-top: 12px; color: var(--texto-3); font-size: 12px; }
.token-segredo { padding: 16px; border-color: var(--verde-borda); display: flex; flex-direction: column; gap: 10px; }
.token-segredo h3 { color: var(--verde-claro); }
.token-segredo input { font: 11px var(--mono); }
.conta-conexao { display: flex; flex-direction: column; gap: 10px; }
.conta-conexao pre { padding: 12px; background: var(--codigo); border: 1px solid var(--borda-forte); border-radius: 7px; font: 11px/1.7 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.conta-conexao p { color: var(--texto-3); font-size: 12px; }
`;

export function paginaDeEntrada(mode: "login" | "cadastro", setup = false): string {
  const cadastro = mode === "cadastro";
  const titulo = cadastro ? "Criar sua conta" : "Entrar no doc-center";
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} · doc-center</title>
<link rel="stylesheet" href="${FONTES}">
<style>${CSS}${CSS_CONTA}</style>
</head>
<body class="entrada">
  <main class="caixa">
    <div class="marca"><div class="linha"><div class="simbolo">${RAIO_SVG}</div><div class="nome">doc-center</div></div></div>
    <div><h1>${titulo}</h1><p class="subtitulo">Seus projetos, documentos e workflows em uma área privada.</p></div>
    ${cadastro && setup ? `<p class="aviso-conta">Esta é a primeira conta. Os projetos e documentos que já existem nesta instalação serão vinculados a ela.</p>` : ""}
    <div class="painel">
      <form class="campos" data-auth method="post" action="/api/auth/${cadastro ? "register" : "login"}">
        ${cadastro ? `<label>nome <input name="nome" required maxlength="120" autocomplete="name"></label>` : ""}
        <label>e-mail <input type="email" name="email" required maxlength="254" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label>senha <input type="password" name="senha" required ${cadastro ? 'minlength="12"' : ""} maxlength="1024" autocomplete="${cadastro ? "new-password" : "current-password"}"></label>
        ${cadastro ? `<p class="explicacao">Use uma senha com pelo menos 12 caracteres.</p>` : ""}
        <p class="erro-formulario" data-form-erro role="alert" hidden></p>
        <button type="submit">${cadastro ? "Criar conta" : "Entrar"}</button>
      </form>
    </div>
    <p class="trocar">${cadastro ? 'Já tem uma conta? <a href="/login">Entrar</a>' : 'Primeiro acesso? <a href="/cadastro">Criar conta</a>'}</p>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}

function data(valor: string): string {
  const instante = new Date(valor);
  return Number.isNaN(instante.getTime()) ? valor : instante.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function cartaoDeToken(token: TokenSummary): string {
  return `<article class="cartao conta-token" data-token-id="${token.id}">
    <div class="linha-token">
      <h3>${escapar(token.nome)}</h3>
      <span class="etiqueta">${token.permissao === "leitura" ? "somente leitura" : "workflow"}</span>
      <button class="discreto perigo" type="button" data-revogar-token="${token.id}">Revogar</button>
    </div>
    <p class="token-metadados"><code>${escapar(token.prefixo)}…</code> · ${token.projeto ? `Projeto: ${escapar(token.projeto)}` : "Todos os seus projetos"}<br>
      Criado em ${escapar(data(token.criadoEm))} · Expira em ${escapar(data(token.expiraEm))}<br>
      Último uso: ${token.ultimoUsoEm ? escapar(data(token.ultimoUsoEm)) : "ainda não utilizado"}</p>
    <div class="confirmar-token" data-confirmar-revogacao hidden>
      <span>A conexão que usa este token perderá o acesso.</span>
      <button class="discreto perigo" type="button" data-confirmar-token="${token.id}">Confirmar revogação</button>
      <button class="discreto" type="button" data-cancelar-token>Cancelar</button>
    </div>
    <p class="erro-formulario" data-form-erro role="alert" hidden></p>
  </article>`;
}

export function paginaDaConta(store: Store, usuario: UsuarioDaConta, tokens: TokenSummary[], mcpPublicUrl?: string): string {
  const projetos = store.listarProjetos();
  const endpoint = mcpPublicUrl ?? "/mcp";
  const enderecoShell = endpoint.replaceAll("'", "'\"'\"'");
  const corpo = `<style>${CSS_CONTA}</style>
    <section class="bloco conta-identidade">
      <div><h2>${escapar(usuario.nome)}</h2><p>${escapar(usuario.email)} · ID da conta: <code>${usuario.id}</code></p></div>
    </section>
    <section class="bloco">
      <h2>Conectar uma CLI ou harness</h2>
      <p class="explicacao">Crie um token para cada conexão. Ele identifica sua conta e limita o que o workflow pode acessar.</p>
      <form class="campos cartao conta-formulario" data-token method="post" action="/api/tokens">
        <label>nome da conexão <input name="nome" required maxlength="120" autocomplete="off" placeholder="ex.: Codex no notebook"></label>
        <div class="dois">
          <label>acesso ao projeto <select name="projeto"><option value="">Todos os meus projetos</option>${projetos.map((projeto) => `<option value="${escapar(projeto.slug)}">${escapar(projeto.nome)}</option>`).join("")}</select></label>
          <label>permissão <select name="permissao"><option value="workflow">Workflow: leitura, memórias e levantamentos</option><option value="leitura">Somente leitura</option></select></label>
        </div>
        <label>validade <select name="dias"><option value="30">30 dias</option><option value="90" selected>90 dias</option><option value="365">1 ano</option></select></label>
        <p class="erro-formulario" data-form-erro role="alert" hidden></p>
        <div class="linha-acoes"><button type="submit">Gerar token</button></div>
      </form>
      <div class="cartao token-segredo" data-token-segredo hidden>
        <h3>Token criado</h3>
        <p class="explicacao">Copie agora e guarde na configuração da sua CLI. Este token é exibido uma única vez.</p>
        <input data-token-valor aria-label="Token criado" readonly autocomplete="off" spellcheck="false">
        <div class="linha-acoes"><button type="button" data-copiar-token>Copiar token</button><button class="discreto" type="button" data-ocultar-token>Já guardei</button></div>
        <p class="explicacao" data-copia-status role="status"></p>
      </div>
    </section>
    <section class="bloco">
      <h2>Seus tokens</h2>
      <p class="explicacao">A lista mostra apenas o prefixo. Revogue uma conexão quando ela deixar de ser usada.</p>
      <div class="conta-tokens" data-lista-tokens>${tokens.map(cartaoDeToken).join("")}</div>
      <p class="vazio" data-tokens-vazio ${tokens.length > 0 ? "hidden" : ""}>Você ainda não criou nenhum token.</p>
    </section>
    <section class="bloco conta-conexao">
      <h2>Configuração MCP</h2>
      <p>Codex, Claude, agy, OpenCode e outras CLIs que aceitam MCP podem usar a mesma conexão. Configure estas variáveis no ambiente do processo:</p>
      <pre data-conexao-comando${mcpPublicUrl === undefined ? "" : ` data-conexao-endpoint="${escapar(mcpPublicUrl)}"`}>export DOC_CENTER_URL='${escapar(enderecoShell)}'
export DOC_CENTER_TOKEN='SEU_TOKEN'
doc-center connect</pre>
      <p>Para clientes MCP por stdio, use <code>doc-center</code> como comando, <code>["connect"]</code> como argumentos e as duas variáveis em <code>env</code>. O comando conecta a CLI à sua conta no servidor.</p>
      <p>Para clientes MCP por HTTP, use <code data-mcp-endpoint>${escapar(endpoint)}</code> e o cabeçalho <code>Authorization: Bearer SEU_TOKEN</code>. Selecione o projeto no workflow ou gere um token restrito a ele.</p>
    </section>`;

  return moldura(store, {
    titulo: "Minha conta",
    caminho: "conta / conexões",
    corpo,
    atual: "/conta",
    direita: {
      titulo: "Acesso à sua conta",
      corpo: `<p class="nota">Seus projetos e seu acervo pertencem à sua conta.</p>
        <p class="nota">Um token de leitura consulta documentos. Um token de workflow também registra levantamentos e memórias. As memórias entram como rascunho para revisão.</p>
        <p class="nota">Um token restrito acessa apenas o projeto escolhido e os documentos que ele utiliza.</p>
        <p class="nota">Use uma conexão por dispositivo ou automação para poder revogá-la separadamente.</p>`,
    },
  });
}
