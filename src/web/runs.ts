/**
 * O visor de runs do capivara — leitura, e só.
 *
 * O harness grava tudo o que faz em `.capivara/runs/<run>/`: eventos, prompts,
 * logs de gate, o estado de cada fase. Está tudo lá desde sempre, e ler no
 * terminal significa saber de cor o nome do arquivo. Aqui isso vira uma tela.
 *
 * O que esta tela NÃO é: parte do harness. Ela abre arquivos que já existem, o
 * harness não sabe que ela existe, não fala com ela e não muda de comportamento
 * se ela estiver fora do ar. A dependência é de uma direção só — disco escrito
 * lá, disco lido aqui — e é por isso que o harness continua rodando inteiro numa
 * máquina onde o doc-center nunca foi instalado.
 *
 * Só leitura, também literalmente: nada aqui escreve, apaga ou renomeia. O pior
 * que uma falha deste módulo pode fazer é não mostrar uma página.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Store } from "../db/store.js";
import { moldura } from "./paginas.js";
import { escapar } from "./escapar.js";

/** Quanto de um log vai para a tela de uma vez. */
const MAX_ARQUIVO = 400_000;

export interface Run {
  id: string;
  /** Quando o run foi tocado pela última vez. */
  quando: Date;
  estagio: string;
  status: string;
}

export interface ProjetoComRuns {
  nome: string;
  runs: number;
  ultimo: Date | null;
}

/**
 * O caminho está mesmo dentro da base?
 *
 * A pergunta que separa um visor de arquivos de um vazamento: tudo o que chega
 * pela URL é texto de fora, e `..` numa string é tudo o que existe entre uma
 * pasta de runs e o `.ssh` de quem rodou o servidor.
 */
export function dentroDa(base: string, candidato: string): boolean {
  const raiz = resolve(base);
  const alvo = resolve(candidato);
  if (alvo === raiz) return true;
  const caminho = relative(raiz, alvo);
  return caminho !== "" && !caminho.startsWith("..") && !isAbsolute(caminho);
}

/** Um nome de pasta, aceito só se for um nome de pasta. */
function nomeSimples(valor: string): string | null {
  return /^[A-Za-z0-9._-]+$/.test(valor) && valor !== "." && valor !== ".." ? valor : null;
}

async function ehDiretorio(caminho: string): Promise<boolean> {
  return await stat(caminho).then((info) => info.isDirectory()).catch(() => false);
}

/** Os projetos da base que têm runs para mostrar. */
export async function projetosComRuns(base: string): Promise<ProjetoComRuns[]> {
  const entradas = await readdir(base, { withFileTypes: true }).catch(() => []);
  const achados: ProjetoComRuns[] = [];

  for (const entrada of entradas) {
    if (!entrada.isDirectory()) continue;
    const runs = await lerRuns(join(base, entrada.name));
    if (runs.length === 0) continue;
    achados.push({ nome: entrada.name, runs: runs.length, ultimo: runs[0]?.quando ?? null });
  }

  return achados.sort((um, outro) => (outro.ultimo?.getTime() ?? 0) - (um.ultimo?.getTime() ?? 0));
}

/** Os runs de um projeto, do mais recente para o mais antigo. */
export async function lerRuns(projectRoot: string): Promise<Run[]> {
  const raiz = join(projectRoot, ".capivara", "runs");
  const entradas = await readdir(raiz, { withFileTypes: true }).catch(() => []);
  const runs: Run[] = [];

  for (const entrada of entradas) {
    if (!entrada.isDirectory()) continue;
    const caminho = join(raiz, entrada.name);
    const info = await stat(caminho).catch(() => null);
    const estado = await readFile(join(caminho, "run.json"), "utf8")
      .then((texto) => JSON.parse(texto) as { stage?: string; status?: string })
      .catch(() => null);

    runs.push({
      id: entrada.name,
      quando: info?.mtime ?? new Date(0),
      estagio: estado?.stage ?? "—",
      status: estado?.status ?? "—",
    });
  }

  return runs.sort((um, outro) => outro.quando.getTime() - um.quando.getTime());
}

