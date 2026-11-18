/* ============================================================
   PONTE DO DESMEMBRAMENTO (páginas da CMS)
   ============================================================
   Mesmo desenho da ponte do PDF (detalhada.js): a página não conhece a
   extensão nem o id dela — dispara um evento no window e escuta a
   resposta. Funciona igual em qualquer navegador e sobrevive a a
   extensão mudar de id.

   A DISPO manda:
     window.dispatchEvent(new CustomEvent('cms-desm-conferir', {
       detail: { pacote: { pedidos:[...], totais:{...}, sigla:'CH' } }
     }))

   E escuta:
     window.addEventListener('cms-desm-resposta', e => e.detail)
       detail = { tipo, texto, tag?, ebm?, dados?, ... }

   Os tipos:
     'log'       uma linha de relato (tag: info|acao|ok|warn|erro)
     'pedido'    terminou um pedido mãe, com o que foi lido no EBM
     'fim'       acabou (ok:true/false), com o resultado inteiro
     'erro'      não deu para começar ou o trabalho morreu
   ============================================================ */

// Marca a página: é assim que a DISPO sabe que a extensão está instalada
// e em que versão — sem isso ela não teria como oferecer o botão.
document.documentElement.dataset.cmsDesm = '0.10.0';

const DESM_ATUALIZOU =
  'A extensão foi atualizada. Recarregue esta página (F5) e tente de novo.';

function desmViva() {
  try { return !!chrome.runtime?.id; } catch (e) { return false; }
}

function desmResponder(detail) {
  window.dispatchEvent(new CustomEvent('cms-desm-resposta', { detail }));
}

window.addEventListener('cms-desm-conferir', (ev) => {
  const pacote = (ev.detail || {}).pacote;
  if (!pacote || !Array.isArray(pacote.pedidos) || !pacote.pedidos.length) {
    return desmResponder({ tipo: 'erro', texto: 'Pacote vazio: nada a conferir.' });
  }
  if (!desmViva()) return desmResponder({ tipo: 'erro', texto: DESM_ATUALIZOU });

  try {
    chrome.runtime.sendMessage({ de: 'cms-desm-app', tipo: 'conferir', pacote })
      .then((r) => {
        if (!r || !r.ok) {
          desmResponder({ tipo: 'erro', texto: (r && r.erro) || 'Não consegui iniciar.',
                          codigo: r && r.codigo });
        }
      })
      .catch((e) => desmResponder({ tipo: 'erro', texto: String(e && e.message || e) }));
  } catch (e) {
    desmResponder({ tipo: 'erro',
      texto: /context invalidated/i.test(String(e)) ? DESM_ATUALIZOU : String(e.message || e) });
  }
});

/* O piloto: um cliente só, preenchido e parado antes de salvar. O detail
   traz o pacote e qual cliente de qual pedido mãe. */
window.addEventListener('cms-desm-piloto', (ev) => {
  const d = ev.detail || {};
  if (!d.pacote || !d.cliente) {
    return desmResponder({ tipo: 'erro', texto: 'Faltou dizer qual cliente.' });
  }
  if (!desmViva()) return desmResponder({ tipo: 'erro', texto: DESM_ATUALIZOU });
  try {
    chrome.runtime.sendMessage({ de: 'cms-desm-app', tipo: 'piloto',
                                 pacote: d.pacote, cliente: d.cliente })
      .then((r) => {
        if (!r || !r.ok) desmResponder({ tipo: 'erro',
          texto: (r && r.erro) || 'Nao consegui iniciar.', codigo: r && r.codigo });
      })
      .catch((e) => desmResponder({ tipo: 'erro', texto: String(e && e.message || e) }));
  } catch (e) {
    desmResponder({ tipo: 'erro', texto: String(e.message || e) });
  }
});

/* Raio-X: só olha a tela e descreve. Não mexe em nada. */
window.addEventListener('cms-desm-raiox', (ev) => {
  const d = ev.detail || {};
  if (!desmViva()) return desmResponder({ tipo: 'erro', texto: DESM_ATUALIZOU });
  try {
    chrome.runtime.sendMessage({ de: 'cms-desm-app', tipo: 'raiox',
                                 pacote: d.pacote, cliente: d.cliente })
      .then((r) => { if (!r || !r.ok) desmResponder({ tipo: 'erro',
        texto: (r && r.erro) || 'Nao consegui iniciar.' }); })
      .catch((e) => desmResponder({ tipo: 'erro', texto: String(e && e.message || e) }));
  } catch (e) { desmResponder({ tipo: 'erro', texto: String(e.message || e) }); }
});

/* Depois de alguem olhar a tela: salvar ou desfazer. */
for (const [evento, tipo] of [['cms-desm-salvar', 'salvarPiloto'],
                              ['cms-desm-cancelar-tela', 'cancelarPiloto']]) {
  window.addEventListener(evento, () => {
    if (!desmViva()) return desmResponder({ tipo: 'erro', texto: DESM_ATUALIZOU });
    try {
      chrome.runtime.sendMessage({ de: 'cms-desm-app', tipo })
        .then((r) => {
          if (!r || !r.ok) desmResponder({ tipo: 'erro', texto: (r && r.erro) || 'Nao deu.' });
        })
        .catch((e) => desmResponder({ tipo: 'erro', texto: String(e && e.message || e) }));
    } catch (e) {
      desmResponder({ tipo: 'erro', texto: String(e.message || e) });
    }
  });
}

// Desistir: um trabalho preso segura o próximo até o prazo estourar.
window.addEventListener('cms-desm-parar', () => {
  if (!desmViva()) return desmResponder({ tipo: 'erro', texto: DESM_ATUALIZOU });
  try {
    chrome.runtime.sendMessage({ de: 'cms-desm-app', tipo: 'parar' })
      .then(r => desmResponder({ tipo: 'parado', tinha: !!(r && r.tinha) }))
      .catch(() => desmResponder({ tipo: 'parado', tinha: false }));
  } catch (e) { desmResponder({ tipo: 'parado', tinha: false }); }
});

// Andamento vindo do orquestrador
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.de === 'cms-desm') desmResponder(msg);
  });
} catch (e) { /* extensão recarregada: a página precisa de F5 */ }
