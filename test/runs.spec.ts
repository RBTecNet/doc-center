/**
 * O visor de runs: lê o que o harness gravou, e nada mais.
 *
 * Os dois testes que importam aqui são o da direção da dependência — o
 * doc-center funciona inteiro sem visor, e o visor funciona sobre arquivos que
 * ninguém preparou para ele — e o da contenção: tudo o que chega pela URL é
 * texto de fora.
 */

import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";
import { arquivosDoRun, dentroDa, lerRuns, projetosComRuns } from "../src/web/runs.js";
import { autenticarTeste } from "./auth-fixture.js";

let store: Store;
let root: Store;
let server: Server | null = null;
let raiz = "";
let raizDoUsuario = "";
let headers: Record<string, string>;

beforeEach(async () => {
  root = new Store({ file: ":memory:" });
  store = root;
  raiz = await mkdtemp(join(tmpdir(), "doc-center-runs-"));
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  root.close();
  await rm(raiz, { recursive: true, force: true });
});

async function runDeMentira(projeto: string, run: string, base = raiz): Promise<string> {
  const pasta = join(base, projeto, ".capivara", "runs", run);
  await mkdir(join(pasta, "logs"), { recursive: true });
  await writeFile(join(pasta, "run.json"), JSON.stringify({ stage: "implement", status: "blocked" }), "utf8");
  await writeFile(join(pasta, "events.tsv"), "2026-09-23\timplement\tP03\t1\tpaused\tgate 2 reprovou\n", "utf8");
  await writeFile(join(pasta, "logs", "P03.cycle-3.log"), "FAIL test/devolucao.spec.ts\n", "utf8");
  return pasta;
}

async function subir(runsRoot?: string): Promise<string> {
  server = createApp({ store: root, ...(runsRoot !== undefined ? { runsRoot } : {}) });
  const porta = await listen(server, 0);
  const base = `http://127.0.0.1:${porta}`;
  const autenticado = await autenticarTeste(root, base);
  store = autenticado.store;
  headers = autenticado.headers;
  raizDoUsuario = join(raiz, String(autenticado.usuarioId));
  store.criarProjeto({ nome: "Locadora", slug: "locadora" });
  return base;
}

async function registrarOutraConta(base: string): Promise<{ store: Store; headers: Record<string, string>; raiz: string }> {
  const resposta = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "Outra pessoa", email: "outra@example.com", senha: "senha-segura-da-outra-pessoa" }),
  });
  expect(resposta.status).toBe(201);
  const { usuario } = await resposta.json() as { usuario: { id: number } };
  const cookie = resposta.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  return { store: root.forUser(usuario.id), headers: { cookie: cookie! }, raiz: join(raiz, String(usuario.id)) };
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
    await writeFile(join(raiz, "segredo.txt"), "isto não pode sair", "utf8");
    const url = await subir(raiz);
    await runDeMentira("locadora", "build-aaa", raizDoUsuario);

    const fuga = await fetch(`${url}/runs/locadora/build-aaa?arquivo=${encodeURIComponent("../../../segredo.txt")}`, { headers });
    expect(fuga.status).toBe(404);
    expect(await fuga.text()).not.toContain("isto não pode sair");
  });

  it("recusa nome de projeto que não seja um nome de pasta", async () => {
    const url = await subir(raiz);
    await runDeMentira("locadora", "build-aaa", raizDoUsuario);
    expect((await fetch(`${url}/runs/${encodeURIComponent("../..")}`, { headers })).status).toBe(404);
  });
});

describe("as telas", () => {
  it("mostra os eventos e os arquivos de um run", async () => {
    const url = await subir(raiz);
    await runDeMentira("locadora", "build-aaa", raizDoUsuario);

    const html = await (await fetch(`${url}/runs/locadora/build-aaa`, { headers })).text();
    expect(html).toContain("gate 2 reprovou");
    expect(html).toContain("P03.cycle-3.log");
    expect(html).toContain("somente leitura");
  });

  it("abre o log pedido", async () => {
    const url = await subir(raiz);
    await runDeMentira("locadora", "build-aaa", raizDoUsuario);

    const html = await (await fetch(`${url}/runs/locadora/build-aaa?arquivo=${encodeURIComponent("logs/P03.cycle-3.log")}`, { headers })).text();
    expect(html).toContain("FAIL test/devolucao.spec.ts");
  });

  it("desligado, explica como ligar em vez de dar erro — e o resto do doc-center não muda", async () => {
    const url = await subir();

    const visor = await fetch(`${url}/runs`, { headers });
    expect(visor.status).toBe(200);
    expect(await visor.text()).toContain("DOC_CENTER_RUNS");

    // A prova da direção da dependência: sem visor, a aplicação inteira responde igual.
    expect((await fetch(`${url}/`, { headers })).status).toBe(200);
  });
});

