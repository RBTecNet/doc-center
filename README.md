# doc-center

Base documental para workflows com agentes: projetos, skills, memórias,
documentação, hooks e prompts, com contas de usuário e acesso por **MCP**.
Cada usuário tem seus projetos e sua própria área geral. Duas contas podem
usar o mesmo slug de projeto sem compartilhar documentos ou seleções.

Um cliente MCP consulta os recursos de um projeto e acessa seu pedido e os
documentos associados a ele. O restante do acervo não é incluído automaticamente.
A autenticação identifica o usuário; o escopo do token define quais projetos
o workflow pode acessar.

## Rodar e criar a primeira conta

Requer Node 22.13.0 ou superior com `node:sqlite` disponível.

```bash
npm install
npm run check
npm start
```

O site usa a porta **80** (`http://127.0.0.1/`) e o MCP usa a porta
**7777** (`http://127.0.0.1:7777/mcp`). São dois listeners no mesmo processo,
com a mesma base de contas e projetos. Abra o site, crie sua conta e entre.
A primeira conta assume os projetos e documentos de um banco local
existente, preservando IDs,
seleções e arquivos. As contas seguintes começam com um acervo vazio.
Faça backup do banco antes da atualização e o primeiro cadastro localmente
antes de disponibilizar uma base antiga na rede, pois ele estabelece o dono
dos dados existentes. A migração é feita automaticamente ao abrir o banco.

Se o sistema recusar a porta 80 com `EACCES`, use uma porta de
desenvolvimento enquanto configura o serviço ou proxy:

```bash
npm start -- --web-port 8080 --mcp-port 7777
```

