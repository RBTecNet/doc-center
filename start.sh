#!/usr/bin/env bash
# O webserver publica o site e encaminha para 127.0.0.1:7778.
# O listener na porta 7777 atende somente o endpoint /mcp.
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
node_bin="${DOC_CENTER_NODE:-node}"

if ! command -v "$node_bin" >/dev/null 2>&1; then
  printf '%s\n' 'doc-center: instale Node 22.13.0 ou superior, ou defina DOC_CENTER_NODE.' >&2
  exit 1
fi

"$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("doc-center: requer Node 22.13.0 ou superior."); process.exit(1); }'

if [[ ! -f "$app_dir/dist/cli.js" || ! -f "$app_dir/public/app.js" ]]; then
  printf '%s\n' 'doc-center: build ausente; execute npm run build antes de iniciar.' >&2
  exit 1
fi

cd -- "$app_dir"
# Os argumentos explícitos vêm primeiro para poder substituir os padrões.
# exec preserva SIGTERM/SIGINT e permite supervisão por systemd ou outro serviço.
exec "$node_bin" "$app_dir/dist/cli.js" "$@" \
  --host "${HOST:-127.0.0.1}" \
  --web-port "${DOC_CENTER_WEB_PORT:-${PORT:-7778}}" \
  --mcp-port "${DOC_CENTER_MCP_PORT:-7777}" \
  --db "${DOC_CENTER_DB:-$app_dir/doc-center.db}"
