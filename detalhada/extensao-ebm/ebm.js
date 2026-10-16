/* ============================================================
   BRAÇO NO MUNDO ISOLADO
   ============================================================
   Roda em todas as páginas e frames de vulcabras.com.br/ebm4web.
   Cada cópia se identifica, pergunta ao orquestrador o que fazer e
   executa.

   Este arquivo enxerga o DOM mas NÃO as funções do EBM. Tudo que
   precisa de `selectCol`, `buttonClick`, `hideEdit` ou `printReport`
   é pedido ao `ebm-main.js`, que roda dentro da página.

   Criar uma tag <script> na página — o truque de sempre — não funciona
   aqui: o EBM tem CSP e recusa em silêncio. Nada avisa, o código
   simplesmente não roda. Foi o que travou o projeto por um dia inteiro,
   depurando uma lógica que nunca chegava a executar.

   O ROTEIRO REAL DA GRADE DE CRITÉRIOS
   ------------------------------------
   Gravado enquanto um usuário preenchia a linha na mão:

       selectRow(td)                     ← o onclick do próprio td
       selectCol(campo)
       campo.value = ...
       buttonClick(campo.parentNode, 'change')
              ↓ servidor
       ajaxShowEditContent('form1:webFilterGrid:row0:2')
       showEditContent(td, false, undefined)

   Ou seja: quem abre a coluna seguinte é o `buttonClick` da anterior.

   Armadilhas:
     · a grade só admite UM editor por vez, e enquanto o anterior está
       aberto nenhuma outra célula abre — por isso `fecharEditores`;
     · a coluna Tipo com "Selecione" (valor "*") fica LEGITIMAMENTE vazia
       depois de gravada, então conferir por igualdade dá falso negativo;
     · nas outras colunas o valor pode VOLTAR ao primeiro item depois do
       postback, então cada uma é conferida pelo texto gravado no td.
   ============================================================ */

