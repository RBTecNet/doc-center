/**
 * O pouco de JavaScript que a interface precisa.
 *
 * Formulários enviam JSON para a API e recarregam; caixas de seleção salvam ao
 * clicar. Nada de estado no cliente: a página é montada no servidor, e o que se
 * vê é sempre o que está no banco — não uma cópia que pode divergir dele.
 */

const json = async (metodo: string, url: string, dado: unknown): Promise<Response> =>
  fetch(url, { method: metodo, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(dado) });

async function avisar(resposta: Response): Promise<void> {
  if (resposta.status === 401) {
    location.href = "/login";
    return;
  }
  if (resposta.ok) {
    location.reload();
    return;
  }
  const corpo = (await resposta.json().catch(() => ({ erro: "falha desconhecida" }))) as { erro?: string };
  alert(corpo.erro ?? `erro ${resposta.status}`);
}

/** Autenticação e tokens usam feedback na própria tela; credenciais ficam só no DOM. */
function erroDoFormulario(elemento: ParentNode, mensagem: string): void {
  const aviso = elemento.querySelector<HTMLElement>("[data-form-erro]");
  if (!aviso) return;
  aviso.textContent = mensagem;
  aviso.hidden = mensagem === "";
}

async function mensagemDoErro(resposta: Response): Promise<string> {
  const corpo = (await resposta.json().catch(() => ({}))) as { erro?: unknown };
  return typeof corpo.erro === "string" ? corpo.erro : `Não foi possível concluir a operação (${resposta.status}).`;
}

for (const formulario of document.querySelectorAll<HTMLFormElement>("form[data-auth]")) {
  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = formulario.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (botao?.disabled) return;
    const textoAnterior = botao?.textContent ?? "Entrar";
    erroDoFormulario(formulario, "");
    if (botao) { botao.disabled = true; botao.textContent = "Aguarde…"; }
    try {
      const dados = Object.fromEntries(new FormData(formulario).entries());
      const resposta = await json("POST", formulario.action, dados);
      if (!resposta.ok) {
        erroDoFormulario(formulario, await mensagemDoErro(resposta));
        return;
      }
      formulario.reset();
      location.href = "/";
    } catch {
      erroDoFormulario(formulario, "Não foi possível conectar. Verifique sua conexão e tente novamente.");
    } finally {
      if (botao) { botao.disabled = false; botao.textContent = textoAnterior; }
    }
  });
}

document.querySelector<HTMLButtonElement>("[data-sair]")?.addEventListener("click", async (evento) => {
  const botao = evento.currentTarget as HTMLButtonElement;
  const aviso = document.querySelector<HTMLElement>("[data-sair-erro]");
  botao.disabled = true;
  if (aviso) { aviso.hidden = true; aviso.textContent = ""; }
  try {
    const resposta = await json("POST", "/api/auth/logout", {});
    if (!resposta.ok && resposta.status !== 401) throw new Error(await mensagemDoErro(resposta));
    location.href = "/login";
  } catch (erro) {
    if (aviso) {
      aviso.textContent = erro instanceof Error ? erro.message : "Falha ao sair. Tente novamente.";
      aviso.hidden = false;
    }
    botao.disabled = false;
  }
});

interface TokenNaTela {
  id: number;
  nome: string;
  prefixo: string;
  projeto: string | null;
  permissao: "leitura" | "workflow";
  criadoEm: string;
  expiraEm: string;
  ultimoUsoEm: string | null;
}