Nesse caso o site abre em `http://127.0.0.1:8080/` e o MCP permanece em
`http://127.0.0.1:7777/mcp`. Em Linux, portas abaixo de
`ip_unprivileged_port_start` exigem a capacidade `CAP_NET_BIND_SERVICE`;
o padrão é 1024, conforme a
[documentação do kernel](https://www.kernel.org/doc/html/latest/networking/ip-sysctl.html#ip-variables).
`EACCES` indica falta de permissão; `EADDRINUSE` indica uma porta já
ocupada, conforme a [referência de erros do Node](https://nodejs.org/api/errors.html).

Na página **Minha conta**, gere um token para cada CLI ou workflow. Escolha
um projeto específico ou todos os seus projetos, a validade e a permissão:

| Permissão | Acesso |
| --- | --- |
| `leitura` | Documentos aprovados, histórico e contexto; ferramentas de escrita ficam ocultas e suas chamadas são recusadas. |
| `workflow` | Leitura e registro de projetos, prompts, respostas, memórias e levantamentos, dentro do escopo autorizado. |

Um token de projeto acessa apenas aquele projeto e os documentos gerais
que ele selecionou. O token completo aparece uma vez na criação; a lista
mostra prefixo, escopo, validade e último uso. Revogação bloqueia novos
pedidos imediatamente. Tokens expiram em 90 dias por padrão, com validade
configurável de 1 a 365 dias, e só seu hash fica no banco.
Memórias criadas por agentes entram como rascunho e precisam de aprovação
na interface antes de serem expostas por MCP.

## Configuração do servidor

| Argumento | Ambiente | Padrão |
| --- | --- | --- |
| `--web-port` | `DOC_CENTER_WEB_PORT`, com fallback para `PORT` | `80` |
| `--mcp-port` | `DOC_CENTER_MCP_PORT` | `7777` |
| `--port` | Alias legado de `--web-port` | `80` |
| `--host` | `HOST` | `127.0.0.1` |
| `--db` | `DOC_CENTER_DB` | `doc-center.db` |
| `--public-url` | `DOC_CENTER_PUBLIC_URL` | Origem da requisição local |
| `--mcp-public-url` | `DOC_CENTER_MCP_PUBLIC_URL` | URL do listener MCP com `/mcp` |
| `--trust-proxy` | `DOC_CENTER_TRUST_PROXY` | Desligado; aceita `loopback` |
| `--registration` | `DOC_CENTER_REGISTRATION` | `open` |
| `--runs` | `DOC_CENTER_RUNS` | Desligado |

`--host` é compartilhado pelos dois listeners. `PORT` e `--port` alteram
somente o site; a porta MCP é configurada separadamente. As portas precisam
ser distintas. O valor `0` solicita uma porta livre ao sistema e pode ser
usado nos dois listeners em testes.

O listener web serve login, conta, API, arquivos estáticos e runs; `/mcp`
nele retorna 404. O listener MCP serve somente `/mcp`; `/`, `/login`, API
e arquivos estáticos nele retornam 404. A interface mostra o endpoint do
listener MCP na configuração da conta.

`registration=closed` bloqueia novos cadastros depois da primeira conta.
O primeiro cadastro continua disponível para inicializar a instalação.
Senhas precisam de pelo menos 12 caracteres e são derivadas com scrypt
por meio de `node:crypto`. Login e a interface usam sessão de sete dias
em cookie HttpOnly; o MCP exige token Bearer, inclusive localmente.

Para acesso remoto, publique os dois listeners por um proxy com HTTPS e
configure a origem pública do site e o endpoint público do MCP, por exemplo:

```bash
DOC_CENTER_PUBLIC_URL=https://docs.example.com \
DOC_CENTER_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
DOC_CENTER_REGISTRATION=closed \
npm start -- --host 127.0.0.1 --web-port 8080 --mcp-port 7777
```

O proxy encaminha o site para `127.0.0.1:8080` e o endpoint MCP para
`127.0.0.1:7777/mcp`. A origem pública do site permite validar pedidos
do navegador e habilita cookies Secure em HTTPS. `--mcp-public-url`
informa o endereço exibido na conta e permite a origem pública própria
do MCP quando um cliente envia `Origin`. Use a URL completa com `/mcp`.

Se o proxy roda na mesma máquina, `--trust-proxy loopback` permite usar
`X-Real-IP` para os limites de autenticação. O proxy precisa sobrescrever
esse cabeçalho com o IP do cliente. A confiança vale somente para conexões
vindas de loopback; por padrão, o cabeçalho é ignorado.

Para manter o site diretamente na porta 80 em Linux, um administrador
pode instalar um serviço systemd com usuário dedicado e a capacidade
de bind restrita a esse serviço. Exemplo de unidade, ajustando os
caminhos e provisionando o usuário `doc-center`:

```ini
[Unit]
Description=doc-center
After=network.target

[Service]
Type=simple
User=doc-center
WorkingDirectory=/opt/doc-center
ExecStart=/usr/bin/node /opt/doc-center/dist/cli.js --host 127.0.0.1 --web-port 80 --mcp-port 7777 --db /var/lib/doc-center/doc-center.db
StateDirectory=doc-center
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

O processo Node roda como `doc-center`; `AmbientCapabilities` permite
abrir a porta 80 e `CapabilityBoundingSet` limita as capacidades do
serviço, conforme a
[referência oficial de execução do systemd](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).
Outra opção é deixar o processo em `--web-port 8080` e publicar o site
pela porta 80 do proxy, mantendo o listener MCP em 7777.

O visor de runs usa uma pasta separada por usuário. Ao habilitar `--runs`
ou `DOC_CENTER_RUNS`, provisione os arquivos nesta estrutura:

```text
<runsRoot>/<id-do-usuario>/<slug-do-projeto>/.capivara/runs/
```

O servidor mostra apenas os projetos da conta dentro de seu diretório.
Arquivos de uma instalação antiga não são movidos automaticamente; uma
pasta compartilhada sem esse namespace não é exposta aos usuários.

## Iniciar atrás de um webserver

O script `start.sh` inicia a aplicação em primeiro plano, usando o banco
`doc-center.db` da própria pasta mesmo quando chamado de outro diretório:

```bash
cd ~/webserver/doc-center.rbtecnologia.net.br
./start.sh
```

Por padrão, o script usa `127.0.0.1:7778` para a interface web e
`127.0.0.1:7777/mcp` para o MCP. A porta pública **80** fica com o
webserver, que deve encaminhar o site para **127.0.0.1:7778**. O listener
7777 atende somente `/mcp`; apontar todo o site para ele retorna 404.
O script requer o build já pronto, sem instalar dependências em execução.

Configure as URLs públicas conforme o proxy, para validar Host/Origin e
mostrar o endereço correto do MCP na conta. Exemplo quando o proxy publica
HTTPS no site e na porta 7777 do MCP:

```bash
DOC_CENTER_PUBLIC_URL=https://doc-center.rbtecnologia.net.br \
DOC_CENTER_MCP_PUBLIC_URL=https://doc-center.rbtecnologia.net.br:7777/mcp \
DOC_CENTER_TRUST_PROXY=loopback \
./start.sh
```

Para um site publicado apenas por HTTP na porta 80, use `http://` na URL
pública do site. As CLIs exigem HTTPS para o endpoint MCP remoto. Se o proxy
publicar o MCP em outra URL, ajuste `DOC_CENTER_MCP_PUBLIC_URL` para ela.
O TLS é configurado no proxy; os listeners da aplicação servem HTTP.

As variáveis `DOC_CENTER_WEB_PORT`, `DOC_CENTER_MCP_PORT`, `HOST` e
`DOC_CENTER_DB` também ajustam o script; `DOC_CENTER_NODE` seleciona o
executável Node. Argumentos explícitos, por exemplo `./start.sh
--web-port 7780`, substituem os padrões. O processo recebe SIGTERM/SIGINT
diretamente e pode ser supervisionado pelo serviço escolhido no webserver.

## Conectar qualquer cliente MCP por stdio

`doc-center connect` é uma ponte: o cliente inicia um processo local que
encaminha as mensagens ao servidor autenticado. O processo não abre o
banco nem cria um segundo servidor.

Use o comando `node /caminho/absoluto/doc-center/dist/cli.js connect` nos
exemplos abaixo. Se o executável já estiver no seu `PATH`, use
`doc-center connect`.

Antes de iniciar sua CLI, prepare as variáveis no terminal. O `read -s`
evita guardar o token no histórico do shell:

```bash
export DOC_CENTER_URL='http://127.0.0.1:7777/mcp'
read -rsp 'Token do doc-center: ' DOC_CENTER_TOKEN
echo
export DOC_CENTER_TOKEN
```

`DOC_CENTER_TOKEN` é obrigatório. `DOC_CENTER_URL` aceita a origem ou a
URL completa de `/mcp`; o padrão é `http://127.0.0.1:7777/mcp`. A ponte
aceita HTTP para loopback e exige HTTPS para servidores remotos. Ela
recusa redirecionamentos e credenciais na URL.

As mensagens são JSON-RPC UTF-8, uma por linha. `stdout` contém somente
mensagens do protocolo, e notificações com resposta HTTP 202 não geram
saída. A ponte limita entrada e resposta a 8 MiB por mensagem e espera
até 30 segundos por pedido. Esse enquadramento segue a
[especificação MCP de transportes](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

### Codex

Em `~/.codex/config.toml`, encaminhe as variáveis sem gravar o segredo no
arquivo:

```toml
[mcp_servers.doc_center]
command = "node"
args = ["/caminho/absoluto/doc-center/dist/cli.js", "connect"]
env_vars = ["DOC_CENTER_URL", "DOC_CENTER_TOKEN"]
```

Inicie `codex` no terminal em que definiu as variáveis e verifique com
`codex mcp list` ou `/mcp`. A configuração de stdio e o encaminhamento
de ambiente estão na [documentação oficial OpenAI de MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

Em `.mcp.json` no projeto:

```json
{
  "mcpServers": {
    "doc_center": {
      "type": "stdio",
      "command": "node",
      "args": ["/caminho/absoluto/doc-center/dist/cli.js", "connect"],
      "env": {
        "DOC_CENTER_URL": "${DOC_CENTER_URL:-http://127.0.0.1:7777/mcp}",
        "DOC_CENTER_TOKEN": "${DOC_CENTER_TOKEN}"
      }
    }
  }
}
```

Inicie `claude` no mesmo terminal, aprove o servidor do projeto e confira
`/mcp`. A [documentação do Claude Code](https://code.claude.com/docs/en/mcp)
descreve stdio, `.mcp.json` e a expansão `${VAR}`.

### OpenCode

Em `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "doc_center": {
      "type": "local",
      "command": ["node", "/caminho/absoluto/doc-center/dist/cli.js", "connect"],
      "enabled": true,
      "environment": {
        "DOC_CENTER_TOKEN": "{env:DOC_CENTER_TOKEN}"
      }
    }
  }
}
```

Confira `opencode mcp list`. Os formatos local, remoto e as variáveis de
ambiente seguem a [documentação do OpenCode](https://opencode.ai/docs/mcp-servers/).
`DOC_CENTER_URL` é herdada do terminal; omitir um override no arquivo
mantém o endereço local padrão quando a variável não está definida.
Versões que usam outra estrutura de configuração devem seguir o esquema
da versão instalada.

### AGY e outros clientes

Qualquer cliente que suporte servidores MCP stdio pode iniciar `node`
com os argumentos `[/caminho/absoluto/doc-center/dist/cli.js, connect]`
e passar `DOC_CENTER_URL` e `DOC_CENTER_TOKEN` no ambiente do processo.
O nome “AGY” não determina um formato de configuração; use a sintaxe MCP
do cliente e da versão instalada.

### Ler documentação em clientes que expõem ferramentas

O acesso ao conteúdo também funciona por ferramentas MCP. Chame
`listar_material` com `{"projeto":"biblioteca"}` para receber o pedido
e as URIs dos documentos e arquivos selecionados. Depois chame
`ler_documento` com, por exemplo,
`{"uri":"capivara://biblioteca/docs/skill/frontend"}` para ler seu
conteúdo. Arquivos do pacote usam a mesma URI com o caminho acrescentado,
como `capivara://biblioteca/docs/skill/frontend/references/guia.md`.

`ler_documento` compartilha as verificações de `resources/read`: a conta,
o projeto vinculado ao token, as seleções e a aprovação dos documentos.
Ele aceita somente recursos cadastrados na base, e funciona com token
`leitura`. Texto é devolvido como conteúdo da ferramenta; arquivos binários
são recursos incorporados com dados em base64, conforme a
[especificação MCP de resultados de ferramentas](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result).

A [documentação do OpenCode](https://opencode.ai/docs/mcp-servers/) garante
que ferramentas MCP ficam disponíveis ao modelo, mas não esclarece nesse
guia o uso de `resources/read`. As ferramentas de leitura permitem usar
a base sem depender dessa capacidade do cliente.

## Capturar histórico e continuar em outra CLI ou máquina

MCP disponibiliza ferramentas e documentos quando o agente os consulta.
Para registrar cada prompt enviado e as respostas finais automaticamente,
instale também a integração local de hooks ou plugin. Use um token
`workflow` da sua conta, exportado no terminal conforme o exemplo anterior.

No diretório do projeto, execute uma vez para a CLI desejada:

```bash
doc-center setup --client codex --project biblioteca
# Ou: doc-center setup --client claude --project biblioteca
# Ou: doc-center setup --client opencode --project biblioteca
```

Sem executável no `PATH`, substitua `doc-center` por
`node /caminho/absoluto/doc-center/dist/cli.js`. `--cwd /pasta/do/projeto`
seleciona outro diretório e `--url https://mcp.example.com/mcp` seleciona
o servidor. O setup mantém os outros servidores MCP, hooks e plugins.
Ele grava a identidade em `.doc-center/project.json`, sem token. O projeto
é aberto ou criado na conta autenticada quando a integração sincroniza.
Se dois repositórios diferentes tiverem o mesmo nome, escolha slugs
distintos com `--project` para evitar colisões de identidade.

| Cliente | Arquivos do projeto | Ativação |
| --- | --- | --- |
| Codex | `.codex/config.toml`, `.codex/hooks.json` | Abra o projeto confiável, mantenha hooks habilitados e revise/autorize com `/hooks`. |
| Claude Code | `.mcp.json`, `.claude/settings.json` | Abra o projeto e aprove o MCP e os hooks conforme as permissões da CLI. |
| OpenCode | `opencode.json` ou o `opencode.jsonc` existente, `.opencode/plugins/doc-center.js` | Reinicie a CLI; o plugin local é descoberto automaticamente. |

Codex e Claude Code usam `SessionStart`, `UserPromptSubmit` e `Stop`.
Ao iniciar ou retomar a sessão, o hook entrega contexto do projeto; ao
enviar um prompt ou concluir uma resposta, registra o evento no histórico.
Os formatos e a autorização dos hooks seguem as referências oficiais
de [Codex](https://learn.chatgpt.com/docs/hooks) e
[Claude Code](https://code.claude.com/docs/en/hooks).
Respostas finais vêm de `last_assistant_message`; o doc-center não depende
de varrer diretórios de transcrições. Versões antigas que não oferecem
esse campo podem registrar prompts sem capturar a resposta final.

No OpenCode, o plugin usa `chat.message` e eventos de resposta concluída
ou sessão ociosa. Ele consulta somente a sessão observada no diretório
do projeto e envia partes textuais de prompts e respostas, sem pensamento
interno, anexos ou resultados de ferramentas. IDs nativos tornam novas
entregas do mesmo evento idempotentes. O contexto de cada sessão é
injetado por `experimental.chat.system.transform` quando disponível;
essa interface é experimental. A estrutura está documentada em
[plugins locais](https://opencode.ai/docs/plugins/) e nas
[interfaces oficiais do SDK de plugins](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts).

Antes de enviar uma mensagem ao servidor, o hook a grava na outbox local
do projeto. Uma falha de conexão deixa o registro pendente e gera um aviso.
Para tentar novamente:

```bash
doc-center sync --project biblioteca
```

Use a credencial original para sincronizar pendências: registros locais
de outra credencial não são enviados automaticamente para a conta atual.
A outbox contém o texto das conversas e fica em `.doc-center/local`,
automaticamente ignorada pelo Git, com pasta privada e arquivos de acesso
restrito. `.doc-center/project.json` e as configurações da integração podem
ser compartilhados; rode setup em cada máquina para ajustar o caminho da
CLI local. Credenciais permanecem no ambiente.

Na outra máquina, obtenha o repositório pelo Git, exporte seu token,
instale a integração da CLI escolhida e use o mesmo slug. Para consultar
ou salvar explicitamente o contexto portátil:

```bash
doc-center resume --project biblioteca
doc-center resume --project biblioteca --output contexto.md
# Para integração própria: acrescente --format json
```

O contexto reúne o pedido, os documentos aprovados selecionados e o
histórico recente, com identificação do repositório. Os hooks registram
também a referência de branch/commit e indicam mudanças locais pendentes.
Mensagens mais antigas
continuam consultáveis por `listar_historico` e pelas URIs retornadas.
Use o Markdown como contexto inicial em qualquer agente. O doc-center
compartilha contexto entre modelos; o código chega à outra máquina após
commit e push no Git, seguido de clone ou pull. Arquivos locais pendentes
continuam apenas na máquina de origem. Sessões internas de uma CLI não são importadas
como sessões nativas de outra.

Para AGY ou outro cliente com hooks próprios, chame
`doc-center hook --client generic --project biblioteca` com JSON no stdin.
Um evento de prompt usa este contrato:

```json
{
  "cwd": "/pasta/do/projeto",
  "session_id": "conversa-123",
  "event_id": "prompt-456",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Implemente a próxima etapa",
  "model": "provedor/modelo",
  "timestamp": "2026-10-10T12:00:00Z"
}
```

Use `SessionStart` para obter `hookSpecificOutput.additionalContext` e
`Stop` com `content` ou `last_assistant_message` para registrar a resposta
final. Preserve um `event_id` estável nas tentativas de entrega e distinto
para cada mensagem, incluindo prompts repetidos. O comando responde JSON;
avisos saem em stderr. A configuração de hooks de AGY depende do produto
e da versão; o contrato genérico não pressupõe um formato nativo.

## Conexão HTTP direta e recursos MCP por projeto

Clientes com Streamable HTTP podem chamar `/mcp` diretamente. Cada POST
deve enviar um envelope JSON-RPC e os cabeçalhos:

```text
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-06-18
```

O servidor responde JSON; notificações aceitas recebem HTTP 202 sem corpo.
GET retorna 405, pois não há fluxo de eventos. A autenticação é por token
da conta, sem descoberta OAuth. Se seu cliente usa HTTP, configure nele
o cabeçalho `Authorization`; apenas informar a URL e o projeto não
autentica o workflow.

No Codex, a alternativa HTTP ao bloco stdio é:

```toml
[mcp_servers.doc_center]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "DOC_CENTER_TOKEN"
```

O [Codex documenta `bearer_token_env_var`](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Para Claude Code, configure `type: "http"`, `url` e
`headers.Authorization: "Bearer ${DOC_CENTER_TOKEN}"` em `.mcp.json`,
conforme a [referência de cabeçalhos e variáveis](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).
No OpenCode, use `type: "remote"`, `url`, `oauth: false` e
`headers.Authorization: "Bearer {env:DOC_CENTER_TOKEN}"`, conforme a
[referência de tokens sem OAuth](https://opencode.ai/docs/mcp-servers/#disabling-oauth).

As URIs dos recursos são resolvidas dentro da conta autenticada. Sob um projeto
aparece o que ele usa: documentos próprios e os gerais selecionados.
Ler um documento geral não selecionado sob o projeto é recusado.
Rascunhos e seus arquivos não são expostos por recursos, prompts ou
`listar_material`.

## Zero dependências de runtime

O banco é `node:sqlite`, o servidor é `node:http`, as senhas usam
`node:crypto` e o MCP é JSON-RPC. `esbuild`, `typescript` e `vitest`
são dependências de desenvolvimento.
