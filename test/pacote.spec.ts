/**
 * Skill como pacote: do zip até o protocolo.
 *
 * O zip é construído aqui, byte a byte, porque o que precisa ser provado é que
 * lemos o FORMATO — não que sabemos reler o que nós mesmos escrevemos com uma
 * biblioteca. Um zip de verdade traz diretório central, método de compressão e
 * uma pasta raiz em volta de tudo.
 */

import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/db/store.js";
import { createApp, listen } from "../src/http.js";
import { caminhoSeguro, lerZip, pareceTexto, raizComum } from "../src/zip.js";
import { lerFrontmatter, lerPacote, partirDescricao, semFrontmatter } from "../src/skill.js";

/** Um zip de verdade: cabeçalho local, dados, diretório central e fim. */
function montarZip(entradas: { caminho: string; conteudo: Buffer; comprimir?: boolean }[]): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;

  for (const entrada of entradas) {
    const nome = Buffer.from(entrada.caminho, "utf8");
    const comprimir = entrada.comprimir ?? true;
    const dados = comprimir ? deflateRawSync(entrada.conteudo) : entrada.conteudo;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(comprimir ? 8 : 0, 8);
    local.writeUInt32LE(0, 14); // crc: não verificamos, e o formato permite
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(entrada.conteudo.length, 22);
    local.writeUInt16LE(nome.length, 26);
    locais.push(local, nome, dados);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(comprimir ? 8 : 0, 10);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt32LE(entrada.conteudo.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nome);

    deslocamento += 30 + nome.length + dados.length;
  }

  const corpoCentral = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(corpoCentral.length, 12);
  fim.writeUInt32LE(deslocamento, 16);

  return Buffer.concat([...locais, corpoCentral, fim]);
}

const SKILL_MD = `---
name: frontend-design
description: Create distinctive frontend interfaces. Use this skill when the user asks to build web components or pages. Do NOT use for design review or audit.
metadata:
  author: alguém
  version: '1.0.0'
source: https://github.com/exemplo/skill
---

## Design Direction

→ *Consult [typography reference](references/typography.md) for scales.*
`;

function zipDaSkill(): Buffer {
  return montarZip([
    { caminho: "frontend-design/SKILL.md", conteudo: Buffer.from(SKILL_MD, "utf8") },
    { caminho: "frontend-design/references/typography.md", conteudo: Buffer.from("# Tipografia\n\nUse escala modular.", "utf8") },
    // Um print: o binário que motivou aceitar binário.
    { caminho: "frontend-design/referencias/tela.png", conteudo: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]), comprimir: false },
  ]);
}

