# CMS · PDF de Encomendas

Extensão que gera o PDF do pedido no EBM4Web a partir das encomendas marcadas no
app **Detalhada**. O vendedor clica no ícone de PDF na linha, uma aba trabalha em
segundo plano e o arquivo cai na pasta de downloads **com o nome do cliente**.

Feita para **Chrome e Edge**. Funciona no Firefox com pequenos ajustes, mas lá a
instalação permanente exige assinatura da Mozilla.

## Instalar

1. `chrome://extensions` (ou `edge://extensions`)
2. Ligue o **Modo do desenvolvedor**, no canto superior direito
3. **Carregar sem compactação** e escolha esta pasta
4. Recarregue a página da Detalhada

Se o ícone de PDF não aparecer nas linhas, a extensão não está ativa naquela
página — confira se o endereço da Detalhada está em `host_permissions` no
`manifest.json`. Hoje estão liberados `cms-representacoes.github.io`,
`127.0.0.1` e `localhost`.

## Antes de usar

**O vendedor precisa estar logado no EBM naquele navegador.** A extensão usa a
sessão dele e não guarda senha nenhuma. Sem login, ela avisa e para.

## Como está montado

| arquivo | papel |
|---|---|
| `background.js` | guarda em que passo o trabalho está e manda o próximo comando |
| `ebm.js` | roda nas páginas do EBM (mundo isolado); decide e confere |
| `ebm-main.js` | roda DENTRO da página; é quem chama as funções do EBM |
| `detalhada.js` | ponte com o app, por evento no `window` |

O app **não conhece a extensão**. Ele dispara `cms-ebm-pdf` e escuta
`cms-ebm-resposta`; a extensão marca `document.documentElement.dataset.cmsEbm`
para o app saber que pode mostrar o botão. Sem extensão, o botão nem aparece.

O `background.js` é quem lembra do roteiro, porque o `ebm.js` morre a cada
postback do EBM. A cada tela que carrega, o `ebm.js` pergunta "que passo é
agora?" e executa:

```
ABRIR → CONSULTA → RESULTADO ┐
                   DETALHE  ─┴→ VISUALIZADOR → FORMATO → baixa
```

**A tela muda de duas formas, e só uma delas carrega uma página.** Com 1 GCI o
EBM navega para o detalhe — documento novo, script novo. Com vários, a lista
aparece **no mesmo documento**. Por isso o `ebm.js` vigia continuamente e dispara
pela tela MUDAR, não pela página carregar; rodando uma vez por carregamento, o
segundo caso passava batido e o roteiro morria em silêncio. Pelo mesmo motivo o
identificador enviado ao orquestrador leva a tela junto (`doc:TELA`) — senão ele
responderia "já atendi este documento".

## A barreira que quase matou o projeto

**O EBM tem CSP: criar uma tag `<script>` na página não funciona.** E falha em
silêncio — nada avisa, o código simplesmente não roda. Passamos um dia depurando
a lógica de algo que nunca chegava a executar.

A saída é o `ebm-main.js`, declarado no manifesto com `"world": "MAIN"`: o
próprio Chrome o instala no mundo da página, e o CSP não se aplica. Os dois lados
conversam por evento no `window`, com o payload em **texto** — objeto atravessa
mal a fronteira entre os mundos.

Sintoma para reconhecer isso de novo: qualquer sonda ao mundo da página volta
vazia, e os campos continuam com o valor antigo depois de "gravados".

## A grade de critérios

É a parte difícil, e o roteiro dela veio de gravar as chamadas enquanto um
usuário preenchia a linha na mão:

```
selectCol(campo)
campo.value = ...
buttonClick(campo.parentNode, 'change')
       ↓ servidor
ajaxShowEditContent('form1:webFilterGrid:row0:2')
showEditContent(td, false, undefined)
```

**Quem abre a coluna seguinte é o `buttonClick` da anterior** — a grade faz isso
sozinha, por ajax. Forçar a abertura antes da resposta chegar atrapalha o próprio
componente, então aqui a regra é esperar primeiro e só insistir se não vier.

Três coisas que custaram um dia de depuração:

- **O valor escolhido pode voltar sozinho** ao primeiro item depois do postback.
  Era o que acontecia com a coluna Campo, que voltava para "Número Encomenda EBM"
  sem ninguém perceber. Toda escrita é conferida e repetida.
