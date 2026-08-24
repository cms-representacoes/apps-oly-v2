/* ============================================================
   BRAÇO NO MUNDO DA PÁGINA
   ============================================================
   Este arquivo roda DENTRO da página do EBM, com acesso direto às
   funções dela: `selectRow`, `selectCol`, `buttonClick`, `hideEdit`,
   `ajaxShowEditContent`, `printReport`.

   POR QUE ELE EXISTE
   ------------------
   O `ebm.js` vive num mundo isolado: enxerga o DOM, mas não as funções
   do EBM. A saída óbvia — criar uma tag `<script>` na página — **não
   funciona aqui**: o EBM tem CSP e recusa o script em silêncio. Nada
   avisa; o código simplesmente nunca roda. Isso custou um dia inteiro de
   depuração de uma lógica que nem chegava a executar.

   O Chrome resolve isso com `"world": "MAIN"` no manifesto: o próprio
   navegador instala o arquivo no mundo da página, e o CSP não se aplica.

   COMO OS DOIS CONVERSAM
   ----------------------
   Por evento no `window`, que é a única coisa que os dois mundos
   compartilham. O payload vai como TEXTO — objetos atravessam mal a
   fronteira, string atravessa sempre.

       ebm.js   →  'cms-ebm-req'   { id, op, args }
       este     →  'cms-ebm-res'   { id, ok, valor|erro }
   ============================================================ */

