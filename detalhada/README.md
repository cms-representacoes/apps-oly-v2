# Detalhada

Relatório de carteira e faturamento por produto, montado sobre a planilha
**DETALHADA PREPOSTOS**. Mesma identidade visual do app `carteira/`.

Três telas: **Login** (só escolher o nome) → **Produtos** (a tela de trabalho) →
**Admin** (subir a Detalhada do dia, só para o perfil `C M S`).

## Rotina diária

1. Entrar no app como `C M S` e abrir o ícone de upload na barra do topo.
2. Escolher o `DETALHADA PREPOSTOS ....xlsx`. A leitura leva ~10–15 s
   (57 mil linhas); a base já passa a valer nesse aparelho.
3. Conferir o resumo e os avisos.
4. Clicar em **Baixar detalhada.json**, substituir `dados/detalhada.json`
   e commitar. Os vendedores passam a ver a base nova ao abrir o app.

O app guarda a última base em IndexedDB, então abre offline e sem esperar o
download. Ao abrir, ele busca `dados/detalhada.json` e troca se houver versão
mais nova (comparando o campo `gerado`).

## O que a planilha precisa ter

Aba `DETALHADA`, cabeçalho na linha 2, com as colunas:

```
PREPOSTO · NOME FANTASIA · CODIGO · MARCA · FABRICA · FILIAL · NF · OC
GCI · REFERENCIA · DESCRICAO · COR · PREV FAT · CART · FAT · DATA FAT
```

A busca do cabeçalho ignora acento e maiúscula, e cai para a linha 1 se não
achar `PREPOSTO` na linha 2. As colunas `PORTA` e `STATUS 1/2/3` vêm vazias e
são ignoradas.

Cada linha é **ou** carteira (`CART > 0`, sem NF) **ou** faturado (`FAT > 0`,
com NF e DATA FAT) — nunca as duas. Linhas com `CART` e `FAT` zerados, ou sem
preposto/referência/cor/código, são descartadas e contadas nos avisos.

## Formato do `detalhada.json`

Dicionário + linhas como vetores de inteiros, para caber num download leve
(2,96 MB; bem menos com o gzip do servidor).

```jsonc
{
  "v": 1,
  "gerado": "2026-08-21T13:52:00-03:00",  // usado para detectar base nova
  "origem": "DETALHADA PREPOSTOS 21-08-2026.xlsx",
  "dataDia": 20685,                        // maior DATA FAT = dia do relatório
  "dic": {
    "prep":  ["WILLAME", ...],
    "cli":   [["127616", "LOJAS NOROESTE"], ...],
    "marca": ["OLY", ...], "fab": [...], "fil": [...],
    "ref":   [["43667419", "RUSH"], ...],  // referência + descrição (1:1)
    "cor":   ["PRETO", ...],
    "oc":    ["CORRE ABR", ...]
  },
  "l": [[prep, cli, marca, fab, fil, ref, cor, gci, nf, oc, prev, cart, fat, dfat], ...]
}
```

Datas são **dias inteiros desde 1970-01-01**; `-1` quando vazio. `oc: -1`,
`gci: 0` e `nf: 0` também significam vazio. A ordem dos campos da linha está em
`const C` no topo do `<script>` de `index.html` — mexeu ali, suba o `v` e
regere a base.

## Ações da linha (manter / repassar / cancelar)

Cada lançamento **ainda em carteira** ganha os três botões, nas mesmas cores do
app `carteira/` (`--acao-manter`, `--acao-repassar`, `--acao-cancelar`). Linhas
já faturadas não recebem botão — não há o que decidir sobre elas.

`MANTER` é o padrão e **não é gravado**: `APP.acoes` guarda só o que fugiu do
padrão, então marcar tudo como manter deixa o mapa vazio. A chave é
`codigo|gci|referencia|cor` — estável o bastante para sobreviver à troca da
base diária, ao contrário do índice da linha.

### O GCI é a unidade

A fábrica **anula o GCI inteiro** e cria outro no cliente novo — é assim que o
produto sai da carteira. Comprovado comparando as bases de 20 e 21/08: dos **63
GCIs que saíram da carteira, 63 saíram com todas as linhas**. Nenhum perdeu só
parte.

Por isso marcar uma linha marca as irmãs do mesmo GCI (com aviso). 87,9% dos
GCIs em carteira têm uma linha só, então na prática quase nunca muda nada — mas
nos 12% restantes evita prometer o que a operação não faz. E GCI com vários
itens **não divide em caixas**: não faz sentido mandar "3 caixas" de um pedido
com 11 produtos diferentes.

### Repasse em dois passos

`REPASSAR` só marca a linha (fica **pendente**, com barra tracejada). Um segundo
botão, **Escolher destino**, abre o modal — assim o vendedor pode varrer a lista
marcando o que sai e resolver o destino depois.

O modal ranqueia os candidatos em quatro grupos, todos calculados da própria
base (quem tem a referência em carteira e quem já faturou):

1. **Já tem o artigo · falta esta cor** — melhor destino
2. **Não tem este artigo** (com carteira aberta)
3. **Só faturado no ano · sem carteira**
4. ⚠ **Já tem esta cor · receberia dobrado**

Tem ainda o escopo por rede (quando o cliente de origem pertence a uma), busca
por nome ou código, e o aviso "já vai receber X de FULANO" quando outro repasse
da mesma referência+cor já aponta para aquele destino.

O quarto grupo vem de fora: a base completa do **app Clientes**, lida do worker
por `getClientes` (um arquivo por vendedor em `data/clientes/{código}.json`).
São 1.704 clientes, dos quais **913 não compraram em 2026** e portanto não
existem na Detalhada. Ela só é buscada quando o usuário digita algo, e fica no
IndexedDB depois. Traz cidade e estado, que a Detalhada não tem.