function dataNaTela(valor: string): string {
  const instante = new Date(valor);
  return Number.isNaN(instante.getTime()) ? valor : instante.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function novoCartaoDeToken(token: TokenNaTela): HTMLElement {
  const cartao = document.createElement("article");
  cartao.className = "cartao conta-token";
  cartao.dataset.tokenId = String(token.id);
  const linha = document.createElement("div");
  linha.className = "linha-token";
  const titulo = document.createElement("h3");
  titulo.textContent = token.nome;
  const permissao = document.createElement("span");
  permissao.className = "etiqueta";
  permissao.textContent = token.permissao === "leitura" ? "somente leitura" : "workflow";
  const revogar = document.createElement("button");
  revogar.type = "button";
  revogar.className = "discreto perigo";
  revogar.dataset.revogarToken = String(token.id);
  revogar.textContent = "Revogar";
  linha.append(titulo, permissao, revogar);
  const metadados = document.createElement("p");
  metadados.className = "token-metadados";
  metadados.textContent = `${token.prefixo}… · ${token.projeto ? `Projeto: ${token.projeto}` : "Todos os seus projetos"}\n` +
    `Criado em ${dataNaTela(token.criadoEm)} · Expira em ${dataNaTela(token.expiraEm)}\n` +
    `Último uso: ${token.ultimoUsoEm ? dataNaTela(token.ultimoUsoEm) : "ainda não utilizado"}`;
  metadados.style.whiteSpace = "pre-line";
  const confirmar = document.createElement("div");
  confirmar.className = "confirmar-token";
  confirmar.dataset.confirmarRevogacao = "";
  confirmar.hidden = true;
  const explicacao = document.createElement("span");
  explicacao.textContent = "A conexão que usa este token perderá o acesso.";
  const confirmarBotao = document.createElement("button");
  confirmarBotao.type = "button";
  confirmarBotao.className = "discreto perigo";
  confirmarBotao.dataset.confirmarToken = String(token.id);
  confirmarBotao.textContent = "Confirmar revogação";
  const cancelar = document.createElement("button");
  cancelar.type = "button";
  cancelar.className = "discreto";
  cancelar.dataset.cancelarToken = "";
  cancelar.textContent = "Cancelar";
  confirmar.append(explicacao, confirmarBotao, cancelar);
  const erro = document.createElement("p");
  erro.className = "erro-formulario";
  erro.dataset.formErro = "";
  erro.setAttribute("role", "alert");
  erro.hidden = true;
  cartao.append(linha, metadados, confirmar, erro);
  return cartao;
}

const listaTokens = document.querySelector<HTMLElement>("[data-lista-tokens]");
const segredoToken = document.querySelector<HTMLElement>("[data-token-segredo]");
const valorToken = document.querySelector<HTMLInputElement>("[data-token-valor]");

function ocultarToken(): void {
  if (valorToken) valorToken.value = "";
  if (segredoToken) { segredoToken.hidden = true; delete segredoToken.dataset.tokenId; }
  const status = document.querySelector<HTMLElement>("[data-copia-status]");
  if (status) status.textContent = "";
}

for (const formulario of document.querySelectorAll<HTMLFormElement>("form[data-token]")) {
  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = formulario.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (botao?.disabled) return;
    erroDoFormulario(formulario, "");
    if (botao) { botao.disabled = true; botao.textContent = "Gerando…"; }
    try {
      const dados = Object.fromEntries(new FormData(formulario).entries());
      const resposta = await json("POST", formulario.action, {
        nome: dados.nome,
        ...(dados.projeto ? { projeto: dados.projeto } : {}),
        permissao: dados.permissao,
        dias: Number(dados.dias),
      });
      if (!resposta.ok) {
        if (resposta.status === 401) { location.href = "/login"; return; }
        erroDoFormulario(formulario, await mensagemDoErro(resposta));
        return;
      }
      const corpo = (await resposta.json()) as { token: string; credencial: TokenNaTela };
      ocultarToken();
      if (valorToken) valorToken.value = corpo.token;
      if (segredoToken) {
        segredoToken.hidden = false;
        segredoToken.dataset.tokenId = String(corpo.credencial.id);
      }
      listaTokens?.prepend(novoCartaoDeToken(corpo.credencial));
      const vazio = document.querySelector<HTMLElement>("[data-tokens-vazio]");
      if (vazio) vazio.hidden = true;
      formulario.reset();
      valorToken?.focus();
      valorToken?.select();
    } catch {
      erroDoFormulario(formulario, "Não foi possível gerar o token. Verifique a conexão e tente novamente.");
    } finally {
      if (botao) { botao.disabled = false; botao.textContent = "Gerar token"; }
    }
  });
}

