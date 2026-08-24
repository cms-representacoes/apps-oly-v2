# Worker · publicar a Detalhada

Três actions novas, para o script diário e a tela de admin publicarem a base
sem passar por commit manual nem esperar o GitHub Pages.

**Por que precisou mexer no worker:** não havia nenhuma action que servisse.
`saveCarteira` grava outra coisa, `saveRfv` pertence a outro app. Reaproveitar
uma delas deixaria dois apps escrevendo no mesmo arquivo por motivos
diferentes — que é justamente o problema que já temos com
`carteira-cms-acoes.json`.

## O que colar

### 1. Ao lado das outras constantes `GITHUB_*`

```js
    // Detalhada por preposto — base publicada pelo script diário e pela tela
    // de admin. O arquivo grande fica separado do resumo: assim o app
    // pergunta "mudou?" sem baixar 3 MB a cada abertura.
    const GITHUB_DETALHADA      = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/detalhada.json`;
    const GITHUB_DETALHADA_INFO = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/data/detalhada-info.json`;
```

### 2. No bloco do `PATCH`, junto das outras actions

```js
        // ── DETALHADA (por preposto) ──────────────────────────────────
        // getDetalhadaInfo → só o resumo (alguns bytes). O app consulta isto
        // a cada abertura e só baixa a base inteira quando `gerado` mudou.
        if (body.action === "getDetalhadaInfo") {
          try {
            const { content } = await getFile(GITHUB_DETALHADA_INFO);
            return new Response(JSON.stringify(content || { gerado: null }),
              { status: 200, headers: corsHeaders });
          } catch (_) {
            return new Response(JSON.stringify({ gerado: null }),
              { status: 200, headers: corsHeaders });
          }
        }

        // getDetalhada → a base inteira. Pública: é o que os vendedores leem.
        if (body.action === "getDetalhada") {
          const { content } = await getFile(GITHUB_DETALHADA);
          return new Response(JSON.stringify(content || null),
            { status: 200, headers: corsHeaders });
        }

        // saveDetalhada → publica a base. Sem token, como savePerformance e
        // saveRfv: quem publica é o script diário da máquina da CMS e a tela
        // de admin, nenhum dos dois tem como guardar segredo.
        if (body.action === "saveDetalhada" && body.data && typeof body.data === "object") {
          const base = body.data;
          // Guarda de segurança: um payload quebrado apagaria a base de todos
          // os vendedores, e o erro só apareceria no dia seguinte.
          if (!Array.isArray(base.l) || !base.l.length || !base.dic) {
            return new Response(JSON.stringify({
              success: false,
              error: "Base inválida: esperado { dic, l:[...] } com pelo menos uma linha."
            }), { status: 400, headers: corsHeaders });
          }

          const { sha } = await getFile(GITHUB_DETALHADA);
          const payload = { ...base, publicadoEm: new Date().toISOString(), por: String(body.por || "") };
          await saveFile(GITHUB_DETALHADA, payload, sha,
            `detalhada: base de ${payload.por || "?"} (${base.l.length} linhas)`);

          // O resumo vai depois: se a base falhar, ninguém fica achando que
          // publicou. Um resumo velho é menos grave que uma base velha.
          const info = {
            gerado: base.gerado || payload.publicadoEm,
            publicadoEm: payload.publicadoEm,
            origem: base.origem || "",
            linhas: base.l.length,
            por: payload.por,
          };
          try {
            const { sha: shaInfo } = await getFile(GITHUB_DETALHADA_INFO);
            await saveFile(GITHUB_DETALHADA_INFO, info, shaInfo, "detalhada: resumo");
          } catch (_) { /* o resumo é conveniência, não bloqueia */ }

          return new Response(JSON.stringify({ success: true, ...info }),
            { status: 200, headers: corsHeaders });
        }
```

## O que NÃO mudar

`saveDetalhada` fica **fora** de `WRITE_ACTIONS`, pelo mesmo motivo de
`savePerformance` e `saveRfv`: quem publica é um script na máquina da CMS e
uma tela de navegador. Nenhum dos dois consegue guardar o `ADMIN_TOKEN` sem
expô-lo.

A proteção real aqui é a validação do payload logo acima — ela recusa
qualquer coisa que não seja uma base com linhas, que é o estrago que
importa evitar.

## Depois de publicar o worker

Confira com uma chamada só:

```bash
curl -s -X PATCH https://repasse-worker-cms.marcosrep-cms.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{"action":"getDetalhadaInfo"}'
```

Deve responder `{"gerado":null}` enquanto nada foi publicado — e o resumo
da base depois da primeira publicação.