> Hoje só 4 dos 7 prepostos têm arquivo lá (MARIANA, JORGE, RAFAEL, WILLAME).
> Faltam **LEANDRO**, **C M S** e CHRISTIAN — juntos, 369 mil pares em carteira.
> Enquanto ninguém subir esses arquivos pelo app Clientes, os destinos deles só
> aparecem se já estiverem na Detalhada.

**A lista de destinos não filtra por preposto.** Entre 20 e 21/08, a maioria dos
repasses observados foi para clientes de **outro** vendedor — LUAR SPORT
(WILLAME) → BANBAN (LEANDRO) e TOP SPORT (RAFAEL), TOC TOC (WILLAME) → PASSO
FIRME (MARIANA). Recortar por preposto esconderia justamente os destinos reais.

**Caixas.** A Detalhada não traz a grade, então o tamanho da caixa é inferido
dos pares: divisível por 12 → caixa de 12; senão por 6 → caixa de 6. Linhas com
menos de 24 pares vão para **uma loja só**; de 24 para cima dá para dividir com
os `+`/`−`, travado no total de caixas. Quando os pares dividem por 12, um
toggle `6 / 12` deixa escolher o passo.

### Acompanhar e conciliar

Dois chips a mais na fila de status, que só aparecem quando têm conteúdo:
**A destinar** (marcado sem destino) e **Repassados** (com destino). O contador
fica no próprio chip; um badge vermelho conta os pendentes com faturamento em
menos de 20 dias, e um pontinho âmbar sinaliza novidade.

Esses dois não são desenhados da base — um repasse concluído some dela. Eles vêm
das marcações, cruzadas com a base para descobrir o estado atual:

| estado | o que aconteceu |
|---|---|
| `Aguardando` | a linha segue em carteira |
| `⚠ Faturou no origem` | virou NF no cliente original — o repasse não saiu a tempo |
| `✅ Saiu da carteira` | o GCI foi anulado |
| `✅ Confirmado em X` | o destino ganhou um GCI que não tinha antes, com a mesma ref+cor |

A confirmação depende de `gcisAntes`: na hora de confirmar o destino, guardamos
quais GCIs aquele cliente já tinha daquele produto. Sem essa foto, um GCI novo
no destino poderia ser só uma compra dele — 8.539 combinações de cliente+ref+cor
já aparecem em GCIs separados na base.

Não tentamos adivinhar repasses que ninguém marcou: casar GCIs sumidos com GCIs
novos só pelos dados deu **173 candidatos para 63 GCIs** — ambíguo demais.

Cada marcação guarda o último estado `visto`, então a novidade avisa uma vez só.

> **Ainda não sincroniza.** As marcações vivem só no `localStorage`
> (`detalhada.acoes`), no formato `{ chave: { acao, repasse } }` — de propósito
> o mesmo que o worker guarda em `data/carteira-cms-acoes.json`.
>
> Duas coisas travam a sincronização hoje:
>
> 1. **A chave é diferente.** A Carteira usa
>    `cliente|gci|artigo|cor|grade_str|total` (seis partes, para distinguir
>    dobrados do mesmo GCI com grades diferentes). A Detalhada não tem grade, e
>    usa quatro partes. Gravar assim no arquivo compartilhado criaria duas
>    marcações independentes para a mesma linha física.
> 2. **`saveAcaoCarteira` está em `WRITE_ACTIONS`** do worker, exigindo o header
>    `X-Admin-Token` quando `env.ADMIN_TOKEN` estiver configurado. Nenhum dos
>    apps manda esse header — eles só gravam porque o token ainda não foi
>    definido (o worker chama isso de "modo legado" e loga um aviso).

## PDF do pedido, direto do EBM

A pasta [`extensao-ebm/`](extensao-ebm/) tem uma extensão de Chrome/Edge que gera
o PDF do pedido no EBM4Web a partir de um GCI da Detalhada. O vendedor clica no
ícone de PDF na linha, o EBM trabalha numa janela minimizada e o arquivo cai na
pasta de downloads **com o nome do cliente**.

O app não conhece a extensão: ele dispara o evento `cms-ebm-pdf` e escuta
`cms-ebm-resposta`. Sem a extensão instalada, o botão de PDF nem aparece — quem
o liga é a marca `data-cms-ebm` que ela deixa no `<html>`.

O README de lá conta as armadilhas do EBM, e vale ler antes de mexer: são
descobertas caras, nenhuma delas óbvia.

## Detalhes que valem lembrar

- **Login não é controle de acesso.** É só um filtro de visão: o vendedor vê as
  linhas do próprio preposto, o `C M S` vê tudo e ganha a tela de admin.
- A planilha traz o preposto como `C M S` (com espaços) e existe `CHRISTIAN`.
  `PREPOSTO_MAP` normaliza apelidos (`LÉO` → `LEANDRO`, `CMS` → `C M S`).
- As fotos vêm de `../imagens_olympikus/REFERENCIA_COR.jpg` — a mesma chave que
  a planilha usa, com `/` virando `_`.
- O filtro **Mês** usa a DATA FAT quando a linha já faturou, e a PREV FAT quando
  ainda está em carteira.
- Todos os filtros são de **múltipla escolha**: cada um guarda um `Set` de
  valores marcados e um `Set` vazio significa "sem filtro". Filtros diferentes
  se somam (E), valores do mesmo filtro se acumulam (OU). Só a **Ordem** é de
  escolha única. O popover vive no `<body>` com posição fixa ancorada no chip,
  para não ser cortado pela barra de filtros; ele fecha ao rolar a página.