listaTokens?.addEventListener("click", async (evento) => {
  if (!(evento.target instanceof Element)) return;
  const botao = evento.target.closest<HTMLButtonElement>("button");
  const cartao = botao?.closest<HTMLElement>("[data-token-id]");
  const confirmar = cartao?.querySelector<HTMLElement>("[data-confirmar-revogacao]");
  if (!botao || !cartao || !confirmar) return;
  if (botao.hasAttribute("data-revogar-token")) {
    confirmar.hidden = false;
    confirmar.querySelector<HTMLButtonElement>("[data-confirmar-token]")?.focus();
    return;
  }
  if (botao.hasAttribute("data-cancelar-token")) {
    confirmar.hidden = true;
    erroDoFormulario(cartao, "");
    cartao.querySelector<HTMLButtonElement>("[data-revogar-token]")?.focus();
    return;
  }
  if (!botao.hasAttribute("data-confirmar-token") || botao.disabled) return;
  const botoes = [...cartao.querySelectorAll<HTMLButtonElement>("button")];
  for (const acao of botoes) acao.disabled = true;
  erroDoFormulario(cartao, "");
  try {
    const resposta = await json("DELETE", `/api/tokens/${encodeURIComponent(botao.dataset.confirmarToken ?? "")}`, {});
    if (!resposta.ok) {
      if (resposta.status === 401) { location.href = "/login"; return; }
      erroDoFormulario(cartao, await mensagemDoErro(resposta));
      return;
    }
    if (segredoToken?.dataset.tokenId === cartao.dataset.tokenId) ocultarToken();
    cartao.remove();
    const vazio = document.querySelector<HTMLElement>("[data-tokens-vazio]");
    if (vazio) vazio.hidden = listaTokens.querySelector("[data-token-id]") !== null;
  } catch {
    erroDoFormulario(cartao, "Não foi possível revogar o token. Tente novamente.");
  } finally {
    for (const acao of botoes) acao.disabled = false;
  }
});

document.querySelector<HTMLButtonElement>("[data-copiar-token]")?.addEventListener("click", async () => {
  if (!valorToken?.value) return;
  const status = document.querySelector<HTMLElement>("[data-copia-status]");
  try {
    await navigator.clipboard.writeText(valorToken.value);
    if (status) status.textContent = "Token copiado.";
  } catch {
    valorToken.focus();
    valorToken.select();
    if (status) status.textContent = "Selecione o token acima e copie com Ctrl+C ou Command+C.";
  }
});
document.querySelector<HTMLButtonElement>("[data-ocultar-token]")?.addEventListener("click", ocultarToken);
window.addEventListener("pagehide", ocultarToken);

const comandoConexao = document.querySelector<HTMLElement>("[data-conexao-comando]");
const enderecoConexao = comandoConexao?.dataset.conexaoEndpoint ?? `${location.origin}/mcp`;
const enderecoConexaoShell = enderecoConexao.replaceAll("'", "'\"'\"'");
if (comandoConexao) comandoConexao.textContent = `export DOC_CENTER_URL='${enderecoConexaoShell}'\nexport DOC_CENTER_TOKEN='SEU_TOKEN'\ndoc-center connect`;
const endpointMcp = document.querySelector<HTMLElement>("[data-mcp-endpoint]");
if (endpointMcp) endpointMcp.textContent = enderecoConexao;

/** Textos completos são buscados sob demanda e permanecem só nesta página. */
const textosDoHistorico = new WeakMap<HTMLElement, Promise<string>>();

function avisoDoHistorico(cartao: HTMLElement, mensagem: string, erro = false): void {
  for (const seletor of ["[data-historico-erro]", "[data-historico-status]"]) {
    const aviso = cartao.querySelector<HTMLElement>(seletor);
    if (aviso) { aviso.hidden = true; aviso.textContent = ""; }
  }
  const aviso = cartao.querySelector<HTMLElement>(erro ? "[data-historico-erro]" : "[data-historico-status]");
  if (aviso) { aviso.textContent = mensagem; aviso.hidden = mensagem === ""; }
}

async function textoDoHistorico(cartao: HTMLElement): Promise<string> {
  const anterior = textosDoHistorico.get(cartao);
  if (anterior) return anterior;
  const pedido = (async () => {
    const projeto = encodeURIComponent(cartao.dataset.projeto ?? "");
    const id = encodeURIComponent(cartao.dataset.entrada ?? "");
    const resposta = await fetch(`/api/projetos/${projeto}/historico/${id}`, { credentials: "same-origin" });
    if (resposta.status === 401) { location.href = "/login"; throw new Error("Sua sessão expirou. Entre novamente."); }
    if (!resposta.ok) throw new Error(await mensagemDoErro(resposta));
    const dado = await resposta.json() as { entrada?: { conteudo?: unknown } };
    if (typeof dado.entrada?.conteudo !== "string") throw new Error("A mensagem não pôde ser carregada.");
    const previa = cartao.querySelector<HTMLElement>("[data-historico-conteudo]");
    if (previa) previa.textContent = dado.entrada.conteudo;
    return dado.entrada.conteudo;
  })();
  textosDoHistorico.set(cartao, pedido);
  try { return await pedido; }
  catch (erro) { textosDoHistorico.delete(cartao); throw erro; }
}

