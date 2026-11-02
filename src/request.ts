import type { IncomingMessage } from "node:http";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function lerCorpo(req: IncomingMessage, limite = 24 * 1024 * 1024): Promise<string> {
  const partes: Buffer[] = [];
  let tamanho = 0;
  for await (const pedaco of req) {
    const parte = Buffer.isBuffer(pedaco) ? pedaco : Buffer.from(pedaco);
    tamanho += parte.length;
    if (tamanho > limite) throw new HttpError(413, "o corpo da requisição excede o limite permitido");
    partes.push(parte);
  }
  return Buffer.concat(partes).toString("utf8");
}

export async function corpoJson(req: IncomingMessage, limite?: number): Promise<Record<string, unknown>> {
  const texto = await lerCorpo(req, limite);
  let dado: unknown;
  try { dado = texto.trim() === "" ? {} : JSON.parse(texto); }
  catch { throw new HttpError(400, "JSON inválido"); }
  if (dado === null || typeof dado !== "object" || Array.isArray(dado)) throw new HttpError(400, "envie um objeto JSON");
  return dado as Record<string, unknown>;
}