- **O `onblur` das células é `hideEdit()`, que FECHA o editor.** Nunca disparar
  blur num `<select>` da grade.
- **Só existe um editor por vez, e enquanto o anterior está aberto nenhuma outra
  célula abre** — nem no clique, nem pelo ajax. No uso normal o navegador tira o
  foco antes de entregar o clique, e o `onblur` fecha sozinho; um `click()` por
  código não mexe no foco. Por isso `fecharEditores` roda antes de cada abertura.
- Não dá para contar linhas pelos campos — o contador da barra ("1 - 6 / 6") é a
  única fonte.
- Com a célula ABERTA, o `innerText` do `td` devolve a lista inteira de opções do
  `<select>`. Conferir o que foi gravado exige ler o `value` do editor.

## Duas telas de resultado

Com **um GCI** o EBM pula a lista e cai direto no detalhe, onde o botão é
`form1:btnImprimir`. Com **dois ou mais** vem a lista, e o botão é
`form1:btnPedido`. Por isso as telas são reconhecidas por elemento, não por
endereço. O operador também muda: `=` para um, `IN` (INFORMADOS) para vários.

## A lista de encomendas (2 ou mais GCIs)

As caixas de seleção **nascem desmarcadas**. O `CMS_ENCOMENDAS.py` tem um
comentário dizendo o contrário, e essa frase custou horas: as telas mostravam
tudo marcado porque era o próprio roteiro que acabara de marcar, e isso se lia
como "já vinha assim". Se um dia a dúvida voltar, o teste é abrir a lista na mão
e olhar antes de qualquer automação tocar nela.

São caixas comuns, sem `onclick` — marcar não dispara postback. Por isso marcar e
clicar em "visualizar pedido" acontece na mesma passada. Uma versão anterior
marcava e devolvia o passo, esperando um recarregamento que nunca vinha: a lista
ficava pronta na tela aguardando um clique que não vinha junto.

Cuidado com a caixa do **cabeçalho** da grade, o "marcar todos": ela também tem
`grdGrid` no id. Contá-la junto faz parecer que sobrou uma desmarcada. Só valem
as que têm `:row<N>:` no id.

## O visualizador e a janela de formato

A barra com o disquete mora **num frame separado** do `ReportViewerLoader.html`,
e o ícone não tem id: é achado pelo `save` no `src`. Como um content script vive
dentro de um documento só, a busca percorre os frames de mesma origem — é o que
o Selenium faz entrando em cada `ctx`.

O `ReportViewer.jsp` carrega um **input escondido** com o mesmo id do combo de
formato (`...CMB_PRINTER`). Sem exigir que seja um `<select>` de verdade, um
frame dele rouba o passo antes de o `printOptions.html` abrir.

A janela de formato abre com o combo **vazio**; as opções chegam depois. Agir
antes disso não escolhe nada, e o EBM responde *"Tipo de exportação selecionado é
inválido"* num alerta que tranca a janela — por isso o roteiro espera a lista
encher e não manda imprimir se o formato falhou.

O OK não é submit: o `onclick` dele chama `printReport()`. Mesmo assim o **botão
vem primeiro**, e a função só como reserva — o `onclick` costuma fazer mais do
que imprimir, e é onde a escolha do combo é lida e validada.

Um detalhe que ajuda: `el.click()` dispara o `onclick` inline da página mesmo a
partir do mundo isolado. O que ele **não** faz é mover o foco — daí a necessidade
de fechar o editor anterior à mão.

## Quando algo der errado

**Ligue o modo de acompanhamento.** No app, no console do navegador:

```js
window.dispatchEvent(new CustomEvent('cms-ebm-pdf', {
  detail: { gcis: ['5338132'], status: 'A', nomeArquivo: 'TESTE', debug: true }
}))
```

Com `debug: true` a aba do EBM abre **visível** e não é fechada no fim — dá para
ver exatamente em que tela travou.

O passo a passo completo sai no console da Detalhada quando dá erro, e também em
`chrome://extensions` → **service worker** da extensão.

## O que ainda não faz

- **Só um GCI ou alguns selecionados.** A emissão em lote (o semestre inteiro de
  um cliente) fica para depois. Quando vier, vai precisar separar os GCIs por
  status — o EBM reaproveita número de encomenda, e uma busca por GCI sem filtrar
  status traz a antiga junto com a nova.
- Um PDF por vez. Dois pedidos simultâneos brigariam pela sessão do EBM, que é
  única.