for (const detalhe of document.querySelectorAll<HTMLDetailsElement>("[data-historico-detalhe]")) {
  detalhe.addEventListener("toggle", async () => {
    if (!detalhe.open) return;
    const cartao = detalhe.closest<HTMLElement>("[data-historico-cartao]");
    if (!cartao) return;
    avisoDoHistorico(cartao, "");
    try { await textoDoHistorico(cartao); }
    catch (erro) { avisoDoHistorico(cartao, erro instanceof Error ? erro.message : "Não foi possível carregar a mensagem.", true); }
  });
}

for (const botao of document.querySelectorAll<HTMLButtonElement>("[data-copiar-historico]")) {
  botao.addEventListener("click", async () => {
    const cartao = botao.closest<HTMLElement>("[data-historico-cartao]");
    if (!cartao || botao.disabled) return;
    botao.disabled = true;
    avisoDoHistorico(cartao, "");
    try {
      const conteudo = await textoDoHistorico(cartao);
      try { await navigator.clipboard.writeText(conteudo); avisoDoHistorico(cartao, "Mensagem copiada."); }
      catch {
        const detalhe = cartao.querySelector<HTMLDetailsElement>("[data-historico-detalhe]");
        if (detalhe) detalhe.open = true;
        const texto = cartao.querySelector<HTMLElement>("[data-historico-conteudo]");
        if (texto) {
          const intervalo = document.createRange(); intervalo.selectNodeContents(texto);
          const selecao = window.getSelection(); selecao?.removeAllRanges(); selecao?.addRange(intervalo);
        }
        avisoDoHistorico(cartao, "Mensagem selecionada. Copie com Ctrl+C ou Command+C.");
      }
    } catch (erro) { avisoDoHistorico(cartao, erro instanceof Error ? erro.message : "Não foi possível copiar a mensagem.", true); }
    finally { botao.disabled = false; }
  });
}

for (const formulario of document.querySelectorAll<HTMLFormElement>("[data-reutilizar-historico]")) {
  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const cartao = formulario.closest<HTMLElement>("[data-historico-cartao]");
    const botao = formulario.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!cartao || botao?.disabled) return;
    if (botao) { botao.disabled = true; botao.textContent = "Salvando…"; }
    avisoDoHistorico(cartao, "");
    try {
      const conteudo = await textoDoHistorico(cartao);
      const dados = new FormData(formulario);
      const resposta = await json("POST", formulario.action, { projeto: cartao.dataset.projeto, tipo: "prompt",
        titulo: dados.get("titulo"), conteudo, descricao: `Mensagem preservada no histórico do projeto, entrada ${cartao.dataset.entrada ?? ""}.` });
      if (!resposta.ok) {
        if (resposta.status === 401) { location.href = "/login"; return; }
        throw new Error(await mensagemDoErro(resposta));
      }
      formulario.reset();
      avisoDoHistorico(cartao, "Prompt salvo no projeto. Ele ficará disponível para reutilização.");
    } catch (erro) { avisoDoHistorico(cartao, erro instanceof Error ? erro.message : "Não foi possível salvar o prompt.", true); }
    finally { if (botao) { botao.disabled = false; botao.textContent = "Salvar no projeto"; } }
  });
}

for (const formulario of document.querySelectorAll<HTMLFormElement>("form[data-json]")) {
  formulario.addEventListener("submit", (evento) => {
    evento.preventDefault();
    const dados = Object.fromEntries(new FormData(formulario).entries());
    const metodo = (formulario.getAttribute("method") ?? "post").toUpperCase();
    void json(metodo, formulario.action, dados).then(avisar);
  });
}

const novo = document.querySelector<HTMLButtonElement>("[data-novo-projeto]");
novo?.addEventListener("click", () => {
  const nome = prompt("nome do projeto");
  if (!nome) return;
  void json("POST", "/api/projetos", { nome }).then(avisar);
});

for (const botao of document.querySelectorAll<HTMLButtonElement>("[data-remover]")) {
  botao.addEventListener("click", () => {
    if (!confirm("remover este documento?")) return;
    void json("DELETE", `/api/documentos/${botao.dataset.remover}`, {}).then(avisar);
  });
}

