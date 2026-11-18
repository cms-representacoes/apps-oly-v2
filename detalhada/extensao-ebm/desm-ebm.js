/* ============================================================
   DESMEMBRAMENTO — DENTRO DO EBM
   ============================================================
   Mesmo desenho do ebm.js: a página se apresenta ("cheguei na tela X"),
   o orquestrador responde o que fazer, e quem lembra o ponto do roteiro
   é o background — este script morre a cada postback do EBM.

   Esta versão só CONFERE: abre cada pedido mãe, lê os artigos da tela e
   devolve o que encontrou. Não marca, não digita, não salva, não gera.
   As telas de digitação virão depois, uma de cada vez.

   As telas (ids tirados do robô CMS_DESMEMBRA, que já os provou):
     RESULTADO    lista de pedidos mãe   → btnManter, sem o salvar da manutenção
     MANUTENCAO   o pedido aberto        → btnSalvarDesmembramento
     ITEM         "manter itens"         → btnSalvar + grdGrid1, sem o salvar acima
     LOGIN        sessão caiu
   ============================================================ */

(() => {
  const ID = {
    btnManter:   'form1:btnManter',
    btnSalvarDesm: 'form1:btnSalvarDesmembramento',
    btnSalvarItem: 'form1:btnSalvar',
    grdResultado:'form1:grdGrid',
    grdArtigo:   'form1:grdArtigoPedidoMae',
    grdDesm:     'form1:grdArtigoDesmembramento',
    grdDigit:    'form1:grdDigitacaoDesmembramento',
    grdItens:    'form1:grdGrid1',
    btnAdd:      'form1:btnAdicionarArtigo',
    grdGrupo:    'form1:grdGrupoComercial',
    grdCarteira: 'form1:grdClienteCarteira',
    filtroCod:   'form1:txtFiltroCodigo',
    filtroGrid:  'form1:webFilterGrid',
    voltar:      ['form1:btnVoltar1', 'form1:btnVoltar2'],
  };

  const DOC = Math.random().toString(36).slice(2, 10);
  const $ = (id) => document.getElementById(id);
  const espera = (ms) => new Promise(r => setTimeout(r, ms));

  const telaDeLogin = () =>
    $('j_username') || $('j_password') ||
    [...document.querySelectorAll('input[type=password]')].some(i => i.offsetParent);

  function identificar() {
    if (telaDeLogin()) return 'LOGIN';
    if ($(ID.btnSalvarDesm)) return 'MANUTENCAO';
    if ($(ID.btnSalvarItem) && $(ID.grdItens)) return 'ITEM';
    if ($(ID.btnManter)) return 'RESULTADO';
    if ($(ID.filtroGrid) && botaoConsultar()) return 'CONSULTA';
    if (linkDesmembrar() || $('form1:txtFuncionalidade')) return 'MENU';
    return null;
  }

  const botaoConsultar = () =>
    porXPath("//input[@value='consultar'] | //button[contains(.,'consultar')]"
           + " | //a[contains(.,'consultar')]")[0] || null;

  const linkDesmembrar = () =>
    porXPath("//a[contains(normalize-space(.),'Desmembrar Pedido')]")[0] || null;

  /** Célula da grade de critérios (linha 0, coluna 0..3). */
  const criterio = (col) => $(`${ID.filtroGrid}:webGrid:txtInput:row0:${col}`);

  /** Escolhe a opção de um select pelo texto e avisa a página.
   *  O EBM monta o próximo campo por ajax ao receber o change. */
  function escolher(sel, texto, contendo) {
    const alvo = [...sel.options].find(o => contendo
      ? o.text.toUpperCase().includes(texto.toUpperCase())
      : o.text.trim().toUpperCase() === texto.toUpperCase());
    if (!alvo) return false;
    if (sel.value === alvo.value) return true;
    sel.value = alvo.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /* ---------- leitura das grades ---------- */

  const linhasDe = (gridId) => {
    // o EBM monta ids compostos; o robô sempre procura por "contém"
    const tb = $(gridId) || porXPath(`//*[contains(@id,'${gridId.split(':').pop()}')]`)[0];
    if (!tb) return [];
    return [...tb.querySelectorAll(':scope > tbody > tr, :scope > tr')];
  };
  const celulas = (tr) => [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim());

  /** Os artigos do pedido mãe, como o robô os lê:
   *  [ordem, código, descrição, cor, grade, tam. inicial, total, saldo] */
  function artigosDaTela() {
    const out = [];
    linhasDe(ID.grdArtigo).forEach((tr, i) => {
      const c = celulas(tr);
      if (c.length >= 8) {
        out.push({ linha: i, codigo: c[1], produto: c[2], cor: c[3],
                   grade: c[4], tamInicial: c[5], total: c[6], saldo: c[7] });
      }
    });
    return out;
  }

  /** Pedido mãe e cliente de origem, lidos do cabeçalho da tela. */
  function cabecalho() {
    const corpo = document.body ? document.body.innerText : '';
    const ped = corpo.match(/Pedido M[aã]e:\s*(\d+)/i);
    const cli = corpo.match(/Cliente:\s*(\d+)/i);
    return { pedido: ped ? ped[1] : '', clienteOrigem: cli ? cli[1] : '' };
  }

  /** Mensagens que a tela está exibindo — é por elas que o EBM recusa. */
  function mensagensDaTela() {
    const out = [];
    const sel = "span[id*='msg'], span[class*='msg'], td[class*='msg'], "
              + ".msgError, .message, div[class*='erro']";
    for (const el of document.querySelectorAll(sel)) {
      const t = (el.innerText || '').trim();
      if (t && !out.includes(t)) out.push(t.slice(0, 160));
    }
    // textos fixos das telas não são resposta do EBM
    return out.filter(m => !/maque os artigos|marque os artigos|para manter\/consultar/i.test(m));
  }

  /** Em que linha da lista está o pedido mãe (ou -1). */
  function acharLinha(ebm) {
    return linhasDe(ID.grdResultado)
      .findIndex(tr => celulas(tr).some(x => x === String(ebm)));
  }

  /** Marca a linha nos campos escondidos do grid (sem postback). */
  function marcarLinha(alvo) {
    const sel = $(`${ID.grdResultado}:selRow`);
    const old = $(`${ID.grdResultado}:selOldRow`);
    if (sel) sel.value = String(alvo + 1);
    if (old) old.value = String(alvo + 1);
  }

  /* ---------- ações ---------- */

  const acoes = {
    /** Primeira metade: marcar a linha do pedido.
     *  A seleção só vale no servidor depois de um postback do próprio
     *  grid — é o que o clique manual dispara. Emular isso pelos campos
     *  escondidos é o caminho que o robô provou funcionar. O postback
     *  mata este script; o clique em "manutenção" vem na próxima vida
     *  da página, pelo comando seguinte. */
    async selecionarLinha(cmd) {
      const alvo = acharLinha(cmd.ebm);
      if (alvo < 0) {
        relatar({ tela: 'RESULTADO', resultado: 'nao-achou', ebm: cmd.ebm,
                  texto: `o pedido ${cmd.ebm} não está na lista desta consulta` });
        return;
      }
      marcarLinha(alvo);
      const ev = document.getElementsByName('com.vulcabras.isWebGridEvent')[0];
      if (ev) ev.value = 'true';
      const gi = document.getElementsByName('com.vulcabras.webgrid.GRID_ID')[0];
      if (gi) gi.value = ID.grdResultado;
      const form = document.forms['form1'];
      if (form) form.submit();
    },

    /** Segunda metade: a lista voltou do postback; reforça a marca e
     *  abre. Sem reforçar, o EBM responde "selecione um Pedido Mãe". */
    async clicarManter(cmd) {
      const alvo = acharLinha(cmd.ebm);
      if (alvo < 0) {
        relatar({ tela: 'RESULTADO', resultado: 'nao-achou', ebm: cmd.ebm,
                  texto: `o pedido ${cmd.ebm} sumiu da lista` });
        return;
      }
      marcarLinha(alvo);
      await espera(300);
      const b = $(ID.btnManter);
      if (!b) { relatar({ tela: 'RESULTADO', erro: 'botão de manutenção sumiu' }); return; }
      b.click();
    },

    /** Lê o pedido aberto e devolve tudo o que a conferência precisa.
     *  A grade de artigos às vezes chega depois da tela: por isso a
     *  espera por conteúdo em vez de um tempo fixo. */
    async lerPedido(cmd) {
      let artigos = [];
      for (let i = 0; i < 12 && !artigos.length; i++) {
        artigos = artigosDaTela();
        if (!artigos.length) await espera(400);
      }
      const cab = cabecalho();
      relatar({
        tela: 'MANUTENCAO', resultado: 'leitura', ebm: cmd.ebm,
        dados: {
          pedidoNaTela: cab.pedido,
          clienteOrigem: cab.clienteOrigem,
          artigos,
          digitacoesExistentes: linhasDe(ID.grdDigit).length,
          pendenteNaTela: linhasDe(ID.grdDesm).length,
          mensagens: mensagensDaTela(),
        },
      });
      /* Ler não muda a tela, então ela não falaria de novo e o roteiro
         pararia aqui. É a volta para a lista que faz o EBM recarregar e
         o próximo pedido começar. */
      if (cmd.voltarDepois !== false) {
        await espera(300);
        await acoes.voltar();
      }
    },

    /** Volta para a lista de pedidos. */
    async voltar() {
      for (const id of ID.voltar) {
        const b = $(id);
        if (b) { b.click(); return; }
      }
      relatar({ tela: 'MANUTENCAO', erro: 'não achei o botão de voltar' });
    },

    /** A sessão caiu (ou nunca existiu): entra com o que a extensão
     *  guarda. É o mesmo login que o PDF já usa; a senha não aparece no
     *  log em lugar nenhum. */
    async login(cmd) {
      const u = $('j_username')
        || [...document.querySelectorAll('input[type=text], input:not([type])')].find(i => i.offsetParent);
      const p = $('j_password')
        || [...document.querySelectorAll('input[type=password]')].find(i => i.offsetParent);
      if (!u || !p) { relatar({ tela: 'LOGIN', erro: 'não achei os campos de login' }); return; }
      try { sessionStorage.setItem('cmsSilenciar', '1'); } catch (e) { /* segue */ }
      escrever(u, cmd.usuario);
      escrever(p, cmd.senha);
      await espera(300);
      const b = document.getElementsByName('form1:btnOK')[0] || $('form1:btnOK')
        || document.querySelector('input[type=submit], button[type=submit]');
      if (b) b.click();
    },

    /** Do menu até a tela de critérios do Desmembrar Pedido Mãe. */
    async irParaConsulta() {
      const link = linkDesmembrar();
      if (link) { link.click(); return; }
      const f = $('form1:txtFuncionalidade');
      if (f) {
        escrever(f, 'FUC1515');
        const ok = $('form1:btnFuncionalidadeOK');
        if (ok) { ok.click(); return; }
      }
      relatar({ tela: 'MENU', erro: 'não achei como abrir o Desmembrar Pedido Mãe' });
    },

    /** Monta o critério e consulta — a mesma receita do robô:
     *  Encomenda | Número Encomenda EBM | INFORMADOS | os EBMs. Cada
     *  escolha traz o campo seguinte por ajax, então é tudo numa ação
     *  só, esperando campo a campo. */
    async montarConsulta(cmd) {
      const passos = [
        { col: 0, txt: 'Encomenda', proximo: 1, rot: 'Tipo' },
        { col: 1, txt: 'Número Encomenda EBM', proximo: 2, rot: 'Campo' },
        { col: 2, txt: 'INFORMADO', proximo: 3, rot: 'Operador', contendo: true },
      ];
      for (const p of passos) {
        let sel = criterio(p.col);
        for (let t = 0; t < 6 && !sel; t++) { await espera(700); sel = criterio(p.col); }
        if (!sel) { relatar({ tela: 'CONSULTA', erro: `o campo ${p.rot} não apareceu` }); return; }
        if (!escolher(sel, p.txt, p.contendo)) {
          relatar({ tela: 'CONSULTA', erro: `não achei "${p.txt}" em ${p.rot}` });
          return;
        }
        let ok = false;
        for (let t = 0; t < 12 && !ok; t++) { await espera(700); ok = !!criterio(p.proximo); }
        if (!ok) { relatar({ tela: 'CONSULTA', erro: `${p.rot}: a tela não trouxe o campo seguinte` }); return; }
      }
      const valor = criterio(3);
      if (!valor) { relatar({ tela: 'CONSULTA', erro: 'o campo de valor não apareceu' }); return; }
      escrever(valor, (cmd.ebms || []).join(','));
      await espera(600);
      const btn = botaoConsultar();
      if (!btn) { relatar({ tela: 'CONSULTA', erro: 'não achei o botão consultar' }); return; }
      relatar({ tela: 'CONSULTA', resultado: 'consultando',
                texto: `Encomenda | Número Encomenda EBM | INFORMADOS | ${(cmd.ebms || []).join(',')}` });
      btn.click();
    },

    /* ---- PILOTO, em três etapas ----
       Escrever na tela do EBM dispara postback: o script morre e a
       página volta nova. Por isso cada etapa termina onde o EBM
       recarrega, e a próxima fala da página retoma dali. Tentar fazer
       tudo de uma vez criou oito linhas de cliente no primeiro teste. */

    /** 1ª etapa: tela limpa, aba aberta, linha criada e código escrito.
     *  Termina no postback que o EBM dá ao receber o código. */
    async informarCliente(cmd) {
      const C = cmd.cliente || {};
      await naPaginaDesm('ligar');

      if (linhasDe(ID.grdDesm).length) {
        const canc = $('form1:btnCancelarDesmembramento');
        if (canc) {
          relatar({ tela: 'MANUTENCAO', resultado: 'limpou', ebm: cmd.ebm,
                    texto: 'havia uma digitação pela metade; cancelei para começar limpo' });
          canc.click();
          return;
        }
      }

      const r = await informarClienteFinal(C.cod);
      if (!r.ok) { await falhou(cmd, r.erro, r.diag); return; }
      // se não houve postback, a própria conferência segue na etapa 2
      relatar({ tela: 'MANUTENCAO', resultado: 'cliente-ok', ebm: cmd.ebm,
                cod: C.cod, razao: r.razao });
    },

    /** 2ª etapa: a página voltou do postback — conferir que o cliente
     *  está lá e deixar só ele marcado. */
    async marcarCliente(cmd) {
      const C = cmd.cliente || {};
      const trs = linhasDe(ID.grdCarteira);
      let alvo = -1, razao = '';
      for (let i = 0; i < trs.length; i++) {
        const c = celulas(trs[i]);
        const valores = [...trs[i].querySelectorAll('input')].map(e => String(e.value || '').trim());
        const temCod = valores.includes(String(C.cod)) || c.some(x => x.trim() === String(C.cod));
        if (temCod && trs[i].innerText.replace(/\s+/g, ' ').trim().length > 6) {
          alvo = i;
          razao = c.find(x => x.length > 4 && !/^[\d.\/-]+$/.test(x.trim())) || '';
          break;
        }
      }
      if (alvo < 0) {
        // ainda não fixou: a próxima volta tenta de novo (o orquestrador conta)
        relatar({ tela: 'MANUTENCAO', erro: `o cliente ${C.cod} ainda não apareceu na carteira` });
        return;
      }
      await deixarSoMarcada(ID.grdCarteira, alvo);
      relatar({ tela: 'MANUTENCAO', resultado: 'cliente-ok', ebm: cmd.ebm,
                cod: C.cod, razao });
    },

    /** 3ª etapa: marcar os artigos, tirar o Grupo Financeiro do caminho
     *  e clicar em "adicionar artigo". */
    async adicionarArtigos(cmd) {
      const C = cmd.cliente || {};
      const artigos = artigosDaTela();
      const usados = [];
      for (const L of (C.linhas || [])) {
        const a = artigos.find(x => _nm(x.codigo) === _nm(L.codigo)
                                 && _nm(x.cor) === _nm(L.cor)
                                 && !usados.includes(x.linha));
        if (!a) { await falhou(cmd, `não achei ${L.codigo} ${L.cor} na grade de artigos`); return; }
        usados.push(a.linha);
      }
      for (const row of usados) {
        if (!await marcarCheck(ID.grdArtigo, row, true)) {
          await clicarLinha(ID.grdArtigo, row);
          await espera(400);
          await marcarCheck(ID.grdArtigo, row, true);
        }
        await espera(500);
      }
      // modo cliente final: o Grupo Financeiro não pode ficar marcado,
      // senão o EBM cria também a digitação do cliente de origem
      for (let i = 0; i < linhasDe(ID.grdGrupo).length; i++) {
        const el = campoDe(ID.grdGrupo, i, 0);
        if (el && el.checked) { el.click(); await espera(400); }
      }

      const antes = linhasDe(ID.grdDesm).length;
      const add = $(ID.btnAdd);
      if (!add) { await falhou(cmd, 'botão "adicionar artigo" indisponível'); return; }
      add.click();
      let trs = [];
      for (let i = 0; i < 20; i++) {
        await espera(400);
        trs = linhasDe(ID.grdDesm);
        if (trs.length - antes >= usados.length) break;
      }
      if (trs.length - antes < usados.length) {
        await falhou(cmd, `"adicionar artigo" criou ${trs.length - antes} de `
          + `${usados.length} linha(s)` + msgsOuVazio());
        return;
      }
      relatar({ tela: 'MANUTENCAO', resultado: 'artigos-ok', ebm: cmd.ebm,
                quantas: trs.length - antes, base: antes });
    },

    /** 4ª etapa: caixas e Pedido do Cliente em cada linha criada. */
    async preencherLinhas(cmd) {
      const C = cmd.cliente || {};
      const trs = linhasDe(ID.grdDesm);
      const preenchidas = [];
      for (let k = 0; k < trs.length; k++) {
        const L = (C.linhas || [])[k] || {};
        await clicarLinha(ID.grdDesm, k);
        await espera(700);
        let campos = inputsDaLinha(ID.grdDesm, k);
        for (let t = 0; t < 4 && !campos.length; t++) {
          await espera(600);
          campos = inputsDaLinha(ID.grdDesm, k);
        }
        const texto = campos.filter(c => c.tipo === 'text' || c.tipo === 'select-one');
        if (!texto.length) { await falhou(cmd, 'os campos da linha não apareceram'); return; }
        let okCx = false, okPed = false;
        texto.forEach((c, i) => {
          const low = (c.id || '').toLowerCase();
          if (low.includes('pedido') || i === texto.length - 1) {
            escrever(c.el, C.pedidoCliente); okPed = true;
          } else if (low.includes('caixa') || (texto.length >= 2 && i === texto.length - 2)) {
            escrever(c.el, L.caixas); okCx = true;
          }
        });
        preenchidas.push({ linha: k, caixas: L.caixas, okCx, okPed, total: totalDaLinha(k) });
        await espera(400);
      }
      relatar({ tela: 'MANUTENCAO', resultado: 'preparado', ebm: cmd.ebm,
                dados: { cliente: C.cod, pedidoCliente: C.pedidoCliente,
                         linhas: preenchidas, mensagens: mensagensDaTela(),
                         avisos: await naPaginaDesm('fila') } });
    },

    /** Salva o que está preenchido. Salvou = a linha SUMIU de "Artigos
     *  desmembramento" — é o sinal que o robô usa, porque a lista de
     *  digitações pode estar paginada e não crescer na tela. */
    async salvarCliente(cmd) {
      const b = $(ID.btnSalvarDesm);
      if (!b) { await falhou(cmd, 'botão de salvar indisponível'); return; }
      b.click();
      let salvou = false;
      for (let i = 0; i < 45; i++) {
        await espera(1000);
        if (!linhasDe(ID.grdDesm).length) { salvou = true; break; }
        const inativo = (mensagensDaTela().join(' ') + ' '
                        + (await naPaginaDesm('fila') || []).join(' '));
        if (/inativ/i.test(inativo)) {
          await falhou(cmd, 'CLIENTE INATIVO — ' + inativo.trim());
          return;
        }
      }
      const avisos = await naPaginaDesm('fila') || [];
      relatar({ tela: 'MANUTENCAO', resultado: 'salvou', ebm: cmd.ebm,
                ok: salvou,
                dados: { digitacoes: linhasDe(ID.grdDigit).length,
                         restou: linhasDe(ID.grdDesm).length,
                         mensagens: mensagensDaTela(), avisos } });
      await naPaginaDesm('desligar');
    },

    /** Desfaz o que acabou de ser preenchido, sem salvar. */
    async cancelarNaTela(cmd) {
      const canc = $('form1:btnCancelarDesmembramento');
      if (canc) canc.click();
      relatar({ tela: 'MANUTENCAO', resultado: 'cancelou', ebm: cmd.ebm });
      await naPaginaDesm('desligar');
    },

    /** RAIO-X: não mexe em nada — descreve as abas e prova, medindo
     *  antes e depois, se clicar nelas troca o conteúdo. É o que estava
     *  faltando para parar de adivinhar: nem o robô consegue abrir a
     *  Cliente Carteira, e o log dele diz "tentando assim mesmo". */
    async raioX(cmd) {
      const descreve = (el) => ({
        tag: el.tagName,
        id: el.id || '',
        classe: (el.className || '').toString().slice(0, 60),
        texto: (el.innerText || '').trim().slice(0, 40),
        onclick: (el.getAttribute('onclick') || '').slice(0, 160),
        href: (el.getAttribute('href') || '').slice(0, 160),
        paiOnclick: (el.parentElement && el.parentElement.getAttribute('onclick') || '').slice(0, 160),
        paiTag: el.parentElement ? el.parentElement.tagName : '',
        paiId: (el.parentElement && el.parentElement.id) || '',
      });

      const candidatos = porXPath("//*[contains(normalize-space(text()),'Cliente Carteira')"
                                + " or contains(normalize-space(text()),'Grupo Financeiro')]")
        .filter(e => e.offsetParent).slice(0, 8).map(descreve);

      const antes = {
        carteira: linhasDe(ID.grdCarteira).length,
        grupo: linhasDe(ID.grdGrupo).length,
      };
      clicarAba('Cliente Carteira');
      await espera(1500);
      const depois = {
        carteira: linhasDe(ID.grdCarteira).length,
        grupo: linhasDe(ID.grdGrupo).length,
      };

      relatar({ tela: 'MANUTENCAO', resultado: 'raiox', ebm: cmd.ebm,
                dados: { candidatos, antes, depois,
                         diag: radiografiaCarteira() } });
    },

    async nada() { /* o orquestrador ainda não quer nada desta tela */ },
  };

  /* ---------- apoio da digitação ---------- */

  const _nm = s => String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
  const campoDe = (grid, row, col) => $(`${grid}:webGrid:txtInput:row${row}:${col}`);
  const msgsOuVazio = () => {
    const m = mensagensDaTela();
    return m.length ? ' — ' + m.join(' | ') : '';
  };

  async function falhou(cmd, texto, diag) {
    relatar({ tela: 'MANUTENCAO', resultado: 'falhou', ebm: cmd.ebm, texto,
              diag: diag || null });
    await naPaginaDesm('desligar');
  }

  /** Clique NATIVO na primeira célula: é o que o webgrid escuta. */
  async function clicarLinha(grid, row) {
    const trs = linhasDe(grid);
    if (row >= trs.length) return false;
    const td = trs[row].querySelector('td');
    if (!td) return false;
    try { td.scrollIntoView({ block: 'center' }); } catch (e) { /* segue */ }
    td.click();
    return true;
  }

  async function marcarCheck(grid, row, quer) {
    const el = campoDe(grid, row, 0);
    if (!el) return false;
    if (!!el.checked !== !!quer) { el.click(); await espera(350); }
    return true;
  }

  function inputsDaLinha(grid, row) {
    const trs = linhasDe(grid);
    if (row >= trs.length) return [];
    return [...trs[row].querySelectorAll('input, select')]
      .map(el => ({ id: el.id || '', tipo: (el.type || el.tagName).toLowerCase(), el }))
      .filter(c => c.tipo !== 'hidden');
  }

  /** Escreve como a página espera: valor + change (o EBM lê no change). */
  function escrever(el, valor) {
    el.value = String(valor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function totalDaLinha(row) {
    const el = campoDe(ID.grdDesm, row, 5);
    if (el) return parseInt(el.value, 10) || 0;
    const trs = linhasDe(ID.grdDesm);
    const c = row < trs.length ? celulas(trs[row]) : [];
    return parseInt(c[5], 10) || 0;
  }

  /** A aba cujo rótulo contém o texto (ex.: "Cliente Carteira").
   *  Os quatro XPaths são os do robô, na mesma ordem: link, célula
   *  folha, span e, por último, qualquer nó de texto. */
  function clicarAba(texto) {
    const xps = [
      `//a[contains(normalize-space(.),'${texto}')]`,
      `//td[contains(normalize-space(.),'${texto}') and not(.//td)]`,
      `//span[contains(normalize-space(.),'${texto}')]`,
      `//*[contains(normalize-space(text()),'${texto}')]`,
    ];
    for (const xp of xps) {
      for (const el of porXPath(xp)) {
        if (!el.offsetParent) continue;
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* segue */ }
        try { el.click(); return true; } catch (e) { /* tenta o próximo */ }
      }
    }
    return false;
  }

  /** Informa o cliente final na aba Cliente Carteira.
   *
   *  A sequência abaixo foi PROVADA na tela do EBM em 18/11/2026, com o
   *  pedido 13390926 e o cliente 10096:
   *
   *    1. clicar em form1:lblClienteCarteira        (a aba é um <span>)
   *       -> o bloco groupClienteCarteira sai de display:none
   *    2. clicar em form1:grdClienteCarteira:btnNew ("inserir nova linha
   *       no grid") -> a grade vai de 0 para 1 linha
   *    3. escrever o código na célula ...:webGrid:txtInput:row{n}:1 e
   *       disparar change -> o EBM traz a razão social sozinho
   *    4. deixar só essa linha marcada
   *
   *  O QUE ME CUSTOU HORAS: eu só considerava ícones VISÍVEIS, e com a
   *  aba fechada nada daquela grade é visível — então o btnNew "não
   *  existia". Ele está lá o tempo todo. O robô erra do mesmo jeito, e é
   *  por isso que pula clientes quando a carteira está vazia.
   *
   *  O campo "Filtrar resultado de clientes" é outra coisa: tem
   *  onchange="this.form.submit()" e serve para filtrar as listas da
   *  tela, não para incluir um cliente. */
  async function informarClienteFinal(cod) {
    // 1. abrir a aba e conferir que abriu
    const aba = $('form1:lblClienteCarteira') || porXPath("//*[contains(@id,'lblClienteCarteira')]")[0];
    if (aba) { try { aba.click(); } catch (e) { /* segue */ } }
    else clicarAba('Cliente Carteira');
    await espera(1200);

    const bloco = $('form1:groupClienteCarteira')
      || porXPath("//*[contains(@id,'groupClienteCarteira')]")[0];
    if (bloco && getComputedStyle(bloco).display === 'none') {
      await espera(1200);
      if (getComputedStyle(bloco).display === 'none') {
        return { ok: false, erro: 'a aba Cliente Carteira não abriu',
                 diag: radiografiaCarteira() };
      }
    }

    /* O código do cliente fica no VALUE de um input da linha — o texto
       da linha mostra só a razão social e o CNPJ. Procurar "10096" no
       texto nunca acha nada, e foi isso que me fez concluir, errado, que
       o cliente não tinha carregado. */
    const procurar = () => {
      const trs = linhasDe(ID.grdCarteira);
      for (let i = 0; i < trs.length; i++) {
        const c = celulas(trs[i]);
        const valores = [...trs[i].querySelectorAll('input')].map(e => String(e.value || '').trim());
        const temCod = valores.includes(String(cod)) || c.some(x => x.trim() === String(cod));
        const temRazao = trs[i].innerText.replace(/\s+/g, ' ').trim().length > 6;
        if (temCod && temRazao) return { i, c };
      }
      return null;
    };

    // 2. já está na grade? senão, criar a linha
    let achou = procurar();
    let n;
    if (achou) {
      n = achou.i;
    } else {
      /* Linha vazia que sobrou de uma tentativa anterior é reaproveitada:
         criar outra só empilha lixo na carteira. */
      const vazias = linhasDe(ID.grdCarteira)
        .map((tr, i) => ({ i, txt: celulas(tr).join('').trim() }))
        .filter(x => !x.txt);
      if (vazias.length) {
        n = vazias[0].i;
        const inp0 = campoDe(ID.grdCarteira, n, 1);
        if (inp0) {
          inp0.focus();
          escrever(inp0, String(cod));
          for (let i = 0; i < 14 && !achou; i++) { await espera(800); achou = procurar(); }
          if (achou) {
            await deixarSoMarcada(ID.grdCarteira, achou.i);
            return { ok: true,
                     razao: achou.c.find(x => x.length > 4 && !/^[\d.\/-]+$/.test(x.trim())) || '' };
          }
        }
      }

      const trsAntes = linhasDe(ID.grdCarteira).length;
      const btnNew = $(ID.grdCarteira + ':btnNew')
        || porXPath("//*[contains(@id,'grdClienteCarteira:btnNew')]")[0];
      if (!btnNew) {
        return { ok: false, erro: 'não achei "inserir nova linha no grid" na Cliente Carteira',
                 diag: radiografiaCarteira() };
      }
      const alvo = btnNew.querySelector ? (btnNew.querySelector('img') || btnNew) : btnNew;
      try { alvo.click(); } catch (e) { btnNew.click(); }

      let trs = [];
      for (let i = 0; i < 12; i++) {
        await espera(500);
        trs = linhasDe(ID.grdCarteira);
        if (trs.length > trsAntes) break;
      }
      if (trs.length <= trsAntes) {
        return { ok: false, erro: 'a linha nova não apareceu na Cliente Carteira',
                 diag: radiografiaCarteira() };
      }
      n = trs.length - 1;
    }

    // 3. escrever o código e esperar a razão social
    if (!achou) {
      let inp = campoDe(ID.grdCarteira, n, 1);
      for (let t = 0; t < 3 && !inp; t++) {
        await clicarLinha(ID.grdCarteira, n);
        await espera(700);
        inp = campoDe(ID.grdCarteira, n, 1);
      }
      if (!inp) return { ok: false, erro: 'a célula do código não apareceu na linha nova',
                         diag: radiografiaCarteira() };
      inp.focus();
      escrever(inp, String(cod));

      for (let i = 0; i < 14 && !achou; i++) {
        await espera(800);
        const avisos = await naPaginaDesm('fila') || [];
        const inativo = avisos.find(a => /inativ/i.test(a));
        if (inativo) return { ok: false, erro: 'CLIENTE INATIVO — ' + inativo };
        const msg = mensagensDaTela().find(m => /inativ/i.test(m));
        if (msg) return { ok: false, erro: 'CLIENTE INATIVO — ' + msg };
        achou = procurar();
      }
      if (!achou) {
        const trs = linhasDe(ID.grdCarteira);
        const linha = n < trs.length ? celulas(trs[n]).join(' ').trim() : '';
        return { ok: false,
                 erro: `o EBM não reconheceu o cliente ${cod}`
                     + (linha ? ` (a linha ficou "${linha.slice(0, 60)}")` : '')
                     + msgsOuVazio(),
                 diag: radiografiaCarteira() };
      }
    }

    // 4. deixar só ele marcado
    await deixarSoMarcada(ID.grdCarteira, achou.i);
    const razao = achou.c.find(x => x.length > 4 && !/^[\d.\/-]+$/.test(x.trim())) || '';
    return { ok: true, razao };
  }

  async function deixarSoMarcada(grid, alvo) {
    const n = linhasDe(grid).length;
    for (let i = 0; i < n; i++) await marcarCheck(grid, i, i === alvo);
  }

  /** O que existe na tela em volta da Cliente Carteira. Serve para eu
   *  enxergar o DOM do EBM sem estar na máquina de quem testa. */
  function radiografiaCarteira() {
    const texto = el => (el.innerText || el.textContent || '').trim();
    const abas = [...document.querySelectorAll('a, td, span, div, li')]
      .filter(e => e.offsetParent)
      .map(texto)
      .filter(t => t && t.length < 42 && /carteira|grupo|artigo|tamanho|financeiro/i.test(t));
    const img = i => [(i.src || '').split('/').pop(), i.title, i.alt, i.id]
      .filter(Boolean).join('|').slice(0, 60);
    return {
      temGradeCarteira: !!$(ID.grdCarteira),
      linhasCarteira: linhasDe(ID.grdCarteira).length,
      temGradeArtigo: !!$(ID.grdArtigo),
      temGradeGrupo: !!$(ID.grdGrupo),
      temGradeDesm: !!$(ID.grdDesm),
      abas: [...new Set(abas)].slice(0, 14),
      // sem filtrar por visibilidade: com a aba fechada, nada daquela
      // grade é visível — e foi assim que o btnNew sumiu do meu mapa
      imagens: [...document.querySelectorAll('img')].map(img).slice(0, 40),
      gradesNaTela: [...document.querySelectorAll('table[id^="form1:"]')]
        .map(t => t.id).slice(0, 20),
      camposFiltro: [...document.querySelectorAll('input')]
        .filter(i => i.offsetParent && /odigo|filtro/i.test(i.id || ''))
        .map(i => `${i.id}="${i.value}"`).slice(0, 10),
    };
  }

  /** Procura por XPath, que é como o robô acha as coisas desta tela. */
  function porXPath(xp) {
    const out = [];
    try {
      const r = document.evaluate(xp, document, null,
                                  XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    } catch (e) { /* XPath inválido naquele documento */ }
    return out;
  }

  /** O ícone de "incluir linha" (a cartinha) do cabeçalho da grade.
   *  Copiado do robô, inclusive na ordem das tentativas: a tabela que
   *  ENVOLVE a grade (id que *contém* grdClienteCarteira, porque o EBM
   *  monta ids compostos), depois as imagens de dentro e, por fim, as
   *  seis imagens ANTERIORES à grade — que é onde a barrinha de ícones
   *  costuma morar. Escrever isso do zero foi o que me custou o erro. */
  function iconeIncluir() {
    const nav = ['first', 'prev', 'next', 'last', 'prim', 'ant', 'prox', 'ult',
                 'check', 'ok', 'sel', 'todos', 'all', 'marca', 'excl', 'del',
                 'lixo', 'remov'];
    let cands = [];
    const cont = porXPath("//*[contains(@id,'grdClienteCarteira')]/ancestor::table[1]")[0];
    if (cont) cands = [...cont.querySelectorAll('img')];
    if (!cands.length) {
      cands = porXPath("//*[contains(@id,'grdClienteCarteira')]//img"
                     + " | //*[contains(@id,'grdClienteCarteira')]/preceding::img[position()<=6]");
    }
    const pista = img => [img.getAttribute('src') || '', img.getAttribute('title') || '',
                          img.getAttribute('alt') || '', img.getAttribute('id') || '']
                          .join(' ').toLowerCase();
    for (const img of cands) {
      if (!img.offsetParent) continue;
      if (/nov|inclu|add|new|insert|cart|card|incl/.test(pista(img))) return img;
    }
    // sem pista clara: a primeira visível que não pareça navegação
    for (const img of cands) {
      if (!img.offsetParent) continue;
      if (!nav.some(x => pista(img).includes(x))) return img;
    }
    return null;
  }

  /* ---------- a voz do EBM (alertas), via mundo da página ---------- */
  let seqMain = 0;
  function naPaginaDesm(op, ms = 4000) {
    return new Promise(resolve => {
      const id = 'd' + (++seqMain);
      const prazo = setTimeout(() => {
        window.removeEventListener('cms-desm-main-res', ouvir);
        resolve(null);
      }, ms);
      function ouvir(ev) {
        let r;
        try { r = JSON.parse(ev.detail); } catch (e) { return; }
        if (r.id !== id) return;
        clearTimeout(prazo);
        window.removeEventListener('cms-desm-main-res', ouvir);
        resolve(r.valor);
      }
      window.addEventListener('cms-desm-main-res', ouvir);
      window.dispatchEvent(new CustomEvent('cms-desm-main-req', {
        detail: JSON.stringify({ id, op }),
      }));
    });
  }

  /* ---------- conversa com o orquestrador ---------- */

  function relatar(campos) {
    try {
      chrome.runtime.sendMessage({ de: 'cms-desm-pagina', doc: DOC,
                                   url: location.href, ...campos }).catch(() => {});
    } catch (e) { /* extensão recarregada */ }
  }

  async function rodar(tela) {
    let cmd;
    try {
      cmd = await chrome.runtime.sendMessage({
        de: 'cms-desm-pagina', tela, doc: `${DOC}:${tela}`, url: location.href });
    } catch (e) { return; }
    if (!cmd || !cmd.acao || cmd.acao === 'nada') return;
    const fn = acoes[cmd.acao];
    if (!fn) return;
    try { await fn(cmd); }
    catch (e) { relatar({ tela, erro: `${cmd.acao}: ${e.message || e}` }); }
  }

  /* ---------- laço ----------
     O EBM troca de tela de duas formas: recarregando a página e trocando
     o conteúdo do mesmo documento. Olhar só no carregamento perde a
     segunda, e o roteiro morre esperando. Por isso a vigilância é
     contínua e o gatilho é a tela MUDAR. */
  let telaAtendida = null;
  let ocupado = false;

  function tentar() {
    if (ocupado) return;
    const tela = identificar();
    if (!tela || tela === telaAtendida) return;
    telaAtendida = tela;
    ocupado = true;
    rodar(tela).finally(() => { ocupado = false; });
  }

  /* O gatilho é a tela MUDAR — mas quando o trabalho começa a tela já
     está parada há um tempo e ninguém fala. O orquestrador então cutuca:
     esquece o que foi atendido e pergunta de novo. */
  try {
    chrome.runtime.onMessage.addListener((msg, _s, responder) => {
      if (msg?.de !== 'cms-desm' || msg.tipo !== 'acorda') return;
      telaAtendida = null;
      const tela = identificar();
      /* O cutucão chega a TODOS os frames da aba, e quem responde primeiro
         é quem o orquestrador ouve. Os frames que não são a tela ficam
         calados de propósito: senão o relato vira "respondeu, mas não
         reconheci a tela" enquanto o frame certo tinha a resposta. */
      if (!tela) return;
      responder({ ok: true, tela, url: location.href });
      tentar();
      return true;
    });

    /* Ordem direta, sem esperar a tela mudar: é assim que o "salvar" e o
       "cancelar" chegam depois de alguém olhar o que foi preenchido. */
    chrome.runtime.onMessage.addListener((msg, _s, responder) => {
      if (msg?.de !== 'cms-desm' || msg.tipo !== 'executar') return;
      const fn = acoes[msg.acao];
      if (!fn) { responder({ ok: false, erro: 'ação desconhecida: ' + msg.acao }); return true; }
      if (!identificar()) return;      // frame errado fica calado
      responder({ ok: true });
      ocupado = true;
      fn(msg.cmd || {}).finally(() => { ocupado = false; });
      return true;
    });
  } catch (e) { /* extensão recarregada */ }

  tentar();
  const vigia = setInterval(tentar, 700);
  setTimeout(() => clearInterval(vigia), 20 * 60 * 1000);
})();
