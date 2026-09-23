/**
 * Sobe a aplicação.
 *
 *     doc-center [--port 7777] [--db caminho.db]
 *
 * `PORT` do ambiente também vale — é o que qualquer supervisor de processo
 * espera poder definir, inclusive o gate 4 do capivara quando ele exercitar
 * esta aplicação.
 */

import { Store } from "./db/store.js";
import { createApp, listen } from "./http.js";

declare const __DOC_CENTER_VERSION__: string;

function argumento(nome: string, padrao: string): string {
  const indice = process.argv.indexOf(`--${nome}`);
  return indice >= 0 ? (process.argv[indice + 1] ?? padrao) : padrao;
}

const arquivo = argumento("db", process.env.DOC_CENTER_DB ?? "doc-center.db");
const porta = Number(argumento("port", process.env.PORT ?? "7777"));
const host = argumento("host", process.env.HOST ?? "127.0.0.1");
/*
 * A pasta dos projetos do capivara, para o visor de runs. Vazia desliga o visor:
 * ele lê arquivos que o harness já grava, e o harness não sabe que ele existe.
 */
const runs = argumento("runs", process.env.DOC_CENTER_RUNS ?? "");

const store = new Store({ file: arquivo });
const app = createApp({ store, ...(runs !== "" ? { runsRoot: runs } : {}) });
const emUso = await listen(app, porta, host);

process.stdout.write(
  `doc-center ${typeof __DOC_CENTER_VERSION__ === "string" ? __DOC_CENTER_VERSION__ : ""}\n` +
    `  interface  http://${host}:${emUso}/\n` +
    `  mcp        http://${host}:${emUso}/mcp\n` +
    `  banco      ${arquivo}\n` +
    (runs !== "" ? `  runs       http://${host}:${emUso}/runs  (somente leitura, de ${runs})\n` : ""),
);

for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinal, () => {
    app.close();
    store.close();
    process.exit(0);
  });
}
