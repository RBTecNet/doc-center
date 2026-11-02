# doc-center

Base documental para projetos: skills, memórias, documentação técnica, hooks e
pedidos — reunidos em um só lugar e disponibilizados por **MCP**.

Um cliente MCP consulta os recursos de **um** projeto e acessa seu pedido e os
documentos associados a ele. O restante do acervo não é incluído automaticamente.

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

**O pedido é do projeto, e é um só.** Não é um documento entre outros: é a
referência principal do projeto disponível aos clientes MCP.

## Recursos MCP por projeto

Sob um projeto aparece **o que ele usa** — o que é dele mais o que selecionou.
Pedir um documento da área geral que o projeto não selecionou é recusado: se
bastasse o par tipo/slug, a seleção não significaria nada.

A coluna direita da interface mostra essas URIs para facilitar a consulta dos
recursos associados ao projeto.

## Zero dependências de runtime

Banco é `node:sqlite`, servidor é `node:http`, e o MCP é JSON-RPC escrito aqui —
a aplicação inteira roda sem instalar nada além do Node. `esbuild`, `typescript`
e `vitest` são de desenvolvimento.