/*
 * Editar abre o conteúdo atual num prompt do navegador. É pouco, e é honesto
 * para um MVP de uso próprio: um editor de verdade é trabalho de tela, não de
 * protocolo, e entra quando o resto estiver firme.
 */
for (const botao of document.querySelectorAll<HTMLButtonElement>("[data-editar]")) {
  botao.addEventListener("click", () => {
    const cartao = botao.closest("article");
    const atual = cartao?.querySelector("pre")?.textContent ?? "";
    const novoTexto = prompt("conteúdo", atual);
    if (novoTexto === null) return;
    void json("PUT", `/api/documentos/${botao.dataset.editar}`, { conteudo: novoTexto }).then(avisar);
  });
}

for (const caixa of document.querySelectorAll<HTMLInputElement>("input[data-selecao]")) {
  caixa.addEventListener("change", () => {
    const projeto = caixa.dataset.projeto ?? "";
    const url = `/api/projetos/${projeto}/selecoes/${caixa.value}`;
    void json(caixa.checked ? "POST" : "DELETE", url, {}).then(async (resposta) => {
      if (!resposta.ok) await avisar(resposta);
    });
  });
}

/*
 * A árvore lembra o que estava aberto.
 *
 * Cada navegação remonta a página no servidor, e sem isto toda pasta que o
 * usuário abriu fecharia ao clicar em qualquer link — o estado da árvore é do
 * usuário, não da requisição. Guardar é por navegador, e por isso fica em
 * localStorage e não no banco: dois navegadores podem ter a árvore aberta de
 * jeitos diferentes sem que um atrapalhe o outro.
 */
for (const botao of document.querySelectorAll<HTMLButtonElement>("[data-remover-projeto]")) {
  botao.addEventListener("click", (evento) => {
    // O botão vive dentro do <summary>: sem isto, o clique também abriria ou
    // fecharia o ramo, e a árvore saltaria embaixo do diálogo.
    evento.preventDefault();
    evento.stopPropagation();

    const slug = botao.dataset.removerProjeto ?? "";
    const nome = botao.dataset.nome ?? slug;
    const proprios = Number(botao.dataset.proprios ?? "0");

    /*
     * A confirmação diz o que some junto. Apagar um projeto leva os documentos
     * que nasceram nele — só a seleção dos documentos da área geral é desfeita,
     * e esses continuam no acervo. Quem confirma precisa saber a diferença antes,
     * não depois.
     */
    const aviso =
      proprios === 0
        ? `Excluir o projeto "${nome}"?`
        : `Excluir o projeto "${nome}" e os ${proprios} documento(s) criados dentro dele?\n\n` +
          `Os documentos da área geral que ele usa continuam no acervo.`;
    if (!confirm(aviso)) return;

    void json("DELETE", `/api/projetos/${slug}`, {}).then(async (resposta) => {
      if (!resposta.ok) {
        await avisar(resposta);
        return;
      }
      // Se o projeto aberto era o excluído, a página dele deixou de existir.
      location.href = location.pathname.includes(`/projetos/${slug}`) ? "/" : location.pathname;
    });
  });
}

const CHAVE = "doc-center:ramos-abertos";

function abertos(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CHAVE) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function guardar(chaves: Set<string>): void {
  try {
    localStorage.setItem(CHAVE, JSON.stringify([...chaves]));
  } catch {
    /* navegador sem armazenamento: a árvore só deixa de lembrar */
  }
}

const lembrados = abertos();
for (const ramo of document.querySelectorAll<HTMLDetailsElement>(".arvore details[data-chave]")) {
  const chave = ramo.dataset.chave ?? "";
  // O ramo do projeto aberto vem aberto do servidor; os outros seguem a memória.
  if (lembrados.has(chave)) ramo.open = true;

  ramo.addEventListener("toggle", () => {
    const atuais = abertos();
    if (ramo.open) atuais.add(chave);
    else atuais.delete(chave);
    guardar(atuais);
  });
}

/*
 * Adotar uma skill ou hook no projeto.
 *
 * Um clique, e a vitrine muda de lado: do "adicionar do catálogo" para a lista
 * do que o projeto usa. Recarregar é o mais simples e o mais honesto — a página
 * é montada no servidor, e o que se vê passa a ser o que está no banco, em vez
 * de uma cópia no cliente que pode divergir dele.
 */
