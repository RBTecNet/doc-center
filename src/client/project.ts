import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { comoSlug } from "../db/schema.js";
import { objeto } from "./remote.js";

const executar = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  try { return (await executar("git", ["-C", cwd, ...args], { timeout: 3000, maxBuffer: 64 * 1024 })).stdout.trim(); }
  catch { return ""; }
}

/** Nunca propagamos credenciais Git, parâmetros de URL ou caminhos de disco. */
export function repositorioPortatil(remote: string): string {
  let value = remote.trim();
  const scp = /^(?:[^@\s/:]+@)?(\[[^\]]+\]|[^/:@\s]+):(.+)$/.exec(value);
  if (scp && !value.includes("://") && !/^[A-Za-z]:[\\/]/.test(value)) value = `ssh://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return "";
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    const host = ["https:", "http:"].includes(url.protocol) ? url.host : url.hostname;
    return path && path !== "/" ? `https://${host.toLowerCase()}${path}` : "";
  } catch { return ""; }
}

export interface LocalProject {
  slug: string;
  nome: string;
  diretorio: string;
  repositorio: string;
}

export async function gitCheckpoint(directory: string): Promise<{ branch: string; commit: string; sujo: boolean } | null> {
  const [branch, commit, dirty] = await Promise.allSettled([
    git(directory, ["branch", "--show-current"]), git(directory, ["rev-parse", "HEAD"]),
    executar("git", ["-C", directory, "status", "--porcelain", "--untracked-files=normal"], { timeout: 3000, maxBuffer: 64 * 1024 }),
  ]);
  if (commit.status !== "fulfilled" || !/^[a-f0-9]{40,64}$/.test(commit.value)) return null;
  return { branch: branch.status === "fulfilled" ? branch.value : "", commit: commit.value,
    sujo: dirty.status !== "fulfilled" || dirty.value.stdout.trim() !== "" };
}

export async function resolveProject(options: { cwd?: string; project?: string } = {}): Promise<LocalProject> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const diretorio = await git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(join(diretorio, ".doc-center", "project.json"), "utf8"));
    if (!objeto(parsed)) throw new Error();
    config = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(".doc-center/project.json inválido");
  }
  const repositorio = repositorioPortatil(await git(diretorio, ["remote", "get-url", "origin"]));
  let name = repositorio ? new URL(repositorio).pathname.split("/").at(-1) ?? "" : basename(diretorio);
  try { name = decodeURIComponent(name); } catch { /* Remoto incomum: preserve o nome literal; slug pode ser explícito. */ }
  const slug = options.project ?? process.env.DOC_CENTER_PROJECT ?? (typeof config.projeto === "string" ? config.projeto : comoSlug(name));
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug) || comoSlug(slug) !== slug) throw new Error("DOC_CENTER_PROJECT deve ser um slug de até 60 caracteres (letras minúsculas, números e hífens)");
  return { slug, nome: typeof config.nome === "string" ? config.nome : name || slug, diretorio, repositorio };
}

/** Configuração compartilhável no Git; nenhuma credencial é gravada. */
export async function saveProject(project: LocalProject): Promise<string> {
  const arquivo = join(project.diretorio, ".doc-center", "project.json");
  await mkdir(join(project.diretorio, ".doc-center"), { recursive: true });
  for (const path of [join(project.diretorio, ".doc-center"), arquivo]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error("configuração do projeto não pode ser um link simbólico"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let previous: Record<string, unknown> = {};
  try { previous = JSON.parse(await readFile(arquivo, "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(".doc-center/project.json inválido"); }
  await writeFile(arquivo, JSON.stringify({ ...previous, versao: 1, projeto: project.slug, nome: project.nome }, null, 2) + "\n");
  return arquivo;
}
