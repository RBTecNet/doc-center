# doc-center

A base documental do capivara: skills, memórias, documentação técnica, hooks e
os pedidos de cada projeto — num lugar só, servidos por **MCP**.

O harness não recebe "toda a documentação disponível". Ele pede o material de
**um** projeto e recebe o pedido mais os documentos que aquele projeto
selecionou. O resto do acervo continua existindo e não entra em run nenhum.

```
capivara init --mcp http://localhost:7777/mcp --mcp-project biblioteca
```

## Rodar

```bash
npm install
npm run check      # build + typecheck + testes
npm start          # interface e MCP em http://127.0.0.1:7777
```

`--port`, `--host` e `--db` (ou `PORT`, `HOST`, `DOC_CENTER_DB`) mudam onde ele
sobe e onde guarda.

## As três ideias

**O documento é a unidade.** Skill, memória, documentação, hook, prompt — tudo é
documento com um tipo. O tipo é um campo porque é isso que ele é; tabelas
separadas obrigariam a inventar uma a cada tipo novo.

**A área geral é o acervo; o projeto é uma seleção dele.** Um documento nasce na
área geral ou dentro de um projeto, e um projeto pode anexar documentos da área
geral. É a diferença entre ter e usar. A seleção aponta em vez de copiar: quem
corrige o original corrige para todos os projetos que o escolheram.

**O pedido é do projeto, e é um só.** Não é um documento entre outros: é o que o
harness lê para saber o que construir.

## O contrato com o harness

```
capivara://<projeto>/pedido
capivara://<projeto>/docs/<tipo>/<slug>
capivara://geral/docs/<tipo>/<slug>
```

Sob um projeto aparece **o que ele usa** — o que é dele mais o que selecionou.
Pedir um documento da área geral que o projeto não selecionou é recusado: se
bastasse o par tipo/slug, a seleção não significaria nada.

A coluna direita da interface mostra exatamente essas URIs, na ordem em que o
harness as lê. É a resposta para "o que disto vai junto?", que antes só existia
do outro lado do protocolo.

## Zero dependências de runtime

Banco é `node:sqlite`, servidor é `node:http`, e o MCP é JSON-RPC escrito aqui —
a aplicação inteira roda sem instalar nada além do Node. `esbuild`, `typescript`
e `vitest` são de desenvolvimento.

## O que o MVP não faz

Não é multi-tenant: é de uso próprio, sem contas nem autorização. Editar
conteúdo é um `prompt()` do navegador — um editor de verdade é trabalho de tela,
e entra quando o resto estiver firme.
