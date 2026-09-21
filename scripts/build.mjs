import { chmod, readFile } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await build({
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  define: { __DOC_CENTER_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});
await build({
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  logLevel: "warning",
  entryPoints: ["src/web/app.ts"],
  outfile: "public/app.js",
});
await chmod("dist/cli.js", 0o755);
