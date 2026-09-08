# Gerador de Catálogo — base JSON e conferência de imagens

Data: 08/09/2026 · Aprovado em conversa.

## Problema

O gerador lê `Produtos.xlsx` (1.054 linhas) e `produtos_ua.xlsx` (65) por HTTP,
enquanto o restante da CMS já usa `data/produtos.json` (957 itens, repo
`apps-oly`), que o worker serve por `getProdutos` e grava por `saveProdutos`, e
que o admin já sabe cadastrar. As duas bases divergiram: 34 pares código+cor só
existem no xlsx, 7 só no JSON.

Além disso, um produto sem imagem só é descartado na hora de gerar o PDF
(`gerador-catalogo.html:944`), calado — quem confere a lista não sabe que ele vai
sumir nem por quê.

## Decisões

1. **`data/produtos.json` passa a ser a fonte da verdade do gerador.** O xlsx
   vira histórico. `index.html` e `carteira/index.html` continuam lendo o xlsx —
   migrá-los é um passo separado, e até lá um cadastro novo não aparece neles.
2. **Produto sem imagem não entra no catálogo**, e a conferência diz o motivo:
   sem cadastro na base, ou cadastrado com imagem que não existe.
3. **Cadastro enxuto pela própria página**: imagem, produto, cor, cor código,
   gênero, TAM, preço. Categoria e segmento são copiados de outra cor do mesmo
   código quando existir; senão ficam vazios.

## Partes

### A. Migração (uma vez)

Script descartável. Lê o `produtos.json` **ao vivo** (via `getProdutos`, não a
cópia local — o admin pode ter gravado depois) e os dois xlsx. Acrescenta `tam`
e `marca` a cada item, importa os 34 pares que só existem no xlsx, não remove
nada. Backup do arquivo atual antes de gravar.

### B. Leitura da base

`carregarBase()` troca as duas fetches de xlsx por `getProdutos`, com a URL do
Pages como reserva. Índice continua `codigo|cor` e `codigo|corCodigo`. O filtro
"Marca" passa a usar o campo `marca`.

### C. Conferência de imagem antecipada

A checagem que hoje roda no passo 4 vai para o passo 3: cada imagem é testada uma
vez (cache por nome de arquivo, mesma cascata de extensões), com progresso na
tela. Estados: `ok`, `semImagem`, `semCadastro`.

### D. Bloco Pendências

Lista principal só com os `ok`; a seleção inicial é ela. Abaixo, bloco recolhível
com dois grupos — "Sem cadastro na base" e "Cadastrado, mas a imagem não existe"
(mostrando o arquivo procurado). Sem checkbox. Cada linha abre o cadastro. Ao
resolver, o item sobe para a lista principal sem reimportar a planilha.

### E. Cadastro e upload

Modal pré-preenchido a partir da linha da planilha e de outra cor do mesmo
código. Para o caso "sem imagem", o nome do arquivo é editável e há um botão que
sonda a URL — resolve erro de nome (`43447473_PTOCH` → `43447473_PTO_CH`) sem
reenviar foto. Gravação: `uploadMatrizImagem` → `getProdutos` → `saveProdutos`.
Upload falhou, nada é gravado.

## Riscos aceitos

- A página é pública e o worker libera writes enquanto `ADMIN_TOKEN` não estiver
  configurado. Quem abrir o gerador pode gravar na base. Já vale para o admin
  hoje; o gerador circula mais.
- `saveProdutos` regrava o arquivo inteiro: dois cadastros ao mesmo tempo, o
  último ganha. A leitura imediatamente antes da gravação estreita a janela, não
  a elimina.
- Nenhuma alteração no worker é necessária.

## Verificação

- Migração: os 957 continuam, os 34 entraram, todo item tem `tam` e `marca`,
  nenhum campo existente mudou de valor.
- Gerador: com `REPASSES TALENTUS 2S26 CATALOGO 2.xlsx`, os 78 produtos se
  dividem entre lista e pendências, e a contagem bate com a checagem feita fora
  do navegador.