describe("isolamento das contas no visor", () => {
  it("separa runs mesmo quando as duas contas têm um projeto com o mesmo slug", async () => {
    const url = await subir(raiz);
    const primeiraPasta = await runDeMentira("locadora", "build-primeira", raizDoUsuario);
    await writeFile(join(primeiraPasta, "logs", "privado.log"), "log privado da primeira conta", "utf8");
    const outra = await registrarOutraConta(url);
    outra.store.criarProjeto({ nome: "Locadora da outra pessoa", slug: "locadora" });
    const segundaPasta = await runDeMentira("locadora", "build-segunda", outra.raiz);
    await writeFile(join(segundaPasta, "logs", "privado.log"), "log privado da segunda conta", "utf8");

    const primeiraLista = await (await fetch(`${url}/runs/locadora`, { headers })).text();
    expect(primeiraLista).toContain("build-primeira");
    expect(primeiraLista).not.toContain("build-segunda");
    const segundaLista = await (await fetch(`${url}/runs/locadora`, { headers: outra.headers })).text();
    expect(segundaLista).toContain("build-segunda");
    expect(segundaLista).not.toContain("build-primeira");

    const primeiraLeitura = await fetch(`${url}/runs/locadora/build-primeira?arquivo=logs/privado.log`, { headers });
    expect(primeiraLeitura.status).toBe(200);
    expect(await primeiraLeitura.text()).toContain("log privado da primeira conta");
    const segundaLeitura = await fetch(`${url}/runs/locadora/build-segunda?arquivo=logs/privado.log`, { headers: outra.headers });
    expect(segundaLeitura.status).toBe(200);
    expect(await segundaLeitura.text()).toContain("log privado da segunda conta");

    const fuga = await fetch(`${url}/runs/locadora/build-primeira?arquivo=logs/privado.log`, { headers: outra.headers });
    expect(fuga.status).toBe(404);
    expect(await fuga.text()).not.toContain("log privado da primeira conta");
    expect((await fetch(`${url}/runs/locadora/build-segunda`, { headers })).status).toBe(404);
  });

  it("omite pastas sem projeto da conta e runs antigos fora de seu namespace", async () => {
    const url = await subir(raiz);
    await runDeMentira("locadora", "build-proprio", raizDoUsuario);
    await runDeMentira("locadora", "build-legado", raiz);
    await runDeMentira("sem-dono", "build-orfao", raizDoUsuario);
    const outra = await registrarOutraConta(url);
    outra.store.criarProjeto({ nome: "Projeto privado", slug: "exclusivo-outra" });
    // Mesmo se uma pasta de outra conta cair no namespace por erro operacional,
    // ela não passa a ser um projeto pertencente à primeira conta.
    await runDeMentira("exclusivo-outra", "build-alheio", raizDoUsuario);

    const lista = await fetch(`${url}/runs`, { headers });
    expect(lista.status).toBe(200);
    const html = await lista.text();
    expect(html).toContain('href="/runs/locadora"');
    expect(html).not.toContain("sem-dono");
    expect(html).not.toContain("exclusivo-outra");
    for (const caminho of ["/runs/sem-dono", "/runs/sem-dono/build-orfao", "/runs/exclusivo-outra/build-alheio", "/runs/locadora/build-legado"]) {
      expect((await fetch(`${url}${caminho}`, { headers })).status).toBe(404);
    }
  });

  it("bloqueia arquivos e metadados que sejam links para fora do run", async () => {
    const url = await subir(raiz);
    const pasta = await runDeMentira("locadora", "build-proprio", raizDoUsuario);
    const segredo = join(raizDoUsuario, "segredo.txt");
    const estado = join(raizDoUsuario, "estado-externo.json");
    const eventos = join(raizDoUsuario, "eventos-externos.tsv");
    await writeFile(segredo, "SEGREDO_FORA_DO_RUN", "utf8");
    await writeFile(estado, JSON.stringify({ stage: "ESTAGIO_EXTERNO_PRIVADO", status: "blocked" }), "utf8");
    await writeFile(eventos, "2026-09-23\timplement\tP03\t1\tpaused\tEVENTO_EXTERNO_PRIVADO\n", "utf8");
    await symlink(segredo, join(pasta, "logs", "atalho.log"));
    await unlink(join(pasta, "run.json"));
    await unlink(join(pasta, "events.tsv"));
    await symlink(estado, join(pasta, "run.json"));
    await symlink(eventos, join(pasta, "events.tsv"));

    const projeto = await (await fetch(`${url}/runs/locadora`, { headers })).text();
    expect(projeto).toContain("build-proprio");
    expect(projeto).not.toContain("ESTAGIO_EXTERNO_PRIVADO");
    const pagina = await fetch(`${url}/runs/locadora/build-proprio`, { headers });
    expect(pagina.status).toBe(200);
    const html = await pagina.text();
    expect(html).toContain("P03.cycle-3.log");
    expect(html).not.toContain("atalho.log");
    expect(html).not.toContain("EVENTO_EXTERNO_PRIVADO");
    for (const arquivo of ["logs/atalho.log", "run.json", "events.tsv"]) {
      const resposta = await fetch(`${url}/runs/locadora/build-proprio?arquivo=${encodeURIComponent(arquivo)}`, { headers });
      expect(resposta.status).toBe(404);
      expect(await resposta.text()).not.toMatch(/SEGREDO_FORA_DO_RUN|ESTAGIO_EXTERNO_PRIVADO|EVENTO_EXTERNO_PRIVADO/);
    }
  });

  it("não segue .capivara/runs apontando para os runs de outra conta", async () => {
    const url = await subir(raiz);
    const outra = await registrarOutraConta(url);
    outra.store.criarProjeto({ nome: "Outra locadora", slug: "locadora" });
    const pasta = await runDeMentira("locadora", "build-alheio", outra.raiz);
    await writeFile(join(pasta, "events.tsv"), "2026-09-23\timplement\tP03\t1\tpaused\tEVENTO_DA_OUTRA_CONTA\n", "utf8");
    await mkdir(join(raizDoUsuario, "locadora", ".capivara"), { recursive: true });
    await symlink(join(outra.raiz, "locadora", ".capivara", "runs"), join(raizDoUsuario, "locadora", ".capivara", "runs"));

    const lista = await (await fetch(`${url}/runs`, { headers })).text();
    expect(lista).not.toContain('href="/runs/locadora"');
    for (const caminho of ["/runs/locadora", "/runs/locadora/build-alheio", "/runs/locadora/build-alheio?arquivo=events.tsv"]) {
      const fuga = await fetch(`${url}${caminho}`, { headers });
      expect(fuga.status).toBe(404);
      expect(await fuga.text()).not.toContain("EVENTO_DA_OUTRA_CONTA");
    }
    const proprio = await fetch(`${url}/runs/locadora/build-alheio`, { headers: outra.headers });
    expect(proprio.status).toBe(200);
    expect(await proprio.text()).toContain("EVENTO_DA_OUTRA_CONTA");
  });

  it("desliga o visor se o namespace do usuário for um link para outra conta", async () => {
    const url = await subir(raiz);
    const outra = await registrarOutraConta(url);
    outra.store.criarProjeto({ nome: "Outra locadora", slug: "locadora" });
    const pasta = await runDeMentira("locadora", "build-alheio", outra.raiz);
    await writeFile(join(pasta, "events.tsv"), "2026-09-23\timplement\tP03\t1\tpaused\tNAMESPACE_PRIVADO_DA_OUTRA_CONTA\n", "utf8");
    await symlink(outra.raiz, raizDoUsuario);

    for (const caminho of ["/runs", "/runs/locadora", "/runs/locadora/build-alheio?arquivo=events.tsv"]) {
      const html = await (await fetch(`${url}${caminho}`, { headers })).text();
      expect(html).toContain("O visor está desligado");
      expect(html).not.toContain("NAMESPACE_PRIVADO_DA_OUTRA_CONTA");
      expect(html).not.toContain("build-alheio");
    }
    const proprio = await (await fetch(`${url}/runs/locadora/build-alheio`, { headers: outra.headers })).text();
    expect(proprio).toContain("NAMESPACE_PRIVADO_DA_OUTRA_CONTA");
  });
});