for (const botao of document.querySelectorAll<HTMLButtonElement>("[data-adotar]")) {
  botao.addEventListener("click", () => {
    const projeto = botao.dataset.projeto ?? "";
    const id = botao.dataset.adotar ?? "";
    const jaTem = botao.dataset.estado === "sim";
    void json(jaTem ? "DELETE" : "POST", `/api/projetos/${projeto}/selecoes/${id}`, {}).then(avisar);
  });
}

/*
 * Busca e categoria filtram no cliente, SEÇÃO POR SEÇÃO.
 *
 * Skills e hooks são dois catálogos na mesma página. Um filtro global faria a
 * busca de um esconder os cartões do outro — dois controles idênticos mandando
 * no mesmo conjunto, o que é pior que não ter filtro.
 *
 * O acervo é pequeno e é nosso: paginar no servidor seria construir infra para
 * um problema que não temos. Quando tiver, a marcação já carrega o que a busca
 * precisa — cada cartão traz seu texto em `data-busca`.
 */
for (const secao of document.querySelectorAll<HTMLElement>(".bloco")) {
  const campoBusca = secao.querySelector<HTMLInputElement>("[data-busca]");
  const filtrosCategoria = [...secao.querySelectorAll<HTMLButtonElement>(".filtro")];
  if (!campoBusca && filtrosCategoria.length === 0) continue;

  const aplicar = (): void => {
    const termo = (campoBusca?.value ?? "").trim().toLowerCase();
    const categoria = filtrosCategoria.find((filtro) => filtro.classList.contains("ativo"))?.dataset.categoria ?? "";

    for (const cartao of secao.querySelectorAll<HTMLElement>(".vitrine")) {
      const casaTermo = termo === "" || (cartao.dataset.busca ?? "").includes(termo);
      const casaCategoria = categoria === "" || cartao.dataset.categoria === categoria;
      cartao.style.display = casaTermo && casaCategoria ? "" : "none";
    }
  };

  campoBusca?.addEventListener("input", aplicar);
  for (const filtro of filtrosCategoria) {
    filtro.addEventListener("click", () => {
      for (const outro of filtrosCategoria) outro.classList.toggle("ativo", outro === filtro);
      aplicar();
    });
  }
}

/*
 * Importar pacote.
 *
 * O arquivo vira base64 e sobe pela mesma API JSON do resto — um caminho de
 * upload multipart só para isto seria um segundo jeito de falar com a mesma
 * porta, e os dois divergiriam no dia em que uma regra mudasse.
 */
for (const formulario of document.querySelectorAll<HTMLFormElement>("form[data-pacote]")) {
  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();

    const campo = formulario.querySelector<HTMLInputElement>('input[type="file"]');
    const arquivo = campo?.files?.[0];
    if (!arquivo) {
      alert("escolha o arquivo .zip da skill");
      return;
    }

    const botao = formulario.querySelector("button");
    if (botao) {
      botao.disabled = true;
      botao.textContent = "importando…";
    }

    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    let binario = "";
    for (let inicio = 0; inicio < bytes.length; inicio += 0x8000) {
      binario += String.fromCharCode(...bytes.subarray(inicio, inicio + 0x8000));
    }

    const dados = Object.fromEntries(new FormData(formulario).entries());
    const resposta = await json("POST", "/api/documentos/importar", {
      ...dados,
      zip: btoa(binario),
      tipo: formulario.dataset.tipo ?? "skill",
    });

    if (!resposta.ok) {
      if (botao) {
        botao.disabled = false;
        botao.textContent = "importar";
      }
      await avisar(resposta);
      return;
    }

    // Executável no pacote não impede nada, mas quem importou precisa saber: o
    // pacote vai ser materializado dentro do projeto.
    const corpo = (await resposta.json()) as { executaveis?: string[] };
    if (corpo.executaveis && corpo.executaveis.length > 0) {
      alert(`Importado. O pacote traz executável:\n\n${corpo.executaveis.join("\n")}`);
    }
    location.reload();
  });
}

for (const botao of document.querySelectorAll<HTMLButtonElement>("[data-aprovar]")) {
  botao.addEventListener("click", () => {
    void json("POST", `/api/documentos/${botao.dataset.aprovar}/aprovar`, {}).then(avisar);
  });
}
