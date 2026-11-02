import type { Store } from "../src/db/store.js";

/** Integrações existentes também passam pela mesma autenticação da aplicação. */
export async function autenticarTeste(store: Store, base: string): Promise<{
  store: Store; usuarioId: number; cookie: string; headers: Record<string, string>; mcpHeaders: Record<string, string>;
}> {
  const registro = await fetch(`${base}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nome: "Pessoa de teste", email: "teste@example.com", senha: "senha-segura-de-teste" }),
  });
  if (registro.status !== 201) throw new Error(`falhou autenticação da fixture: ${await registro.text()}`);
  const { usuario } = await registro.json() as { usuario: { id: number } };
  const cookie = registro.headers.get("set-cookie")!.split(";")[0]!;
  const resposta = await fetch(`${base}/api/tokens`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ nome: "Teste MCP" }),
  });
  if (resposta.status !== 201) throw new Error(`falhou token da fixture: ${await resposta.text()}`);
  const { token } = await resposta.json() as { token: string };
  return { store: store.forUser(usuario.id), usuarioId: usuario.id, cookie, headers: { cookie }, mcpHeaders: { authorization: `Bearer ${token}` } };
}