describe("o leitor de zip", () => {
  it("lê comprimido e armazenado, e tira a pasta raiz do caminho", () => {
    const arquivos = lerZip(zipDaSkill());
    expect(arquivos.map((arquivo) => arquivo.caminho)).toEqual([
      "SKILL.md",
      "references/typography.md",
      "referencias/tela.png",
    ]);
    expect(arquivos[1]?.conteudo.toString("utf8")).toContain("escala modular");
    expect([...(arquivos[2]?.conteudo ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  });

  /*
   * A pasta raiz precisa sair: guardá-la faria o SKILL.md virar
   * `frontend-design/SKILL.md`, e os caminhos relativos que a própria skill cita
   * deixariam de bater com o que materializamos.
   */
  it("só remove a raiz quando ela é comum a todos", () => {
    expect(raizComum(["a/x.md", "a/b/y.md"])).toBe("a/");
    expect(raizComum(["a/x.md", "b/y.md"])).toBe("");
    expect(raizComum(["x.md"])).toBe("");
  });

  /*
   * Caminho vindo de fora não escolhe onde escreve. É o zip slip, e o preço de
   * errar é o diretório inteiro de quem abriu o pacote.
   */
  it("recusa caminho que escapa do pacote", () => {
    expect(caminhoSeguro("../../etc/passwd")).toBeNull();
    expect(caminhoSeguro("/etc/passwd")).toBeNull();
    expect(caminhoSeguro("C:/Windows/x")).toBeNull();
    expect(caminhoSeguro("a/../b.md")).toBeNull();
    expect(caminhoSeguro("references/typography.md")).toBe("references/typography.md");
  });

  it("recusa o que não é zip, dizendo o que não achou", () => {
    expect(() => lerZip(Buffer.from("isto não é um zip"))).toThrow(/não é um zip|pequeno demais/);
  });

  it("distingue texto de binário", () => {
    expect(pareceTexto(Buffer.from("# título\n\ntexto com acentuação", "utf8"))).toBe(true);
    expect(pareceTexto(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(false);
  });
});

describe("o frontmatter é a vitrine já escrita", () => {
  it("lê nome, versão, fonte e parte a descrição em três", () => {
    const lido = lerFrontmatter(SKILL_MD);
    expect(lido.nome).toBe("frontend-design");
    expect(lido.versao).toBe("1.0.0");
    expect(lido.fonte).toBe("https://github.com/exemplo/skill");
    expect(lido.autor).toBe("alguém");
    expect(lido.descricao).toBe("Create distinctive frontend interfaces");
    expect(lido.gatilhos).toContain("the user asks to build web components");
    expect(lido.restricoes).toContain("design review or audit");
  });

  it("descrição sem as marcas vira só descrição", () => {
    const partes = partirDescricao("Gera relatórios em PDF.");
    expect(partes.descricao).toBe("Gera relatórios em PDF");
    expect(partes.gatilhos).toBe("");
    expect(partes.restricoes).toBe("");
  });

  it("arquivo sem frontmatter não inventa campos", () => {
    expect(lerFrontmatter("# só um título")).toMatchObject({ nome: "", descricao: "" });
    expect(semFrontmatter("# só um título")).toBe("# só um título");
  });

  it("o corpo entregue ao modelo não leva o frontmatter", () => {
    const pacote = lerPacote(lerZip(zipDaSkill()));
    expect(pacote.entrada).toBe("SKILL.md");
    expect(pacote.corpo.startsWith("## Design Direction")).toBe(true);
    expect(pacote.corpo).not.toContain("name: frontend-design");
    expect(pacote.arquivos).toHaveLength(2);
  });

  it("pacote sem SKILL.md usa o markdown da raiz, em vez de recusar tudo", () => {
    const outro = montarZip([
      { caminho: "guia.md", conteudo: Buffer.from("# guia") },
      { caminho: "extra/x.md", conteudo: Buffer.from("x") },
    ]);
    expect(lerPacote(lerZip(outro)).entrada).toBe("guia.md");
  });
});

describe("importar e servir o pacote", () => {
  let store: Store;
  let server: Server;
  let base = "";

  const pedir = async (metodo: string, caminho: string, corpo?: unknown) => {
    const resposta = await fetch(`${base}${caminho}`, {
      method: metodo,
      ...(corpo === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) }),
    });
    return { status: resposta.status, dado: (await resposta.json()) as any };
  };

  const rpc = async (method: string, params?: Record<string, unknown>) => {
    const resposta = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
    return (await resposta.json()) as any;
  };

  beforeEach(async () => {
    store = new Store({ file: ":memory:" });
    server = createApp({ store });
    base = `http://127.0.0.1:${await listen(server, 0)}`;
    await pedir("POST", "/api/projetos", { nome: "Biblioteca", pedido: "uma base documental" });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  it("o cartão nasce preenchido pelo frontmatter", async () => {
    const { status, dado } = await pedir("POST", "/api/documentos/importar", {
      zip: zipDaSkill().toString("base64"),
      area: "frontend",
    });

    expect(status).toBe(201);
    expect(dado.documento).toMatchObject({
      titulo: "frontend-design",
      tipo: "skill",
      area: "frontend",
      versao: "1.0.0",
      fonte: "https://github.com/exemplo/skill",
    });
    expect(dado.documento.gatilhos).toContain("build web components");
    expect(dado.documento.arquivos.map((arquivo: { caminho: string }) => arquivo.caminho)).toEqual([
      "references/typography.md",
      "referencias/tela.png",
    ]);
    expect(dado.documento.arquivos.find((a: { caminho: string }) => a.caminho.endsWith(".png")).binario).toBe(true);
  });

  it("área fora da lista vira geral, em vez de virar texto livre", async () => {
    const { dado } = await pedir("POST", "/api/documentos/importar", { zip: zipDaSkill().toString("base64"), area: "inventada" });
    expect(dado.documento.area).toBe("geral");
  });

  /*
   * O pacote é materializado no projeto de quem importou: saber que ele traz
   * executável é responsabilidade de quem avisa, não de quem descobre depois.
   */
  it("avisa quando o pacote traz executável", async () => {
    const comScript = montarZip([
      { caminho: "SKILL.md", conteudo: Buffer.from("# skill") },
      { caminho: "bin/instalar.sh", conteudo: Buffer.from("#!/bin/sh\nrm -rf /") },
    ]);
    const { dado } = await pedir("POST", "/api/documentos/importar", { zip: comScript.toString("base64") });
    expect(dado.executaveis).toEqual(["bin/instalar.sh"]);
  });

  it("o protocolo expõe cada arquivo do pacote, e o binário vai em base64", async () => {
    const { dado } = await pedir("POST", "/api/documentos/importar", { zip: zipDaSkill().toString("base64") });
    await pedir("POST", `/api/projetos/biblioteca/selecoes/${dado.documento.id}`);

    const lista = (await rpc("resources/list")).result.resources as { uri: string }[];
    const uris = lista.map((recurso) => recurso.uri);
    expect(uris).toContain("capivara://biblioteca/docs/skill/frontend-design");
    expect(uris).toContain("capivara://biblioteca/docs/skill/frontend-design/references/typography.md");

    const texto = await rpc("resources/read", { uri: "capivara://biblioteca/docs/skill/frontend-design/references/typography.md" });
    expect(texto.result.contents[0].text).toContain("escala modular");

    const imagem = await rpc("resources/read", { uri: "capivara://biblioteca/docs/skill/frontend-design/referencias/tela.png" });
    expect(imagem.result.contents[0].blob).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]).toString("base64"));
    expect(imagem.result.contents[0].text).toBeUndefined();
  });

  it("arquivo que não existe no pacote é recusado com o caminho", async () => {
    const { dado } = await pedir("POST", "/api/documentos/importar", { zip: zipDaSkill().toString("base64") });
    await pedir("POST", `/api/projetos/biblioteca/selecoes/${dado.documento.id}`);

    const erro = await rpc("resources/read", { uri: "capivara://biblioteca/docs/skill/frontend-design/references/nao-existe.md" });
    expect(erro.error.message).toContain("nao-existe.md");
  });
});
