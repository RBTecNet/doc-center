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