/** Os arquivos de um run, em ordem de leitura: estado, eventos, e depois os logs. */
export async function arquivosDoRun(runRoot: string): Promise<string[]> {
  const achados: string[] = [];

  const andar = async (pasta: string): Promise<void> => {
    const entradas = await readdir(pasta, { withFileTypes: true }).catch(() => []);
    for (const entrada of entradas) {
      const caminho = join(pasta, entrada.name);
      if (entrada.isDirectory()) await andar(caminho);
      else if (entrada.isFile() && !entrada.name.startsWith(".")) achados.push(relative(runRoot, caminho));
    }
  };

  await andar(runRoot);
  const peso = (nome: string): number => (nome === "run.json" ? 0 : nome === "events.tsv" ? 1 : 2);
  return achados.sort((um, outro) => peso(um) - peso(outro) || um.localeCompare(outro));
}

function horario(iso: string): string {
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? iso : data.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const quando = (data: Date): string =>
  data.getTime() === 0 ? "—" : data.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

function pagina(store: Store, titulo: string, caminho: string, corpo: string, direita: string, pilula?: string): string {
  return moldura(store, {
    titulo,
    caminho,
    corpo,
    ...(pilula !== undefined ? { pilula } : {}),
    direita: { titulo: "O visor", corpo: direita },
    atual: "",
  });
}

const EXPLICACAO = `<p class="explicacao">
Esta tela lê <code>.capivara/runs/</code> em disco e não escreve nada. O harness
não sabe que ela existe: ele roda igual com o doc-center desligado, e o que se vê
aqui são os mesmos arquivos que <code>capivara</code> grava enquanto trabalha.
</p>`;

function comoLigar(): string {
  return [
    `<div class="bloco">`,
    `<h2>O visor está desligado</h2>`,
    `<p class="explicacao">Ele mostra os runs do capivara que estiverem numa pasta desta máquina. Aponte-a ao subir o doc-center:</p>`,
    `<pre class="previa">doc-center --runs ~/Documentos/Projetos</pre>`,
    `<p class="explicacao">Ou defina <code>DOC_CENTER_RUNS</code> no ambiente. Enquanto não houver pasta, nada muda: o visor é opcional, e nenhuma outra parte do doc-center depende dele.</p>`,
    `</div>`,
  ].join("");
}

function tabela(cabecalho: string[], linhas: string[][]): string {
  return [
    `<table class="runs">`,
    `<thead><tr>${cabecalho.map((celula) => `<th>${escapar(celula)}</th>`).join("")}</tr></thead>`,
    `<tbody>${linhas.map((linha) => `<tr>${linha.map((celula) => `<td>${celula}</td>`).join("")}</tr>`).join("")}</tbody>`,
    `</table>`,
  ].join("");
}

/**
 * Responde uma rota do visor, ou `null` quando a rota não é dele.
 *
 * `base` ausente é o caso normal de quem não ligou o visor: a página explica
 * como ligá-lo em vez de dar 404, porque um link morto no menu ensina menos que
 * uma frase.
 */
export async function paginaDeRuns(store: Store, url: URL, base: string | null): Promise<string | null> {
  const partes = url.pathname.split("/").filter((parte) => parte !== "");
  if (partes[0] !== "runs") return null;

  if (base === null) return pagina(store, "Runs", "visor desligado", comoLigar(), EXPLICACAO);

  const projeto = partes[1] ? nomeSimples(partes[1]) : null;
  const run = partes[2] ? nomeSimples(partes[2]) : null;

  if (partes.length === 1) {
    const projetos = await projetosComRuns(base);
    const corpo =
      projetos.length === 0
        ? `<div class="bloco"><h2>Nenhum run em ${escapar(base)}</h2>${EXPLICACAO}</div>`
        : `<div class="bloco"><h2>Projetos <span class="contagem">${projetos.length}</span></h2>` +
          tabela(
            ["projeto", "runs", "último"],
            projetos.map((entrada) => [
              `<a href="/runs/${encodeURIComponent(entrada.nome)}">${escapar(entrada.nome)}</a>`,
              String(entrada.runs),
              escapar(entrada.ultimo ? quando(entrada.ultimo) : "—"),
            ]),
          ) +
          `</div>`;
    return pagina(store, "Runs", base, corpo, EXPLICACAO);
  }

  if (projeto === null) return null;
  const projectRoot = join(base, projeto);
  if (!dentroDa(base, projectRoot) || !(await ehDiretorio(projectRoot))) return null;

  if (partes.length === 2) {
    const runs = await lerRuns(projectRoot);
    const corpo =
      `<div class="bloco"><h2>${escapar(projeto)} <span class="contagem">${runs.length} run(s)</span></h2>` +
      tabela(
        ["run", "estágio", "estado", "quando"],
        runs.map((entrada) => [
          `<a href="/runs/${encodeURIComponent(projeto)}/${encodeURIComponent(entrada.id)}">${escapar(entrada.id)}</a>`,
          escapar(entrada.estagio),
          escapar(entrada.status),
          escapar(quando(entrada.quando)),
        ]),
      ) +
      `</div>`;
    return pagina(store, projeto, `${base}/${projeto}/.capivara/runs`, corpo, EXPLICACAO);
  }

  if (run === null) return null;
  const runRoot = join(projectRoot, ".capivara", "runs", run);
  if (!dentroDa(base, runRoot) || !(await ehDiretorio(runRoot))) return null;

  const pedido = url.searchParams.get("arquivo");
  if (pedido !== null) {
    const alvo = resolve(runRoot, pedido);
    // O arquivo tem de estar DENTRO do run pedido, não só dentro da base.
    if (!dentroDa(runRoot, alvo)) return null;
    const conteudo = await readFile(alvo, "utf8").catch(() => null);
    if (conteudo === null) return null;

    const cortado = conteudo.length > MAX_ARQUIVO;
    const corpo = [
      `<div class="bloco">`,
      `<h2>${escapar(pedido)} <span class="contagem">${conteudo.length.toLocaleString("pt-BR")} caracteres</span></h2>`,
      `<p class="explicacao"><a href="/runs/${encodeURIComponent(projeto)}/${encodeURIComponent(run)}">voltar ao run</a></p>`,
      `<div class="cartao"><pre class="previa alto">${escapar(cortado ? conteudo.slice(0, MAX_ARQUIVO) : conteudo)}</pre>`,
      cortado ? `<p class="cortado">mostrando os primeiros ${MAX_ARQUIVO.toLocaleString("pt-BR")} caracteres; o arquivo inteiro está em ${escapar(join(runRoot, pedido))}</p>` : "",
      `</div></div>`,
    ].join("");
    return pagina(store, run, `${projeto}/${pedido}`, corpo, EXPLICACAO);
  }

  const arquivos = await arquivosDoRun(runRoot);
  const eventos = await readFile(join(runRoot, "events.tsv"), "utf8").catch(() => "");
  const linhasDeEvento = eventos
    .trimEnd()
    .split("\n")
    .filter((linha) => linha.trim() !== "")
    .slice(-200)
    .map((linha) => linha.split("\t"))
    // O timestamp vem em ISO, que é o certo no arquivo e ilegível na tela: numa
    // coluna estreita ele quebra no meio do "T" e vira duas linhas por evento.
    .map(([instante, ...resto]) => [horario(instante ?? ""), ...resto]);

  const corpo = [
    `<div class="bloco"><h2>Eventos <span class="contagem">${linhasDeEvento.length} último(s)</span></h2>`,
    linhasDeEvento.length === 0
      ? `<p class="explicacao">este run não gravou eventos</p>`
      : tabela(
          ["quando", "estágio", "assunto", "tentativa", "estado", "detalhe"],
          linhasDeEvento.map((colunas) => colunas.map((celula) => escapar(celula))),
        ),
    `</div>`,
    `<div class="bloco"><h2>Arquivos <span class="contagem">${arquivos.length}</span></h2>`,
    tabela(
      ["arquivo"],
      arquivos.map((nome) => [
        `<a href="/runs/${encodeURIComponent(projeto)}/${encodeURIComponent(run)}?arquivo=${encodeURIComponent(nome)}">${escapar(nome)}</a>`,
      ]),
    ),
    `</div>`,
  ].join("");

  return pagina(store, run, `${projeto}${sep}.capivara${sep}runs${sep}${run}`, corpo, EXPLICACAO, "somente leitura");
}
