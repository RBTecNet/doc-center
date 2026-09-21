/**
 * O pouco de JavaScript que a interface precisa.
 *
 * Formulários enviam JSON para a API e recarregam; caixas de seleção salvam ao
 * clicar. Nada de estado no cliente: a página é montada no servidor, e o que se
 * vê é sempre o que está no banco — não uma cópia que pode divergir dele.
 */

const json = async (metodo: string, url: string, dado: unknown): Promise<Response> =>
  fetch(url, { method: metodo, headers: { "content-type": "application/json" }, body: JSON.stringify(dado) });

async function avisar(resposta: Response): Promise<void> {
  if (resposta.ok) {
    location.reload();
    return;
  }
  const corpo = (await resposta.json().catch(() => ({ erro: "falha desconhecida" }))) as { erro?: string };
  alert(corpo.erro ?? `erro ${resposta.status}`);
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