(() => {
  const G = 'form1:webFilterGrid';

  const ID = {
    status:     'form1:cmbEncomendaStatus',
    consultar:  'form1:btnProcessar',
    pedidoLista:'form1:btnPedido',     // tela de lista (2+ encomendas)
    pedidoUm:   'form1:btnImprimir',   // tela de detalhe (1 encomenda)
    formato:    'com.vulcabras.webreportviewer.CMB_PRINTER',
    todasPags:  'optAllPages',
  };

  const COL = { TIPO: 0, CAMPO: 1, OPERADOR: 2, VALOR1: 3 };
  const TIPO_SELECIONE = '*';                    // rótulo "Selecione"
  const CAMPO_GCI = '.EncomendaGCI.encomendaGCI';
  const OPERADOR_IN = 'IN';      // INFORMADOS — para vários GCIs
  const OPERADOR_IGUAL = '=';    // para um GCI só
  const FORMATO_PDF = 'pdf';

  /* O que procurar no combo de status da consulta. O `value` vem primeiro,
     porque é exato; os rótulos ficam de reserva, para o dia em que o EBM
     trocar o código e ninguém avisar. 'T' é o "todos" — uma consulta só,
     mas o EBM reaproveita número de encomenda, e sem filtrar status a
     antiga vem junto com a nova: por isso 'T' não é o padrão. */
  const STATUS = {
    A: { candidatos: ['A'], padroes: ['abert', 'carteira', 'pendent'] },
    F: { candidatos: ['F'], padroes: ['fatur', 'encerrad', 'fechad', 'atendid'] },
    T: { candidatos: ['T'], padroes: ['^[^a-z]*tod[oa]s'] },
  };

  const DOC = Math.random().toString(36).slice(2, 10);
  const $ = (id) => document.getElementById(id);
  const espera = (ms) => new Promise(r => setTimeout(r, ms));

  function relatar(campos) {
    chrome.runtime.sendMessage({ de: 'cms-ebm-pagina', doc: DOC, url: location.href, ...campos })
      .catch(() => {});
  }

  async function ate(cond, ms = 15000, passo = 300) {
    const t0 = Date.now();
    for (;;) {
      let r; try { r = cond(); } catch (e) { r = null; }
      if (r) return r;
      if (Date.now() - t0 > ms) return null;
      await espera(passo);
    }
  }

  /* ---------- conversa com o mundo da página ---------- */

  let seq = 0;

  /** Pede uma operação ao `ebm-main.js` e espera a resposta.
   *  O payload vai como texto: objetos atravessam mal a fronteira entre
   *  os dois mundos, string atravessa sempre. */
  function naPagina(op, args = {}, ms = 8000) {
    return new Promise((resolve) => {
      const id = 'r' + (++seq);
      const prazo = setTimeout(() => {
        window.removeEventListener('cms-ebm-res', ouvir);
        resolve({ ok: false, erro: 'o mundo da página não respondeu' });
      }, ms);

      function ouvir(ev) {
        let r;
        try { r = JSON.parse(ev.detail); } catch (e) { return; }
        if (r.id !== id) return;
        clearTimeout(prazo);
        window.removeEventListener('cms-ebm-res', ouvir);
        resolve(r);
      }

      window.addEventListener('cms-ebm-res', ouvir);
      window.dispatchEvent(new CustomEvent('cms-ebm-req', {
        detail: JSON.stringify({ id, op, args }),
      }));
    });
  }

  const temMain = () => document.documentElement.getAttribute('data-cms-ebm-main') === '1';

  /* ---------- a grade de critérios ---------- */

  const idCelula = (linha, col) => `${G}:row${linha}:${col}`;
  const idCampo  = (linha, col) => `${G}:webGrid:txtInput:row${linha}:${col}`;
  const campoDa  = (linha, col) => $(idCampo(linha, col));
  const tdDa     = (linha, col) => $(idCelula(linha, col));

  /** O que já está GRAVADO na célula — o texto que aparece com ela fechada. */
  function textoCelula(linha, col) {
    const td = tdDa(linha, col);
    if (!td) return '';
    return (td.innerText || '').replace(/ /g, ' ').trim();
  }

  /** Quantas linhas a grade tem, pelo contador "1 - 6 / 6" da barra.
   *  Não dá para contar pelos campos: só existe um editor por vez. */
  function totalLinhas() {
    const alvo = $(`${G}:divMain`);
    const txt = (alvo ? alvo.innerText : document.body.innerText) || '';
    const m = txt.match(/(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
    return m ? Number(m[3]) : 0;
  }

  /** Índice da primeira linha que existe no DOM. */
  function primeiraLinha() {
    for (let i = 0; i < 60; i++) if (tdDa(i, 0)) return i;
    return -1;
  }

  /** Fotografa a grade. Só sai no log quando algo trava — mas aí é ela
   *  que evita mais um dia de tentativa e erro. */
  function radiografia(linha) {
    const p = [];
    for (let c = 0; c <= 4; c++) {
      const td = tdDa(linha, c), ed = campoDa(linha, c);
      if (!td && !ed) continue;
      let desc = `${c}:` + (td ? `td"${textoCelula(linha, c).slice(0, 22)}"` : 'sem-td');
      if (ed) {
        desc += `/editor<${ed.tagName}`;
        if (ed.tagName === 'SELECT') {
          desc += `=${JSON.stringify(ed.value)}[` +
            [...ed.options].slice(0, 4).map(o => o.value).join(',') + ']';
        }
        desc += '>';
      }
      p.push(desc);
    }
    return `linhas=${totalLinhas()} · ${p.join(' | ') || 'nada'}`;
  }

  /** Fecha o editor preso em outra coluna da linha.
   *
   *  A grade só admite um editor por vez, e enquanto o anterior está
   *  aberto nenhuma outra célula abre. No uso normal isso passa
   *  despercebido: o navegador tira o foco antes de entregar o clique, e
   *  o `onblur` (que é `hideEdit`) fecha a célula sozinho. Um `click()`
   *  por código não mexe no foco. */
  async function fecharEditores(linha, exceto) {
    const abertos = [];
    for (let c = 0; c <= 4; c++) if (c !== exceto && campoDa(linha, c)) abertos.push(c);
    if (!abertos.length) return false;

    const r = await naPagina('fecharEditores', { linha, cols: abertos });
    relatar({ aviso: `fechando editor: ${r.ok ? r.valor : r.erro}` });
    await espera(700);
    return true;
  }

  /** Abre a célula para edição.
   *  1. espera a cascata (o buttonClick da coluna anterior manda abrir)
   *  2. fecha o editor preso em outra coluna
   *  3. clica o td — é o onclick=selectRow(this), o caminho do usuário
   *  4. pede a abertura pelo ajax da própria grade */
  async function abrirCelula(linha, col) {
    const pelaCascata = await ate(() => campoDa(linha, col), 4000);
    if (pelaCascata) return pelaCascata;

    if (await fecharEditores(linha, col)) {
      const depois = await ate(() => campoDa(linha, col), 3000);
      if (depois) return depois;
    }

    const td = tdDa(linha, col);
    if (!td) return null;

    td.click();
    const peloClique = await ate(() => campoDa(linha, col), 5000);
    if (peloClique) return peloClique;

    const r = await naPagina('abrirCelula', { linha, col });
    relatar({ aviso: `abrindo a coluna ${col}: ${r.ok ? r.valor : r.erro}` });
    return await ate(() => campoDa(linha, col), 6000);
  }

  /** O que a célula tem agora, nas duas formas em que isso aparece.
   *
   *  Com o editor ABERTO, quem sabe da verdade é o `value` dele — o
   *  `innerText` do td devolve a lista inteira de opções do <select>,
   *  não a escolhida. Com o editor fechado, só resta o texto do td.
   */
  function valorDaCelula(linha, col) {
    const ed = campoDa(linha, col);
    return ed ? { valor: ed.value, texto: '' }
              : { valor: '', texto: textoCelula(linha, col) };
  }

  /** Preenche uma coluna.
   *
   *  `confere(valor, texto)` recebe as duas formas e aprova se qualquer
   *  uma bater. Quando é nulo, a escrita é dada por boa sem conferir — é
   *  o caso do Tipo, cujo "Selecione" deixa a célula vazia de propósito.
   */
  async function preencherColuna(linha, col, valor, rotulo, confere, tentativas = 3) {
    let ultimo = '';
    for (let n = 1; n <= tentativas; n++) {
      const campo = await abrirCelula(linha, col);
      if (!campo) {
        ultimo = 'a célula não abriu';
        relatar({ aviso: `GRADE: ${radiografia(linha)}` });
        const s = await naPagina('sonda');
        relatar({ aviso: `PÁGINA: ${s.ok ? s.valor : s.erro}` });
        await espera(700);
        continue;
      }

      const escrita = await naPagina('escreverCelula', { linha, col, valor });
      if (!escrita.ok || String(escrita.valor).startsWith('sem')) {
        ultimo = escrita.ok ? escrita.valor : escrita.erro;
        relatar({ aviso: `${rotulo}: ${ultimo}` });
        await espera(700);
        continue;
      }
      await espera(1400);            // o buttonClick foi ao servidor

      if (!confere) { relatar({ aviso: `${rotulo}: gravado` }); return true; }

      const { valor: v, texto: t } = valorDaCelula(linha, col);
      // a lista de opções de um select aberto é enorme; no log só cabe o começo
      const mostra = (v || t).replace(/\s+/g, ' ').trim().slice(0, 40);
      if (confere(v, t)) {
        relatar({ aviso: `${rotulo}: "${mostra}"${n > 1 ? ` (tentativa ${n})` : ''}` });
        return true;
      }
      ultimo = `ficou "${mostra}"`;
      relatar({ aviso: `${rotulo}: ${ultimo} — repetindo` });
      await espera(700);
    }
    throw new Error(`${rotulo}: ${ultimo}`);
  }

  /** Apaga as linhas de critério que sobraram da consulta anterior.
   *  Sem isso os GCIs antigos continuam no filtro. */
  async function limparCriterios() {
    for (let i = 0; i < 12 && totalLinhas() > 0; i++) {
      const del = $(`${G}:btnDelete`) ||
        [...document.querySelectorAll('img[alt*="excluir"], img[title*="excluir"]')][0];
      if (!del) break;
      (del.querySelector && del.querySelector('img') || del).click();
      await espera(900);
    }
    const sobrou = totalLinhas();
    if (sobrou) relatar({ aviso: `ainda sobraram ${sobrou} linha(s) de critério` });
    return sobrou === 0;
  }

  function botaoBarra(acao) {
    return [...document.querySelectorAll('img[onclick], a[onclick], input[onclick]')]
      .find(el => (el.getAttribute('onclick') || '').includes(`'${acao}'`));
  }

  /* ---------- que tela eu sou? ----------
     Por ELEMENTO, não por URL: a tela de detalhe de uma encomenda tem
     endereço parecido com a de lista, e o que as separa é o botão. */

  /** Este documento e o dos frames de mesma origem, em profundidade.
   *
   *  O visualizador monta a barra de ferramentas num frame e o relatório
   *  em outro. Um content script vive dentro de UM documento — se o
   *  disquete está no frame irmão, ele não existe para quem procura só
   *  aqui. O Selenium não sofre disso porque olha de fora e entra em cada
   *  frame; aqui a varredura tem que ser explícita. */
  function documentos(win = window, saida = [], nivel = 0) {
    try { if (win.document) saida.push(win.document); } catch (e) { return saida; }
    if (nivel >= 4) return saida;
    let n = 0;
    try { n = win.frames.length; } catch (e) { return saida; }
    for (let i = 0; i < n; i++) {
      try { documentos(win.frames[i], saida, nivel + 1); } catch (e) { /* outra origem */ }
    }
    return saida;
  }

  /** O disquete da barra do visualizador. Não tem id: é reconhecido pelo
   *  arquivo de imagem, em qualquer frame alcançável. */
  function disquete() {
    for (const d of documentos()) {
      let img;
      try {
        img = [...d.images].find(i => /save/i.test(i.getAttribute('src') || ''));
      } catch (e) { continue; }
      if (img) return img;
    }
    return null;
  }

  /** O combo de formato da janela "Salvar como".
   *
   *  Tem que ser um <select> DE VERDADE: o ReportViewer.jsp carrega um
   *  input escondido com esse mesmo id, e um frame dele chegava a se
   *  declarar "tela de formato" antes do printOptions.html abrir —
   *  roubando o passo da janela que interessa. */
  const comboFormato = () => {
    const el = $(ID.formato);
    if (el && el.tagName === 'SELECT') return el;
    return document.querySelector('select[id*="CMB_PRINTER"], select[name*="CMB_PRINTER"]');
  };

  /** Estamos na porta de entrada?
   *
   *  `j_username`/`j_password` são os nomes do login de formulário do
   *  Tomcat, mas nem toda tela do EBM os usa — e quando não usa, ninguém
   *  reconhecia o login e o vendedor deslogado ficava esperando em
   *  silêncio. Um campo de senha à vista já basta como sinal. */
  function telaDeLogin() {
    return $('j_username') || $('j_password') ||
      [...document.querySelectorAll('input[type=password]')].some(i => i.offsetParent);
  }

  function identificar() {
    if (telaDeLogin()) return 'LOGIN';
    if (comboFormato()) return 'FORMATO';
    if ($(ID.pedidoLista)) return 'RESULTADO';
    if ($(ID.pedidoUm)) return 'DETALHE';
    if ($(ID.consultar) && $(G)) return 'CONSULTA';

    // A barra de ferramentas do visualizador mora num frame separado do
    // ReportViewerLoader. Quem se declara visualizador tem que ser o
    // frame que REALMENTE tem o disquete — senão o de fora pega o passo
    // e depois não acha o ícone em lugar nenhum.
    if (disquete()) return 'VISUALIZADOR';
    if (/ReportViewer/i.test(location.href) &&
        !document.querySelector('frame, iframe')) return 'VISUALIZADOR';
    return null;
  }

  /* ---------- as ações ---------- */

  const acoes = {
    /** Preenche a tela de login com o que a extensão guardou e entra.
     *  Os ids são os mesmos que os robôs Python usam (ebm_core.py):
     *  j_username, j_password e o botão de nome form1:btnOK.
     *  A senha nunca vai para o log. */
    async login(cmd) {
      const usuario = $('j_username') ||
        [...document.querySelectorAll('input[type=text], input:not([type])')].find(i => i.offsetParent);
      const senha = $('j_password') ||
        [...document.querySelectorAll('input[type=password]')].find(i => i.offsetParent);
      if (!usuario || !senha) throw new Error('não achei os campos da tela de login');

      // Um alerta depois do login ("senha expira em N dias", sessão ativa em
      // outro lugar) trancaria a aba escondida. A marca faz o ebm-main.js
      // aceitar esses avisos sozinho — só nas janelas deste trabalho.
      try { sessionStorage.setItem('cmsSilenciar', '1'); } catch (e) { /* segue */ }

      const escrever = (el, v) => {
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      escrever(usuario, cmd.usuario);
      escrever(senha, cmd.senha);
      await espera(250);

      const botao = document.getElementsByName('form1:btnOK')[0] || $('form1:btnOK') ||
        document.querySelector('input[type=submit], button[type=submit]');
      relatar({ aviso: 'login preenchido; entrando' });
      if (botao) botao.click();
      else (senha.form || usuario.form).submit();
    },

    /** Monta o filtro: status, linha, Tipo, Campo, Operador, Valor.
     *  Dá para encadear porque as colunas abrem por ajax, sem recarregar
     *  a página — só a criação da linha é que recarrega. */
    async consulta(cmd) {
      const status = cmd.status || 'A';

      // O status vem ANTES da linha: mudá-lo depois recarrega a tela e
      // derruba o critério já montado.
      //
      // Quem pede faturado tem de receber faturado: não achando a opção no
      // combo, a consulta para aqui. Antes ela seguia no status em que
      // estava, e o PDF do faturado saía com a carteira dentro.
      const st = await ate(() => $(ID.status));
      if (st) {
        const alvo = STATUS[status] || STATUS.A;
        const r = await naPagina('definirStatus',
          { id: ID.status, valor: status, ...alvo, obrigatorio: status !== 'A' });
        if (!r.ok) throw new Error('status da consulta: ' + r.erro);
        const v = r.valor || {};
        relatar({ aviso: `status ${status}: ${v.texto || v}` });
        if (v.mudou) await espera(900);
      }

      // Sobras da consulta anterior atrapalham o filtro
      if (totalLinhas() > 0 && primeiraLinha() < 0) await limparCriterios();

      // Sem linha nenhuma: cria uma. Isso recarrega — o roteiro volta aqui.
      if (totalLinhas() === 0) {
        const novo = $(`${G}:btnNew`) || botaoBarra('new');
        if (!novo) throw new Error('não achei o botão de nova linha de critério');
        relatar({ aviso: 'criando a linha de critério' });
        (novo.querySelector && novo.querySelector('img') || novo).click();
        return;
      }

      const linha = primeiraLinha();
      if (linha < 0) throw new Error('a linha de critério não ficou utilizável');

      // Um GCI usa "=", vários usam INFORMADOS
      const umSo = cmd.gcis.length === 1;
      const operador = umSo ? OPERADOR_IGUAL : OPERADOR_IN;
      const valor = cmd.gcis.join(',');
      relatar({ aviso: `linha ${linha} · ${umSo ? 'IGUAL' : 'INFORMADOS'} · ${valor}` });

      // "Selecione" grava vazio de propósito: não dá para conferir, e uma
      // tentativa basta — o que importa é o buttonClick que abre a coluna 1.
      try { await preencherColuna(linha, COL.TIPO, TIPO_SELECIONE, 'Tipo', null, 1); }
      catch (e) { relatar({ aviso: `Tipo: ${e.message} — seguindo` }); }

      // "Número Encomenda GCI": o GCI no fim separa do "Número Encomenda EBM",
      // que é o primeiro da lista e para onde o campo volta quando não pega
      await preencherColuna(linha, COL.CAMPO, CAMPO_GCI, 'Campo',
        (v, t) => v === CAMPO_GCI || /encomenda\s*gci/i.test(t));
      await preencherColuna(linha, COL.OPERADOR, operador, 'Operador',
        (v, t) => v === operador ||
          (umSo ? /^(igual|=)$/i : /^(informados|in)$/i).test(t.trim()));
      await preencherColuna(linha, COL.VALOR1, valor, 'Valor',
        (v, t) => v === valor || t.includes(cmd.gcis[0]));

      // O campo de valor é texto, e num <input> da grade é o `hideEdit`
      // que grava o que foi digitado. Consultar com ele aberto correria o
      // risco de buscar sem o GCI.
      await fecharEditores(linha, -1);

      // SÓ AGORA dá para conferir, e é preciso conferir GCI a GCI.
      //
      // Com o editor ABERTO, `valorDaCelula` devolve o `value` do input — o
      // que esta extensão acabou de escrever. Conferir ali é perguntar a ela
      // mesma: aprova sempre, inclusive quando o EBM não ficou com nada
      // daquilo. Foi assim que 22 GCIs viraram um PDF com um pedido só, sem
      // nenhum aviso. Fechado o editor, quem responde é a célula — que é
      // exatamente o que a consulta vai usar.
      if (!umSo) {
        const gravado = String(textoCelula(linha, COL.VALOR1) || '');
        const dentro = cmd.gcis.filter(g => gravado.includes(g));
        // Nenhum GCI à vista não quer dizer campo vazio: quer dizer que esta
        // célula não mostra o valor, e então não dá para conferir por aqui.
        // Tomar isso por corte faria a lista ser fatiada em arquivos de um
        // GCI, quebrando o que hoje funciona. A prova de corte é outra: a
        // célula mostra parte da lista e pára no meio.
        if (!dentro.length) {
          relatar({ aviso: 'a célula do valor não mostra os GCIs — seguindo sem conferir' });
        } else if (dentro.length < cmd.gcis.length) {
          const faltam = cmd.gcis.filter(g => !gravado.includes(g));
          relatar({ aviso: `a célula ficou com ${gravado.length} caracteres dos ${valor.length} escritos` });
          // `cabem` volta para a Detalhada, que refaz o arquivo em lotes desse
          // tamanho. O limite do campo não está escrito em lugar nenhum: ele
          // se descobre assim, uma vez, e fica guardado.
          relatar({
            erro: `o campo do EBM ficou com ${dentro.length} de ${cmd.gcis.length} GCIs ` +
                  `(faltou ${faltam.slice(0, 3).join(', ')}${faltam.length > 3 ? '…' : ''}) ` +
                  '— é o limite de tamanho do campo',
            codigo: 'gcis-nao-couberam',
            cabem: Math.max(1, dentro.length),
          });
          return;
        } else {
          relatar({ aviso: `os ${cmd.gcis.length} GCIs entraram no campo` });
        }
      }

      // O operador pela mesma régua. Se o EBM não aceitou INFORMADOS e
      // voltou para IGUAL, a consulta procura um texto cheio de vírgulas:
      // acha uma encomenda, ou nenhuma, e o PDF sai parecendo certo.
      // Só acusa quando dá para ler os dois lados: a célula diz um operador
      // conhecido e ele é o outro. Um texto que não é nem um nem outro é
      // célula ilegível, não operador errado — e aí segue, com o aviso.
      const opGravado = String(textoCelula(linha, COL.OPERADOR) || '').trim();
      const ehIgual = /^(igual|=)$/i.test(opGravado);
      const ehLista = /^(informados|in)$/i.test(opGravado);
      if (ehIgual || ehLista) {
        if (umSo !== ehIgual) {
          throw new Error(`o operador do EBM ficou em "${opGravado}" e não em ` +
            `${umSo ? 'IGUAL' : 'INFORMADOS'} — a consulta sairia errada`);
        }
      } else if (opGravado) {
        relatar({ aviso: `operador da célula: "${opGravado}" — não dá para conferir` });
      }

      relatar({ aviso: 'consultando' });
      const btn = await ate(() => $(ID.consultar));
      if (!btn) throw new Error('não achei o botão consultar');
      btn.click();
    },

    /** Lista com várias encomendas: marca todas e abre o pedido.
     *
     *  As caixas nascem DESMARCADAS. O script em Python diz o contrário
     *  num comentário, e foi essa frase que me fez caçar o defeito no
     *  lugar errado por horas: as telas mostravam tudo marcado porque era
     *  o próprio roteiro que marcava, e eu lia aquilo como "já vinha
     *  assim".
     *
     *  São caixas comuns, sem `onclick` — marcar não dispara postback
     *  nenhum. Por isso marcar e clicar acontece na MESMA passada: numa
     *  versão anterior eu marcava e devolvia o passo, esperando um
     *  recarregamento que nunca vinha, e a lista ficava pronta na tela
     *  aguardando um clique que não vinha junto. */
    async resultado(cmd) {
      const caixas = () => [...document.querySelectorAll('input[type=checkbox][id*=":grdGrid:"]')]
        .filter(c => !c.disabled && /:row\d+:/.test(c.id));

      const cbs = await ate(() => { const c = caixas(); return c.length ? c : null; }, 10000) || [];
      if (!cbs.length) throw new Error('a consulta não trouxe encomendas para esses GCIs');
      // Quantas a consulta trouxe, contra quantas foram pedidas: e a linha do
      // log que separa "o EBM nao achou" de "o roteiro nao marcou".
      const pedidos = (cmd && Array.isArray(cmd.gcis)) ? cmd.gcis.length : null;
      relatar({ aviso: `a consulta trouxe ${cbs.length} encomenda(s)` +
        (pedidos ? ` para ${pedidos} GCI(s) pedidos` : '') });
      // Vir menos do que se pediu aqui não é corte de campo (o critério já
      // foi conferido inteiro): é encomenda que o EBM não tem nesse status.
      // Segue, mas dito em voz alta — o PDF vai sair sem elas.
      if (pedidos && cbs.length < pedidos) {
        relatar({ aviso: `ATENÇÃO: ${pedidos - cbs.length} GCI(s) não apareceram na ` +
          'consulta e ficam de fora do PDF' });
      }

      /* Marcar as 22, e não só a última.
       *
       *  O comentário antigo dizia que as caixas são comuns e que marcar não
       *  dispara postback. Nesta tela não é bem assim: clicando nas 22 em
       *  sequência, só a última ficava marcada — cada clique desfazia o
       *  anterior. A consulta trazia as 22 ("1 - 22 / 22" na barra da grade),
       *  e mesmo assim o PDF saía com um pedido só.
       *
       *  Então: a caixa do cabeçalho primeiro, que marca a grade inteira numa
       *  tacada; o que sobrar, uma a uma, reconferindo a cada volta; e, se a
       *  conta não fechar, para aqui. */
      const marcarTodas = () =>
        [...document.querySelectorAll('input[type=checkbox][id*=":grdGrid:"]')]
          .find(c => !c.disabled && !/:row\d+:/.test(c.id));

      const quantas = () => caixas().length;
      const marcadasAgora = () => caixas().filter(c => c.checked).length;

      const topo = marcarTodas();
      if (topo && marcadasAgora() < quantas()) {
        relatar({ aviso: 'marcando pela caixa do cabeçalho' });
        // Ela é um interruptor: estando ligada, um clique desliga tudo. Passar
        // pelo desligado garante que o próximo clique ligue a grade inteira.
        if (topo.checked) { topo.click(); await espera(350); }
        topo.click();
        await espera(800);
        relatar({ aviso: `pelo cabeçalho: ${marcadasAgora()} de ${quantas()}` });
      }

      for (let volta = 1; volta <= 3 && marcadasAgora() < quantas(); volta++) {
        const antes = marcadasAgora();
        const faltam = caixas().filter(c => !c.checked);
        relatar({ aviso: `volta ${volta}: faltam ${faltam.length} de ${quantas()}` });
        for (const c of faltam) { c.click(); await espera(70); }
        await espera(500);
        // Uma volta que não adiantou é a assinatura da grade em que o clique
        // desfaz o anterior: insistir só gastaria tempo.
        if (marcadasAgora() <= antes) break;
      }

      // Ainda faltando: marcar sem clicar. O que desfaz a seleção é o clique;
      // o estado da caixa é o que vai no POST do "visualizar pedido". Fica por
      // último porque é o caminho que menos se parece com uma pessoa usando a
      // tela — mas é melhor do que um PDF pela metade.
      if (marcadasAgora() < quantas()) {
        relatar({ aviso: 'marcando sem clicar (o clique desta grade desfaz o anterior)' });
        for (const c of caixas()) {
          if (!c.checked) {
            c.checked = true;
            c.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        await espera(500);
      }

      const total = quantas();
      const marcadas = marcadasAgora();
      if (!marcadas) throw new Error('não consegui marcar as encomendas da lista');
      // Marcar parte e seguir era o pior dos mundos: saía um PDF com cara de
      // completo e menos pedidos dentro, e ninguém tinha como desconfiar.
      if (marcadas < total) {
        throw new Error(`marquei ${marcadas} de ${total} encomendas da lista — ` +
          'o PDF sairia incompleto');
      }

      const btn = await ate(() => $(ID.pedidoLista), 8000);
      if (!btn) throw new Error('não achei o botão "visualizar pedido"');
      relatar({ aviso: `${marcadas} de ${total} marcadas · clicando em visualizar pedido` });
      btn.click();
    },

    /** Um GCI só: o EBM já abre o detalhe, e o botão é outro. */
    async detalhe(cmd) {
      // O EBM só pula para o detalhe quando a consulta achou UMA encomenda.
      // Tendo pedido várias, isso é a prova de que o filtro saiu curto — e o
      // PDF sairia com um pedido só, com cara de completo. Melhor parar aqui.
      const pedidos = (cmd && Array.isArray(cmd.gcis)) ? cmd.gcis.length : 1;
      if (pedidos > 1) {
        // Uma encomenda de várias pedidas não acontece por acaso: é o campo
        // que cortou sem a célula deixar ver. Em vez de parar, devolve a
        // metade — a Detalhada refaz nesse tamanho e, se também não couber,
        // volta a partir pela metade. Em quatro ou cinco idas acha o limite
        // do campo sem nunca gerar um arquivo errado pelo caminho.
        relatar({
          erro: `a consulta trouxe uma encomenda só para ${pedidos} GCIs pedidos ` +
                '— o filtro do EBM não ficou com a lista inteira',
          codigo: 'gcis-nao-couberam',
          cabem: Math.max(1, Math.floor(pedidos / 2)),
        });
        return;
      }
      relatar({ aviso: 'tela de detalhe (uma encomenda)' });
      const btn = await ate(() => $(ID.pedidoUm));
      if (!btn) throw new Error('não achei o botão de visualizar pedido');
      btn.click();
    },

    /** No visualizador: o disquete da barra. */
    async exportar() {
      const img = await ate(disquete, 60000);
      if (!img) {
        const vistas = documentos().flatMap(d => {
          try { return [...d.images]; } catch (e) { return []; }
        }).slice(0, 10).map(i => (i.getAttribute('src') || '').split('/').pop());
        throw new Error(`o ícone de salvar não apareceu em ${documentos().length} frame(s) ` +
          `(imagens: ${vistas.join(', ') || 'nenhuma'})`);
      }
      // o clicável costuma ser o <a> ou a célula em volta, não a imagem
      const alvo = img.closest('a, [onclick]') || img;
      relatar({ aviso: `disquete: clicando em <${alvo.tagName.toLowerCase()}>` });
      alvo.click();
    },

    /** Janela de opções: Adobe PDF, todas as páginas, e OK. */
    async confirmar() {
      // A janela abre com o combo VAZIO e as opções chegam depois. Chegar
      // antes disso faz escolher nada, e o EBM responde "Tipo de
      // exportação selecionado é inválido" num alerta que trava tudo.
      const combo = await ate(() => {
        const c = comboFormato();
        return c && c.options.length > 1 ? c : null;
      }, 30000);
      if (!combo) {
        const c = comboFormato();
        throw new Error(c ? 'o combo de formato ficou sem opções'
                          : 'não achei o combo de formato');
      }
      relatar({ aviso: `opções: ${Array.from(combo.options).map(o => o.text).join(' / ')}` });

      const f = await naPagina('formato', {
        idCombo: ID.formato, idTodas: ID.todasPags, valor: FORMATO_PDF });
      // sem formato não se manda imprimir: o alerta de erro tranca a janela
      if (!f.ok) throw new Error(`formato: ${f.erro}`);
      relatar({ aviso: `formato: ${f.valor}` });
      await espera(500);

      const i = await naPagina('imprimir');
      if (!i.ok) throw new Error(`OK: ${i.erro}`);
      relatar({ aviso: `${i.valor} — aguardando o download` });
    },
  };

  /** Pergunta o que fazer nesta tela e executa. */
  async function rodar(tela) {
    if (!temMain()) {
      relatar({ erro: 'o braço dentro da página não carregou — recarregue a extensão' });
      return;
    }

    let cmd;
    try {
      // O `doc` leva a tela junto. O orquestrador entrega um comando por
      // documento, e quando a lista aparece sem recarregar a página o
      // documento continua o mesmo — ele responderia "já atendi" e o
      // roteiro morreria no mesmo ponto de sempre.
      cmd = await chrome.runtime.sendMessage({
        de: 'cms-ebm-pagina', tela, doc: `${DOC}:${tela}`, url: location.href });
    } catch (e) { return; }

    if (!cmd || cmd.acao === 'nada') return;
    const fn = acoes[cmd.acao];
    if (!fn) return;

    try { await fn(cmd); }
    catch (e) { relatar({ erro: `${tela}/${cmd.acao}: ${e.message || e}` }); }
  }

  /* ---------- laço principal ----------
     A tela muda de duas formas no EBM, e por muito tempo eu só enxergava
     uma delas:

       · carregando outra página — com 1 GCI, o detalhe abre assim;
       · trocando o conteúdo do MESMO documento — com vários GCIs, a
         lista de encomendas aparece assim, sem recarregar nada.

     Rodando uma vez por carregamento, o segundo caso passava batido: o
     script já tinha se apresentado como "tela de consulta" e nunca mais
     olhava. A lista ficava pronta na tela, esperando um clique que não
     vinha. Por isso aqui a vigilância é contínua, e o que dispara uma
     ação é a tela MUDAR, não a página carregar. */

  // O Chrome barrou uma janela do EBM: sem ela o roteiro não anda.
  // Vale o que aconteceu antes de este script carregar (a marca na página)
  // e o que acontecer depois (o evento).
  let popupAvisado = false;
  const avisarPopup = (url) => {
    if (popupAvisado) return;
    popupAvisado = true;
    relatar({ erro: 'O Chrome bloqueou uma janela do EBM (pop-up).', codigo: 'popup-bloqueado',
              aviso: `janela barrada: ${String(url || '').split('/').pop() || '(sem endereço)'}` });
  };
  if (document.documentElement.dataset.cmsPopupBloqueado) avisarPopup(document.documentElement.dataset.cmsPopupBloqueado);
  window.addEventListener('cms-ebm-popup-bloqueado', (ev) => avisarPopup(ev.detail));

  let telaAtendida = null;
  let ocupado = false;

  function tentar() {
    if (ocupado) return;                       // uma ação por vez
    const tela = identificar();
    if (!tela || tela === telaAtendida) return;

    telaAtendida = tela;
    ocupado = true;
    rodar(tela).finally(() => { ocupado = false; });
  }

  tentar();
  const vigia = setInterval(tentar, 700);
  // o trabalho inteiro tem prazo de 8 minutos; depois disso é só desperdício
  setTimeout(() => clearInterval(vigia), 10 * 60 * 1000);
})();