(() => {
  const G = 'form1:webFilterGrid';
  const idCampo  = (l, c) => `${G}:webGrid:txtInput:row${l}:${c}`;
  const idCelula = (l, c) => `${G}:row${l}:${c}`;
  const $ = (id) => document.getElementById(id);

  /** O que a página tem de fato. É a primeira coisa a olhar quando algo
   *  para de responder. */
  function sonda() {
    const nomes = ['selectRow', 'selectCol', 'buttonClick', 'hideEdit',
                   'showEditContent', 'ajaxShowEditContent'];
    const falta = nomes.filter(n => { try { return typeof window[n] !== 'function'; }
                                      catch (e) { return true; } });
    let sel = '';
    try { sel = ` selRow=${window.selRow} selCol=${window.selCol}`; } catch (e) {}
    return (falta.length ? 'FALTA ' + falta.join(',') : 'tudo presente') + sel;
  }

  /** Fecha os editores abertos nas colunas indicadas.
   *
   *  A grade só admite um editor por vez, e enquanto o anterior está
   *  aberto nenhuma outra célula abre. No uso normal isso passa
   *  despercebido: o navegador tira o foco antes de entregar o clique, e
   *  o `onblur` (que é `hideEdit`) fecha a célula sozinho. Um `click()`
   *  por código não mexe no foco, então é preciso fechar na mão.
   *
   *  Seguro nos dois tipos de campo: no <select> o valor já foi comitado
   *  pelo `onchange`, e no <input> de texto é o próprio `hideEdit` que
   *  grava o que foi digitado.
   */
  function fecharEditores({ linha, cols }) {
    const feitos = [];
    for (const c of cols) {
      const el = $(idCampo(linha, c));
      if (!el) continue;
      try { if (typeof el.onblur === 'function') { el.onblur(); feitos.push(`${c}:onblur`); continue; } } catch (e) {}
      try { if (typeof hideEdit === 'function') { hideEdit(el, false, false); feitos.push(`${c}:hideEdit`); continue; } } catch (e) {}
      try { el.blur(); feitos.push(`${c}:blur`); } catch (e) {}
    }
    return feitos.join(' ') || 'nada aberto';
  }

  /** Pede a abertura de uma célula.
   *  `ajaxShowEditContent` recebe o ID como TEXTO, não o elemento — e
   *  responde de forma assíncrona, então quem chamou tem que esperar. */
  function abrirCelula({ linha, col }) {
    const id = idCelula(linha, col);
    const td = $(id);
    if (!td) return 'sem td';
    if ($(idCampo(linha, col))) return 'já aberta';
    try { if (typeof ajaxShowEditContent === 'function') { ajaxShowEditContent(id); return 'ajax'; } } catch (e) {}
    try { if (typeof showEditContent === 'function') { showEditContent(td, false, undefined); return 'direto'; } } catch (e) {}
    try { if (typeof selectRow === 'function') { selectRow(td); return 'selectRow'; } } catch (e) {}
    td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return 'dblclick';
  }

  /** Escreve numa célula seguindo a sequência da própria grade:
   *      selectCol(campo) → valor → buttonClick(td, 'change')
   *  É o `buttonClick` que grava E manda o servidor abrir a coluna
   *  seguinte. Ele vai no TD (parentNode), como no `onchange` da célula. */
  function escreverCelula({ linha, col, valor }) {
    const el = $(idCampo(linha, col));
    if (!el) return 'sem campo';

    try { if (typeof selectCol === 'function') selectCol(el); } catch (e) {}

    if (el.tagName === 'SELECT') {
      const i = [...el.options].findIndex(o => o.value === valor);
      if (i < 0) {
        return 'sem a opção (tem: ' +
          [...el.options].slice(0, 8).map(o => o.value).join(',') + ')';
      }
      el.selectedIndex = i;
      el.options[i].selected = true;
    } else {
      el.value = valor;
    }

    try { if (typeof buttonClick === 'function') { buttonClick(el.parentNode, 'change'); return 'ok'; } } catch (e) {}
    try { if (el.onchange) { el.onchange(); return 'ok (onchange)'; } } catch (e) {}
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok (evento)';
  }

  function definirStatus({ id, valor }) {
    const s = $(id);
    if (!s) return 'sem combo';
    const i = [...s.options].findIndex(o => o.value === valor);
    if (i < 0) return 'sem a opção ' + valor;
    s.selectedIndex = i;
    s.options[i].selected = true;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    try { if (typeof s.onchange === 'function') s.onchange(); } catch (e) {}
    return s.options[i].text.trim();
  }

  /** Janela de opções: escolhe Adobe PDF e todas as páginas.
   *
   *  Escolhe pelo `value` e, se ele não existir, pelo RÓTULO — a janela
   *  abre com o combo em branco, então não dá para contar com um padrão
   *  já selecionado.
   *
   *  Levanta erro quando não consegue: mandar imprimir com o formato
   *  errado faz o EBM responder "Tipo de exportação selecionado é
   *  inválido" num alerta, que trava a janela e não dá para fechar daqui.
   */
  function formato({ idCombo, idTodas, valor }) {
    // tem que ser <select>: o ReportViewer.jsp tem um input escondido
    // com o mesmo id, e ele não tem opção nenhuma para escolher
    const achado = $(idCombo);
    const s = (achado && achado.tagName === 'SELECT') ? achado
      : document.querySelector('select[id*="CMB_PRINTER"], select[name*="CMB_PRINTER"]');
    if (!s) {
      const outros = Array.from(document.querySelectorAll('select'))
        .map(x => x.id || x.name || '(sem id)').slice(0, 5);
      throw new Error('combo de formato não encontrado (selects na tela: ' +
        (outros.join(', ') || 'nenhum') + ')');
    }

    const opcoes = Array.from(s.options || []);
    let i = opcoes.findIndex(o => o.value === valor);
    if (i < 0) i = opcoes.findIndex(o => /adobe|pdf/i.test(o.text || ''));
    if (i < 0) {
      throw new Error('a opção PDF não está na lista (tem: ' +
        (opcoes.map(o => `"${o.text}"=${o.value}`).join(' | ') || 'nada') + ')');
    }

    s.selectedIndex = i;
    s.options[i].selected = true;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    try { if (typeof s.onchange === 'function') s.onchange(); } catch (e) {}

    if (!s.value) throw new Error('o combo não guardou a escolha');

    const todas = $(idTodas) || document.querySelector('input[type=radio][id*="AllPages" i]');
    if (todas && !todas.checked) {
      todas.checked = true;
      todas.dispatchEvent(new Event('click', { bubbles: true }));
      todas.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return `${s.id || s.name} = "${s.options[i].text}"/${s.value}` +
      (todas ? ` · todas=${todas.checked}` : '');
  }

  /** Aciona o OK da janela de formato.
   *
   *  O botão vem PRIMEIRO, e `printReport()` só como reserva: o `onclick`
   *  dele costuma fazer mais do que imprimir — é onde a escolha do combo
   *  é lida e validada. Chamar `printReport` direto pula essa parte.
   */
  function imprimir() {
    const bs = document.querySelectorAll('input[type=button], input[type=submit], button');
    for (const b of bs) {
      if ((b.value || b.textContent || '').trim().toUpperCase() !== 'OK') continue;
      if (b.disabled) continue;
      const attr = b.getAttribute('onclick');
      if (attr) { try { new Function(attr).call(b); return 'OK (onclick)'; } catch (e) {} }
      try { b.click(); return 'OK (clique)'; } catch (e) {}
    }

    try { if (typeof printReport === 'function') { printReport(); return 'printReport'; } } catch (e) {}
    try { if (window.opener && typeof window.opener.printReport === 'function') { window.opener.printReport(); return 'printReport do opener'; } } catch (e) {}
    try { if (window.parent && typeof window.parent.printReport === 'function') { window.parent.printReport(); return 'printReport do parent'; } } catch (e) {}

    throw new Error('não achei o botão OK nem a função printReport');
  }

  const ops = { sonda, fecharEditores, abrirCelula, escreverCelula,
                definirStatus, formato, imprimir };

  window.addEventListener('cms-ebm-req', (ev) => {
    let p;
    try { p = JSON.parse(ev.detail); } catch (e) { return; }
    const fn = ops[p.op];

    let r;
    if (!fn) r = { ok: false, erro: 'operação desconhecida: ' + p.op };
    else {
      try { r = { ok: true, valor: fn(p.args || {}) }; }
      catch (e) { r = { ok: false, erro: String(e && e.message || e) }; }
    }
    window.dispatchEvent(new CustomEvent('cms-ebm-res', {
      detail: JSON.stringify({ id: p.id, ...r }),
    }));
  });

  // Deixa a marca para o lado isolado saber que chegou até aqui.
  // Roda em document_start, quando o <html> às vezes ainda não existe —
  // sem a segunda tentativa a marca some e o outro lado desiste achando
  // que a extensão não carregou.
  function marcar() {
    try { document.documentElement.setAttribute('data-cms-ebm-main', '1'); return true; }
    catch (e) { return false; }
  }
  if (!marcar()) {
    document.addEventListener('DOMContentLoaded', marcar, { once: true });
    let n = 0;
    const t = setInterval(() => { if (marcar() || ++n > 40) clearInterval(t); }, 100);
  }
})();
