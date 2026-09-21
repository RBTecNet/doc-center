/**
 * A aparência, tirada da referência do console.
 *
 * Os valores não foram escolhidos aqui: vieram do `docs/Harness Console.html`,
 * que é a referência visual do projeto. Por isso são tokens e não literais
 * espalhados — quando a referência mudar, muda este arquivo, e as telas, que não
 * conhecem cor nenhuma, acompanham.
 *
 * O tema é escuro e só. A referência é um console, e um console que às vezes
 * fica claro não é o mesmo produto; um tema claro aqui seria invenção nossa, não
 * adaptação.
 *
 * As fontes vêm do Google quando há rede e caem para as do sistema quando não
 * há — a aplicação é local e precisa abrir de qualquer jeito.
 */

export const FONTES = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";

export const CSS = `
:root {
  /* superfícies, do fundo para a frente */
  --fundo: #0b0d10;
  --painel: #0f1216;
  --painel-2: #12161b;
  --elevado: #14181e;
  --codigo: #101418;

  /* traços */
  --borda: #1e242b;
  --borda-sutil: #212831;
  --borda-forte: #252c35;
  --borda-viva: #37404b;

  /* texto */
  --texto: #e4e7eb;
  --texto-2: #d7dce2;
  --texto-3: #9aa4b0;
  --fraco: #7f8b98;
  --apagado: #5c6673;

  /* destaque: o verde do harness */
  --verde: #58c9a3;
  --verde-claro: #7ee0bd;
  --verde-fundo: #16352c;
  --verde-borda: #2b6b58;
  --verde-hover: #1b4237;

  /* acentos de significado */
  --ambar: #e0a458;
  --vermelho: #e06c75;
  --azul-fundo: #1b2b3a;
  --azul-borda: #24405a;
  --azul-texto: #dceaf6;

  --hover: #171c22;

  --sans: 'IBM Plex Sans', system-ui, -apple-system, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  height: 100vh;
  overflow: hidden;
  background: var(--fundo);
  color: var(--texto);
  font: 13px/1.45 var(--sans);
  -webkit-font-smoothing: antialiased;
}

.console { display: flex; height: 100vh; width: 100%; overflow: hidden; }

/* ─────────────────────────────────────────── lateral esquerda: os projetos */

.lateral {
  width: 298px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--painel);
  border-right: 1px solid var(--borda);
}

.marca {
  padding: 16px 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  border-bottom: 1px solid var(--borda);
}
.marca .linha { display: flex; align-items: center; gap: 9px; }
.marca .simbolo {
  width: 22px; height: 22px; border-radius: 6px; background: var(--verde);
  display: flex; align-items: center; justify-content: center; flex: none;
}
.marca .nome { font-size: 13px; font-weight: 600; letter-spacing: -.01em; }
.marca .versao {
  margin-left: auto; font: 10px var(--mono); color: var(--apagado);
  border: 1px solid #232a32; border-radius: 4px; padding: 1px 5px;
}

.acao-principal {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  width: 100%; padding: 8px 10px;
  border-radius: 7px; border: 1px solid var(--verde-borda);
  background: var(--verde-fundo); color: var(--verde-claro);
  font: 600 12px var(--sans); cursor: pointer; transition: background .15s;
}
.acao-principal:hover { background: var(--verde-hover); }

.arvore { flex: 1; overflow-y: auto; padding: 10px 8px 16px; }
.rotulo {
  font: 10px var(--mono); color: var(--apagado);
  text-transform: uppercase; letter-spacing: .09em; padding: 4px 8px 8px;
}

/* Uma linha da árvore: pasta que abre (summary) ou folha (a). A indentação vem
   das guias verticais, como na referência — elas mostram a profundidade sem
   depender de margem, que se perde quando a linha quebra. */
.arvore summary, .arvore .folha {
  display: flex; align-items: center; gap: 6px;
  min-height: 28px; padding: 2px 6px 2px 2px; border-radius: 6px;
  color: var(--texto-3); text-decoration: none; font-size: 12.5px;
  cursor: pointer; list-style: none; transition: background .12s;
}
.arvore summary::-webkit-details-marker { display: none; }
.arvore summary:hover, .arvore .folha:hover { background: var(--hover); color: var(--texto); }
.arvore .folha.vazia { color: var(--apagado); font-style: italic; cursor: default; }
.arvore .folha.vazia:hover { background: transparent; }

.guia { width: 13px; flex: none; align-self: stretch; border-left: 1px solid var(--borda-sutil); margin-left: 5px; }

.rotulo-item { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contador { margin-left: auto; font: 10px var(--mono); color: var(--apagado); flex: none; }

.titulo-ramo { color: inherit; text-decoration: none; font-weight: 500; }
.titulo-ramo.ativo { color: var(--verde-claro); }

/* A seta gira e a pasta troca de rosto: o estado do ramo é visível de longe. */
.seta { flex: none; color: var(--apagado); transition: transform .15s; }
details[open] > summary .seta { transform: rotate(90deg); }
.icone-pasta, .icone-pasta-aberta { display: flex; flex: none; }
details[open] > summary .icone-pasta { display: none; }
details:not([open]) > summary .icone-pasta-aberta { display: none; }

.arvore .ramo { display: block; }

/* A lixeira fica discreta e só acende no hover da linha: ela apaga o projeto
   inteiro, e um botão vermelho permanente ao lado de cada nome convida ao
   clique errado. O contador cede o lugar quando ela aparece. */
.lixeira {
  flex: none; display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; border-radius: 5px;
  background: transparent; border: 1px solid transparent; color: var(--apagado);
  opacity: 0; transition: opacity .12s, color .12s, border-color .12s;
}
.arvore summary:hover .lixeira { opacity: 1; }
.lixeira:hover { color: var(--vermelho); border-color: #4a2529; background: transparent; }
.lixeira:focus-visible { opacity: 1; outline: none; border-color: var(--vermelho); }

/* ──────────────────────────────────────────────────────── painel central */

.central { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--fundo); }

.topo {
  height: 46px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 18px; border-bottom: 1px solid var(--borda); background: var(--painel);
}
.topo h1 { font-size: 12.5px; font-weight: 600; }
.topo .caminho { font: 11px var(--mono); color: var(--apagado); }
/* Nome próprio: ".direita" é o painel lateral, e reusar aquele nome aqui dava
   ao cabeçalho a largura e a borda do painel — uma coluna vazia no topo. */
.topo .acoes-topo { margin-left: auto; display: flex; align-items: center; gap: 8px; }

.pilula {
  font: 10.5px var(--mono); color: var(--verde-claro);
  background: var(--verde-fundo); border: 1px solid var(--verde-borda);
  border-radius: 5px; padding: 3px 8px;
}

.rolagem { flex: 1; overflow-y: auto; padding: 22px 24px 40px; }
.coluna { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }

.explicacao { color: var(--fraco); font-size: 12.5px; }
.explicacao code { font: 11.5px var(--mono); color: var(--texto-3); }

.bloco { display: flex; flex-direction: column; gap: 10px; }
.bloco h2 { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.bloco h2 .contagem { font: 10px var(--mono); color: var(--apagado); font-weight: 400; }

/* ────────────────────────────────────────────────────────────── documentos */

.cartao {
  border: 1px solid var(--borda-sutil); background: var(--elevado);
  border-radius: 9px; overflow: hidden;
}
.cartao > header {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; background: var(--painel-2); border-bottom: 1px solid var(--borda-sutil);
}
.cartao h3 { font-size: 12.5px; font-weight: 600; }
.cartao .uri { margin-left: auto; font: 10px var(--mono); color: var(--apagado); }
.cartao .previa {
  padding: 11px 13px; font: 11.5px/1.6 var(--mono); color: var(--texto-3);
  white-space: pre-wrap; max-height: 150px; overflow: hidden; background: var(--codigo);
}
.cartao .acoes { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--borda-sutil); }

.etiqueta {
  font: 500 10px var(--mono); text-transform: uppercase; letter-spacing: .06em;
  padding: 2px 6px; border-radius: 4px;
  background: var(--verde-fundo); color: var(--verde-claro); border: 1px solid var(--verde-borda);
  white-space: nowrap;
}
.etiqueta.geral { background: transparent; color: var(--ambar); border-color: #3a2f20; }

/* ──────────────────────────────────────────────────────────────── catálogo */

.filtros { display: flex; flex-direction: column; gap: 10px; }
.busca { width: 100%; }
.categorias { display: flex; flex-wrap: wrap; gap: 6px; }
.filtro {
  font: 500 11px var(--sans); padding: 5px 10px; border-radius: 999px;
  background: transparent; color: var(--fraco); border: 1px solid var(--borda-forte);
}
.filtro:hover { background: var(--hover); color: var(--texto); }
.filtro.ativo { background: var(--verde-fundo); color: var(--verde-claro); border-color: var(--verde-borda); }
.filtro .contagem { margin-left: 4px; font: 10px var(--mono); opacity: .7; }

.vitrines { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }

/* O cartão do catálogo responde "isto serve para o meu caso?" — por isso mostra
   o que faz, quando usar e quando NÃO usar, e não só o título. */
.vitrine {
  display: flex; flex-direction: column; gap: 9px;
  border: 1px solid var(--borda-sutil); background: var(--elevado);
  border-radius: 9px; padding: 13px 14px;
}
.vitrine.adotado { border-color: var(--verde-borda); }
.vitrine > header { display: flex; align-items: flex-start; gap: 8px; }
.vitrine h3 { font-size: 13px; font-weight: 600; }
.categoria {
  margin-left: auto; flex: none;
  font: 500 10px var(--mono); text-transform: uppercase; letter-spacing: .05em;
  color: var(--ambar); border: 1px solid #3a2f20; border-radius: 999px; padding: 2px 8px;
}
.vitrine .descricao { font-size: 12.5px; color: var(--texto-3); }

/* A área decide em que fase a skill entra: ela precisa ser lida de relance. */
.area {
  flex: none; font: 500 10px var(--mono); text-transform: uppercase; letter-spacing: .05em;
  padding: 2px 7px; border-radius: 4px;
  background: var(--verde-fundo); color: var(--verde-claro); border: 1px solid var(--verde-borda);
}
.area-geral { background: transparent; color: var(--fraco); border-color: var(--borda-forte); }

.pacote > summary {
  cursor: pointer; font: 11px var(--mono); color: var(--fraco);
  list-style: none; padding: 4px 0;
}
.pacote > summary::-webkit-details-marker { display: none; }
.pacote ul { list-style: none; display: flex; flex-direction: column; gap: 3px; padding: 4px 0 0; }
.pacote li { display: flex; align-items: center; gap: 7px; }
.pacote code { font: 10.5px var(--mono); color: var(--texto-3); }
.binario { font: 9px var(--mono); text-transform: uppercase; color: var(--ambar); }

.procedencia { display: flex; gap: 8px; font: 10px var(--mono); color: var(--apagado); }
.procedencia a { color: var(--fraco); }

input[type="file"] { padding: 6px; font: 11.5px var(--mono); }
.vitrine .sem-descricao { font-size: 12px; color: var(--apagado); font-style: italic; }

.faixa { display: flex; gap: 7px; font-size: 11.5px; color: var(--fraco); }
.faixa-rotulo {
  flex: none; font: 500 10px var(--mono); text-transform: uppercase; letter-spacing: .05em;
  padding-top: 1px;
}
.faixa.usar .faixa-rotulo { color: var(--verde); }
.faixa.evitar .faixa-rotulo { color: var(--vermelho); }

.vitrine > footer {
  display: flex; align-items: center; gap: 8px;
  margin-top: 2px; padding-top: 10px; border-top: 1px solid var(--borda-sutil);
}
.vitrine > footer code { font: 10px var(--mono); color: var(--apagado); }
.vitrine > footer .acoes { margin-left: auto; display: flex; gap: 6px; }

.dois { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 700px) { .dois { grid-template-columns: 1fr; } }

/* ───────────────────────────────────────────────────────────────── seleção */

.escolha { list-style: none; display: flex; flex-direction: column; gap: 4px; }
.escolha label {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 11px; border: 1px solid var(--borda-sutil); border-radius: 7px;
  background: var(--painel-2); cursor: pointer; transition: border-color .12s, background .12s;
}
.escolha label:hover { background: var(--hover); border-color: var(--borda-forte); }
.escolha input:checked ~ .titulo { color: var(--texto); }
.escolha .titulo { color: var(--fraco); }
.escolha input { accent-color: var(--verde); width: 14px; height: 14px; }

/* ─────────────────────────────────────────────────────────── formulários */

input, select, textarea {
  font: 12.5px var(--sans); color: var(--texto);
  background: var(--painel-2); border: 1px solid var(--borda-forte);
  border-radius: 6px; padding: 7px 10px; width: 100%;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--verde-borda); }
textarea { font: 12px/1.6 var(--mono); resize: vertical; }

button {
  font: 600 11.5px var(--sans); cursor: pointer;
  border-radius: 6px; padding: 7px 12px;
  background: var(--verde-fundo); color: var(--verde-claro); border: 1px solid var(--verde-borda);
  transition: background .15s;
}
button:hover { background: var(--verde-hover); }
button.discreto { background: transparent; color: var(--fraco); border-color: var(--borda-forte); }
button.discreto:hover { color: var(--texto); border-color: var(--borda-viva); background: transparent; }
button.perigo:hover { color: var(--vermelho); border-color: #4a2529; }

form.campos { display: flex; flex-direction: column; gap: 10px; }
form.campos label { display: flex; flex-direction: column; gap: 4px; font: 10px var(--mono); color: var(--apagado); text-transform: uppercase; letter-spacing: .08em; }
.linha-acoes { display: flex; gap: 8px; align-items: center; }

details.dobra > summary {
  cursor: pointer; color: var(--verde-claro); font-size: 11.5px; font-weight: 600;
  list-style: none; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--verde-borda); background: var(--verde-fundo);
  border-radius: 7px; padding: 7px 11px;
}
details.dobra > summary::-webkit-details-marker { display: none; }
details.dobra[open] > summary { margin-bottom: 12px; }
details.dobra .corpo { border: 1px solid var(--borda-sutil); background: var(--elevado); border-radius: 9px; padding: 14px; }

/* ──────────────────────────────────────────── lateral direita: o que sai */

.direita {
  width: 300px; flex: none; background: var(--painel);
  border-left: 1px solid var(--borda); display: flex; flex-direction: column;
}
.direita header { height: 46px; display: flex; align-items: center; padding: 0 14px; border-bottom: 1px solid var(--borda); }
.direita header h2 { font-size: 11.5px; font-weight: 600; }
.direita .corpo { flex: 1; overflow-y: auto; padding: 12px 14px 24px; display: flex; flex-direction: column; gap: 10px; }
.direita .uri {
  font: 10.5px/1.5 var(--mono); color: var(--texto-3);
  background: var(--codigo); border: 1px solid var(--borda-sutil);
  border-radius: 6px; padding: 7px 9px; word-break: break-all;
}
.direita .uri .tipo { color: var(--verde); }
.direita .nota { font-size: 11.5px; color: var(--apagado); }

.vazio { color: var(--apagado); font-size: 12px; font-style: italic; }

::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: #1d232b; border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background: var(--borda-viva); }
::-webkit-scrollbar-track { background: transparent; }

@media (max-width: 1100px) { .direita { display: none; } }
@media (max-width: 760px) { .lateral { display: none; } }
`;

/** O raio do harness, usado na marca e no avatar do agente. */
export const RAIO_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#0b0d10" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"></path></svg>';

export const PASTA_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#e0a458" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.7a2 2 0 0 1 1.4.6L11.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path></svg>';

export const ARQUIVO_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7f8b98" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"></path><path d="M14 3v5h5"></path></svg>';

export const MAIS_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>';

export const PASTA_ABERTA_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#e0a458" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 8H19a2 2 0 0 1 2 2v.5H6.2a2 2 0 0 0-1.9 1.4L3 17.5V8z"></path><path d="M3 17.6 4.4 12a2 2 0 0 1 1.9-1.4H21l-1.6 6a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-1.4z"></path></svg>';

export const TEXTO_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#7f8b98" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"></path></svg>';

export const SETA_SVG =
  '<svg class="seta" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>';

export const LIXEIRA_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>';
