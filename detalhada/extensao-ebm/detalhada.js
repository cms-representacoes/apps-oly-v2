/* ============================================================
   PONTE COM O APP DETALHADA
   ============================================================
   O app não conhece a extensão e nem precisa: ele dispara um evento
   no window e escuta a resposta. Assim funciona igual no Chrome e no
   Firefox, sem depender do id da extensão.

   O app manda:
     window.dispatchEvent(new CustomEvent('cms-ebm-pdf', {
       detail: { gcis: ['5338132'], status: 'A', nomeArquivo: 'LOJAS NOROESTE' }
     }))

   E escuta:
     window.addEventListener('cms-ebm-resposta', e => e.detail)
       detail = { tipo: 'progresso'|'fim'|'erro', texto, log? }
   ============================================================ */

// Marca a página para o app saber que a extensão está instalada.
document.documentElement.dataset.cmsEbm = '0.2.0';

/** Recarregar a extensão mata o script que já está na página: o
 *  `chrome.runtime` vira inválido e QUALQUER chamada estoura na hora —
 *  de forma síncrona, então `.catch` não pega. Sem isso o app ficava com
 *  a tarja girando para sempre, sem dizer o motivo. */
const ATUALIZOU = 'A extensão foi atualizada. Recarregue esta página (F5) e tente de novo.';

function extensaoViva() {
  try { return !!chrome.runtime?.id; } catch (e) { return false; }
}

window.addEventListener('cms-ebm-pdf', (ev) => {
  const dados = ev.detail || {};
  if (!Array.isArray(dados.gcis) || !dados.gcis.length) {
    return responder({ tipo: 'erro', texto: 'Nenhum GCI informado.' });
  }
  if (!extensaoViva()) return responder({ tipo: 'erro', texto: ATUALIZOU });

  try {
    chrome.runtime.sendMessage({ de: 'cms-detalhada', tipo: 'gerarPdf', dados })
      .then((r) => {
        if (!r || !r.ok) responder({ tipo: 'erro', texto: (r && r.erro) || 'Não consegui iniciar.' });
      })
      .catch((e) => responder({ tipo: 'erro', texto: String(e && e.message || e) }));
  } catch (e) {
    responder({ tipo: 'erro', texto: /context invalidated/i.test(String(e)) ? ATUALIZOU : String(e.message || e) });
  }
});

// Andamento vindo do orquestrador
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.de === 'cms-ebm') responder(msg);
  });
} catch (e) { /* extensão recarregada: a página precisa de F5 */ }

function responder(detail) {
  window.dispatchEvent(new CustomEvent('cms-ebm-resposta', { detail }));
}
