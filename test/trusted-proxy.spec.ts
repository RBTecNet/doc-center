import { request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore } from "../src/auth.js";
import { Store } from "../src/db/store.js";
import { createApp, listen, type AppOptions } from "../src/http.js";

let store: Store;
let auth: AuthStore;
let server: Server | undefined;
let base: string;

beforeEach(() => {
  store = new Store({ file: ":memory:" });
  auth = new AuthStore(store);
  // O teste verifica a chave e a janela HTTP, sem repetir derivação de senhas.
  vi.spyOn(auth, "entrar").mockResolvedValue(null);
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  store.close();
  vi.restoreAllMocks();
});

async function abrir(trustedProxy?: AppOptions["trustedProxy"], enderecoRemoto = "127.0.0.1"): Promise<void> {
  server = createApp({ store, auth, ...(trustedProxy === undefined ? {} : { trustedProxy }) });
  // Permite exercitar peers IPv6 e não confiáveis sem depender da rede da máquina.
  server.on("connection", (socket) => Object.defineProperty(socket, "remoteAddress", { value: enderecoRemoto }));
  base = `http://127.0.0.1:${await listen(server, 0)}`;
}

async function tentativa(ip?: string): Promise<number> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", ...(ip === undefined ? {} : { "x-real-ip": ip }) }, body: "{}",
  });
  await response.body?.cancel();
  return response.status;
}

function tentativaDuplicada(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", "x-real-ip": ["198.51.100.1", "198.51.100.1"] },
    }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.on("error", reject);
    req.end("{}");
  });
}

describe("IP do cliente atrás de proxy local autorizado", () => {
  it("ignora X-Real-IP por padrão, mesmo vindo de loopback", async () => {
    await abrir();
    for (let indice = 0; indice < 20; indice++) expect(await tentativa(`198.51.100.${indice + 1}`)).toBe(401);
    expect(await tentativa("203.0.113.200")).toBe(429);
    expect(auth.entrar).toHaveBeenCalledTimes(20);
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("separa os limites de IPv4 e IPv6 via proxy %s quando a opção está ativa", async (peer) => {
    await abrir("loopback", peer);
    for (let indice = 0; indice < 20; indice++) expect(await tentativa("198.51.100.1")).toBe(401);
    expect(await tentativa("198.51.100.1")).toBe(429);
    for (let indice = 0; indice < 20; indice++) expect(await tentativa("2001:db8::2")).toBe(401);
    expect(await tentativa("2001:db8::2")).toBe(429);
    expect(auth.entrar).toHaveBeenCalledTimes(40);
  });

  it("não confia no cabeçalho de um peer fora de loopback", async () => {
    await abrir("loopback", "203.0.113.10");
    for (let indice = 0; indice < 20; indice++) expect(await tentativa(`198.51.100.${indice + 1}`)).toBe(401);
    expect(await tentativa("2001:db8::2")).toBe(429);
    expect(auth.entrar).toHaveBeenCalledTimes(20);
  });

  it("cabeçalhos ausentes, inválidos ou múltiplos não criam chaves alternativas", async () => {
    await abrir("loopback");
    const invalidos = [undefined, "", "não-é-ip", "198.51.100.1, 198.51.100.2", "198.51.100.1:80", "[2001:db8::2]"];
    for (let indice = 0; indice < 19; indice++) expect(await tentativa(invalidos[indice % invalidos.length])).toBe(401);
    expect(await tentativaDuplicada()).toBe(401);
    for (const ip of invalidos) expect(await tentativa(ip)).toBe(429);
    expect(await tentativaDuplicada()).toBe(429);
    expect(auth.entrar).toHaveBeenCalledTimes(20);
  });
});
