/**
 * O visor de runs: lê o que o harness gravou, e nada mais.
 *
 * Os dois testes que importam aqui são o da direção da dependência — o
 * doc-center funciona inteiro sem visor, e o visor funciona sobre arquivos que
 * ninguém preparou para ele — e o da contenção: tudo o que chega pela URL é
 * texto de fora.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";
import { arquivosDoRun, dentroDa, lerRuns, projetosComRuns } from "../src/web/runs.js";

let store: Store;
let server: Server | null = null;
let raiz = "";

beforeEach(async () => {
  store = new Store({ file: ":memory:" });
  raiz = await mkdtemp(join(tmpdir(), "doc-center-runs-"));
});

afterEach(async () => {
  server?.close();
  server = null;
  store.close();
  await rm(raiz, { recursive: true, force: true });
});

async function runDeMentira(projeto: string, run: string): Promise<string> {
  const pasta = join(raiz, projeto, ".capivara", "runs", run);
  await mkdir(join(pasta, "logs"), { recursive: true });
  await writeFile(join(pasta, "run.json"), JSON.stringify({ stage: "implement", status: "blocked" }), "utf8");
  await writeFile(join(pasta, "events.tsv"), "2026-09-23\timplement\tP03\t1\tpaused\tgate 2 reprovou\n", "utf8");
  await writeFile(join(pasta, "logs", "P03.cycle-3.log"), "FAIL test/devolucao.spec.ts\n", "utf8");
  return pasta;
}

async function subir(runsRoot?: string): Promise<string> {
  server = createApp({ store, ...(runsRoot !== undefined ? { runsRoot } : {}) });
  const porta = await listen(server, 0);
  return `http://127.0.0.1:${porta}`;
}

describe("leitura do disco", () => {
  it("encontra os projetos que têm run, e ignora os que não têm", async () => {
    await runDeMentira("locadora", "build-aaa");
    await mkdir(join(raiz, "sem-nada"), { recursive: true });

    const projetos = await projetosComRuns(raiz);
    expect(projetos.map((projeto) => projeto.nome)).toEqual(["locadora"]);
    expect(projetos[0]?.runs).toBe(1);
  });

  it("lê estágio e estado do run.json, sem exigir que ele exista", async () => {
    await runDeMentira("locadora", "build-aaa");
    await mkdir(join(raiz, "locadora", ".capivara", "runs", "init-bbb"), { recursive: true });

    const runs = await lerRuns(join(raiz, "locadora"));
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.id === "build-aaa")?.status).toBe("blocked");
    expect(runs.find((run) => run.id === "init-bbb")?.status).toBe("—");
  });

  it("lista os arquivos com o estado e os eventos primeiro", async () => {
    const pasta = await runDeMentira("locadora", "build-aaa");
    const arquivos = await arquivosDoRun(pasta);
    expect(arquivos.slice(0, 2)).toEqual(["run.json", "events.tsv"]);
    expect(arquivos).toContain(join("logs", "P03.cycle-3.log"));
  });
});

describe("contenção de caminho", () => {
  it("recusa qualquer coisa fora da base", () => {
    expect(dentroDa("/base", "/base/projeto")).toBe(true);
    expect(dentroDa("/base", "/base")).toBe(true);
    expect(dentroDa("/base", "/base/../etc/passwd")).toBe(false);
    expect(dentroDa("/base", "/etc/passwd")).toBe(false);
  });

  it("não serve arquivo de fora do run, nem por caminho relativo", async () => {
    await runDeMentira("locadora", "build-aaa");
    await writeFile(join(raiz, "segredo.txt"), "isto não pode sair", "utf8");
    const url = await subir(raiz);

    const fuga = await fetch(`${url}/runs/locadora/build-aaa?arquivo=${encodeURIComponent("../../../segredo.txt")}`);
    expect(fuga.status).toBe(404);
    expect(await fuga.text()).not.toContain("isto não pode sair");
  });

  it("recusa nome de projeto que não seja um nome de pasta", async () => {
    await runDeMentira("locadora", "build-aaa");
    const url = await subir(raiz);
    expect((await fetch(`${url}/runs/${encodeURIComponent("../..")}`)).status).toBe(404);
  });
});

describe("as telas", () => {
  it("mostra os eventos e os arquivos de um run", async () => {
    await runDeMentira("locadora", "build-aaa");
    const url = await subir(raiz);

    const html = await (await fetch(`${url}/runs/locadora/build-aaa`)).text();
    expect(html).toContain("gate 2 reprovou");
    expect(html).toContain("P03.cycle-3.log");
    expect(html).toContain("somente leitura");
  });

  it("abre o log pedido", async () => {
    await runDeMentira("locadora", "build-aaa");
    const url = await subir(raiz);

    const html = await (await fetch(`${url}/runs/locadora/build-aaa?arquivo=${encodeURIComponent("logs/P03.cycle-3.log")}`)).text();
    expect(html).toContain("FAIL test/devolucao.spec.ts");
  });

  it("desligado, explica como ligar em vez de dar erro — e o resto do doc-center não muda", async () => {
    const url = await subir();

    const visor = await fetch(`${url}/runs`);
    expect(visor.status).toBe(200);
    expect(await visor.text()).toContain("DOC_CENTER_RUNS");

    // A prova da direção da dependência: sem visor, a aplicação inteira responde igual.
    expect((await fetch(`${url}/`)).status).toBe(200);
  });
});
