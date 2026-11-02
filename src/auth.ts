/** Contas, sessões e credenciais das CLIs. Segredos nunca são gravados em claro. */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { ErroDeUso, type Store } from "./db/store.js";

export interface Usuario { id: number; nome: string; email: string }
export interface Credencial {
  id: number;
  nome: string;
  prefixo: string;
  projeto: string | null;
  permissao: "leitura" | "workflow";
  criadoEm: string;
  expiraEm: string;
  ultimoUsoEm: string | null;
}
export interface Identidade { usuario: Usuario; credencial?: Credencial }
interface LinhaUsuario extends Usuario { senha_hash: string }
interface LinhaToken {
  id: number; nome: string; prefixo: string; projeto: string | null;
  permissao: "leitura" | "workflow"; criado_em: string; expira_em: string; ultimo_uso_em: string | null;
}

const DIA = 86_400_000;
export const DURACAO_SESSAO = 7 * DIA;
const digest = (segredo: string): string => createHash("sha256").update(segredo).digest("hex");
const publico = (linha: Usuario): Usuario => ({ id: linha.id, nome: linha.nome, email: linha.email });
const credencial = (linha: LinhaToken): Credencial => ({
  id: linha.id, nome: linha.nome, prefixo: linha.prefixo, projeto: linha.projeto,
  permissao: linha.permissao, criadoEm: linha.criado_em, expiraEm: linha.expira_em, ultimoUsoEm: linha.ultimo_uso_em,
});

function derivar(senha: string, sal: string): Promise<Buffer> {
  // Uma das combinações recomendadas pelo OWASP; 32 MiB, três passagens.
  return new Promise((resolve, reject) => {
    scrypt(senha, sal, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (erro, chave) => {
      if (erro) reject(erro); else resolve(chave);
    });
  });
}

function validarSenha(senha: string): void {
  if (senha.length < 12 || Buffer.byteLength(senha) > 1024) throw new ErroDeUso("a senha precisa ter ao menos 12 caracteres e no máximo 1024 bytes");
}

