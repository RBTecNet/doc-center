# Capivara com o doc-center autenticado

O Capivara usa o MCP como cliente HTTP. A conexão aceita uma URL HTTP ou
HTTPS e um token da conta que possui o projeto. O login do navegador usa
cookie; esse cookie não autentica o harness.

## MCP HTTP na porta 7777

No configurador do Capivara, use `http://doc-center.rbtecnologia.net.br/mcp`
e porta `7777`. O endpoint final será
`http://doc-center.rbtecnologia.net.br:7777/mcp`.
Inclua `http://` no endereço para escolher o protocolo sem TLS.

O serviço do doc-center precisa anunciar o mesmo endpoint:

```ini
[Service]
Environment="DOC_CENTER_MCP_PUBLIC_URL=http://doc-center.rbtecnologia.net.br:7777/mcp"
```

A porta deve estar publicada e acessível a partir da máquina que roda o
harness. Um listener em `127.0.0.1` atende a um proxy local; acesso direto
de outra máquina requer publicar essa porta na configuração do servidor.
O endereço do site pode continuar usando HTTPS, independentemente do MCP.
Em HTTP, o token trafega sem criptografia.

## Publicar o endpoint por HTTPS no proxy

No servidor atual, a interface usa `127.0.0.1:7778` e o MCP usa
`127.0.0.1:7777/mcp`. O domínio HTTPS pode publicar ambos, encaminhando
**somente `/mcp`** ao listener MCP. No bloco Nginx do domínio, além do
`location /` que já encaminha o site para 7778, use:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:7777;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 60s;
    client_max_body_size 8m;
}
```

No serviço da aplicação, configure:

```ini
[Service]
Environment="DOC_CENTER_PUBLIC_URL=https://doc-center.rbtecnologia.net.br"
Environment="DOC_CENTER_MCP_PUBLIC_URL=https://doc-center.rbtecnologia.net.br/mcp"
Environment="DOC_CENTER_TRUST_PROXY=loopback"
```

Após carregar a configuração do proxy e reiniciar o serviço, um pedido sem
token a `https://doc-center.rbtecnologia.net.br/mcp` deve retornar **401**.
Uma resposta **404** indica que a requisição ainda está indo para a interface;
**403** com erro de Host/Origin indica que a URL pública do MCP não coincide
com o endereço publicado.

## Autorizar o harness

Na interface, entre em **Minha conta**, crie um token e escolha seu escopo:

- `leitura`: consultar pedido, prompts e documentos aprovados;
- `workflow`: também registrar levantamentos e memórias;
- um projeto: restringe o token ao slug escolhido;
- todos os projetos: permite levantar uma aplicação e criar o projeto dela.

Execute `capivara config` e escolha **Adicionar MCP**, ou use o atalho:

```bash
capivara config add mcp
```

Preencha os três campos:

- endereço: `http://doc-center.rbtecnologia.net.br/mcp`;
- porta: `7777`;
- token: a credencial criada em **Minha conta**. A digitação fica oculta no terminal.

A conexão fica salva em `~/.capybara/config.json` e passa a ser a padrão.
O diretório usa permissão `0700` e o arquivo `0600`. O menu permite listar
conexões, escolher a padrão e remover uma conexão, sem mostrar os tokens.
Ela estará disponível para todos os projetos nas próximas execuções,
inclusive após reiniciar o computador.

Se usar a rota HTTPS do proxy descrita acima, informe
`https://doc-center.rbtecnologia.net.br/mcp`, porta `443`, no configurador.
Quando o harness roda no próprio servidor, pode configurar
`http://127.0.0.1/mcp`, porta `7777`, em vez do domínio público.

Agora execute:

```bash
capivara init --project /caminho/do/projeto \
  --mcp-project slug-do-projeto --provider codex
```

Selecione os modelos e papéis exigidos pelo comando conforme sua configuração.
O token é lido da configuração e enviado em `Authorization: Bearer`.
Os arquivos de cada projeto registram a URL e o slug, sem guardar o segredo.
O escopo do token e `--mcp-project` precisam corresponder à conta e ao projeto.

As variáveis `CAPIVARA_MCP_URL`/`CAPIVARA_MCP_TOKEN` e
`DOC_CENTER_URL`/`DOC_CENTER_TOKEN` continuam disponíveis para automações e
substituem a configuração salva. A flag `--mcp` tem precedência sobre a URL
do ambiente. Um token salvo só acompanha a URL da conexão correspondente.