export class AuthStore {
  constructor(private readonly store: Store, private readonly agora: () => number = Date.now) {
    store.banco.exec(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE, senha_hash TEXT NOT NULL, criado_em TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessoes (
        hash TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        expira_em TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessoes_expiracao ON sessoes(expira_em);
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        nome TEXT NOT NULL, prefixo TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
        projeto_id INTEGER REFERENCES projetos(id) ON DELETE CASCADE,
        permissao TEXT NOT NULL CHECK(permissao IN ('leitura', 'workflow')),
        criado_em TEXT NOT NULL, expira_em TEXT NOT NULL, ultimo_uso_em TEXT
      );
      CREATE INDEX IF NOT EXISTS tokens_usuario ON tokens(usuario_id);
    `);
  }

  temUsuarios(): boolean {
    return !!this.store.banco.prepare("SELECT 1 FROM usuarios LIMIT 1").get();
  }

  async registrar(entrada: { nome: string; email: string; senha: string }, aberto = true): Promise<Usuario> {
    const nome = entrada.nome.trim();
    const email = entrada.email.trim().toLowerCase();
    if (!nome || nome.length > 120) throw new ErroDeUso("informe um nome de até 120 caracteres");
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroDeUso("informe um email válido");
    validarSenha(entrada.senha);
    if (!aberto && this.temUsuarios()) throw new ErroDeUso("o cadastro de novas contas está fechado");
    const sal = randomBytes(16).toString("hex");
    const hash = `scrypt:${sal}:${(await derivar(entrada.senha, sal)).toString("hex")}`;
    const db = this.store.banco;
    // Revalida depois da derivação assíncrona para que dois cadastros não tomem
    // simultaneamente a base local nem contornem o cadastro fechado.
    db.exec("BEGIN IMMEDIATE");
    try {
      const primeiro = !this.temUsuarios();
      if (!aberto && !primeiro) throw new ErroDeUso("o cadastro de novas contas está fechado");
      if (db.prepare("SELECT 1 FROM usuarios WHERE email = ?").get(email)) throw new ErroDeUso("não foi possível cadastrar este email");
      const resultado = db.prepare("INSERT INTO usuarios (nome, email, senha_hash, criado_em) VALUES (?, ?, ?, ?)")
        .run(nome, email, hash, new Date(this.agora()).toISOString());
      const usuario = { id: Number(resultado.lastInsertRowid), nome, email };
      if (primeiro) this.store.adotarLegado(usuario.id);
      db.exec("COMMIT");
      return usuario;
    } catch (erro) {
      db.exec("ROLLBACK");
      throw erro;
    }
  }

  async entrar(email: string, senha: string): Promise<Usuario | null> {
    if (Buffer.byteLength(senha) > 1024) return null;
    const linha = this.store.banco.prepare("SELECT * FROM usuarios WHERE email = ?")
      .get(email.trim().toLowerCase()) as unknown as LinhaUsuario | undefined;
    const partes = linha?.senha_hash.split(":");
    const chave = await derivar(senha, partes?.[1] ?? "00000000000000000000000000000000");
    const esperado = Buffer.from(partes?.[2] ?? "00".repeat(64), "hex");
    const confere = esperado.length === chave.length && timingSafeEqual(esperado, chave);
    return linha && confere ? publico(linha) : null;
  }

  criarSessao(usuarioId: number): string {
    const segredo = `dcs_${randomBytes(32).toString("base64url")}`;
    const db = this.store.banco;
    db.prepare("DELETE FROM sessoes WHERE expira_em <= ?").run(new Date(this.agora()).toISOString());
    db.prepare("INSERT INTO sessoes (hash, usuario_id, expira_em) VALUES (?, ?, ?)")
      .run(digest(segredo), usuarioId, new Date(this.agora() + DURACAO_SESSAO).toISOString());
    return segredo;
  }

  usuarioDaSessao(segredo: string): Usuario | null {
    if (!/^dcs_[A-Za-z0-9_-]{43}$/.test(segredo)) return null;
    const linha = this.store.banco.prepare(`SELECT u.id, u.nome, u.email FROM usuarios u
      JOIN sessoes s ON s.usuario_id = u.id WHERE s.hash = ? AND s.expira_em > ?`)
      .get(digest(segredo), new Date(this.agora()).toISOString()) as unknown as Usuario | undefined;
    return linha ? publico(linha) : null;
  }

  encerrarSessao(segredo: string): void {
    this.store.banco.prepare("DELETE FROM sessoes WHERE hash = ?").run(digest(segredo));
  }

  listarTokens(usuarioId: number): Credencial[] {
    return (this.store.banco.prepare(`SELECT t.*, p.slug AS projeto FROM tokens t
      LEFT JOIN projetos p ON p.id = t.projeto_id WHERE t.usuario_id = ? ORDER BY t.id DESC`)
      .all(usuarioId) as unknown as LinhaToken[]).map(credencial);
  }

  criarToken(usuarioId: number, entrada: { nome: string; projeto?: string; permissao?: string; dias?: number }): { token: string; credencial: Credencial } {
    const nome = entrada.nome.trim();
    if (!nome || nome.length > 120) throw new ErroDeUso("informe um nome de até 120 caracteres para a conexão");
    const permissao = entrada.permissao ?? "workflow";
    if (permissao !== "leitura" && permissao !== "workflow") throw new ErroDeUso("a permissão deve ser leitura ou workflow");
    const dias = entrada.dias ?? 90;
    if (!Number.isInteger(dias) || dias < 1 || dias > 365) throw new ErroDeUso("a validade deve ser de 1 a 365 dias");
    const projeto = entrada.projeto ? this.store.forUser(usuarioId).projetoPorSlug(entrada.projeto) : null;
    if (entrada.projeto && !projeto) throw new ErroDeUso("projeto não encontrado");
    const token = `dct_${randomBytes(32).toString("base64url")}`;
    const criadoEm = new Date(this.agora()).toISOString();
    const expiraEm = new Date(this.agora() + dias * DIA).toISOString();
    const resultado = this.store.banco.prepare(`INSERT INTO tokens
      (usuario_id, nome, prefixo, hash, projeto_id, permissao, criado_em, expira_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(usuarioId, nome, token.slice(0, 12), digest(token), projeto?.id ?? null, permissao, criadoEm, expiraEm);
    return { token, credencial: {
      id: Number(resultado.lastInsertRowid), nome, prefixo: token.slice(0, 12), projeto: projeto?.slug ?? null,
      permissao, criadoEm, expiraEm, ultimoUsoEm: null,
    } };
  }

  identidadeDoToken(segredo: string): Identidade | null {
    if (!/^dct_[A-Za-z0-9_-]{43}$/.test(segredo)) return null;
    const instante = new Date(this.agora()).toISOString();
    const linha = this.store.banco.prepare(`SELECT t.*, p.slug AS projeto,
      u.id AS uid, u.nome AS unome, u.email AS uemail FROM tokens t
      JOIN usuarios u ON u.id = t.usuario_id LEFT JOIN projetos p ON p.id = t.projeto_id
      WHERE t.hash = ? AND t.expira_em > ? AND (t.projeto_id IS NULL OR p.usuario_id = t.usuario_id)`)
      .get(digest(segredo), instante) as unknown as (LinhaToken & { uid: number; unome: string; uemail: string }) | undefined;
    if (!linha) return null;
    this.store.banco.prepare("UPDATE tokens SET ultimo_uso_em = ? WHERE id = ?").run(instante, linha.id);
    return { usuario: { id: linha.uid, nome: linha.unome, email: linha.uemail }, credencial: credencial(linha) };
  }

  revogarToken(usuarioId: number, tokenId: number): boolean {
    return this.store.banco.prepare("DELETE FROM tokens WHERE usuario_id = ? AND id = ?").run(usuarioId, tokenId).changes > 0;
  }
}
