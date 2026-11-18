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
    return null;
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

    /* ---- PILOTO: prepara UM cliente e para antes de salvar ----
       Mesma sequência do robô, na mesma ordem, porque cada passo depende
       do anterior ter registrado no servidor:
         1. tela limpa (sobra de uma digitação pela metade)
         2. marcar os artigos do cliente
         3. desmarcar o Grupo Financeiro (modo cliente final)
         4. Cliente Carteira: informar o código e deixar só ele marcado
         5. adicionar artigo
         6. preencher caixas e o Pedido do Cliente
       Nada é salvo: o salvar é um comando à parte, depois de alguém
       olhar a tela. */
    async prepararCliente(cmd) {
      const C = cmd.cliente || {};
      await naPaginaDesm('ligar');

      // 1. tela limpa
      if (linhasDe(ID.grdDesm).length) {
        const canc = $('form1:btnCancelarDesmembramento');
        if (canc) {
          relatar({ tela: 'MANUTENCAO', resultado: 'limpou', ebm: cmd.ebm,
                    texto: 'havia uma digitação pela metade; cancelei para começar limpo' });
          canc.click();
          return;                       // postback: o roteiro recomeça
        }
      }

      // 2. marcar os artigos do cliente
      const artigos = artigosDaTela();
      const usados = [];
      for (const L of (C.linhas || [])) {
        const a = artigos.find(x => _nm(x.codigo) === _nm(L.codigo)
                                 && _nm(x.cor) === _nm(L.cor)
                                 && !usados.includes(x.linha));
        if (!a) {
          await falhou(cmd, `não achei ${L.codigo} ${L.cor} na grade de artigos`);
          return;
        }
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

      // 3. Grupo Financeiro desmarcado — senão o EBM cria também a
      //    digitação do cliente de origem
      for (let i = 0; i < linhasDe(ID.grdGrupo).length; i++) {
        const el = campoDe(ID.grdGrupo, i, 0);
        if (el && el.checked) { el.click(); await espera(400); }
      }

      // 4. Cliente Carteira
      const r4 = await informarClienteFinal(C.cod);
      if (!r4.ok) { await falhou(cmd, r4.erro, r4.diag); return; }

      // 5. adicionar artigo
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

      // 6. preencher caixas e Pedido do Cliente, linha a linha
      const novas = [];
      for (let idx = antes; idx < trs.length; idx++) novas.push(idx);
      const preenchidas = [];
      for (let k = 0; k < novas.length; k++) {
        const idx = novas[k];
        const L = (C.linhas || [])[k] || {};
        await clicarLinha(ID.grdDesm, idx);
        await espera(700);
        let campos = inputsDaLinha(ID.grdDesm, idx);
        for (let t = 0; t < 4 && !campos.length; t++) {
          await espera(600);
          campos = inputsDaLinha(ID.grdDesm, idx);
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
        preenchidas.push({ linha: idx, caixas: L.caixas, pedido: C.pedidoCliente,
                           okCx, okPed, total: totalDaLinha(idx) });
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
   *  O QUE EU TINHA ERRADO (e o robô também): essa grade não é uma lista
   *  vazia onde se inclui uma linha. Ela já vem cheia com a carteira
   *  daquele pedido mãe — dezesseis lojas, no 13390926 — e embaixo dela
   *  há "Filtrar resultado de clientes: Código / Razão Social". O
   *  caminho é FILTRAR pelo código e MARCAR o checkbox do cliente.
   *  Procurar um ícone de "incluir" era caçar algo que nunca existiu, e
   *  é o que faz o robô pular clientes no log de 17/11.
   *
   *  Consequência que vale saber: só dá para desmembrar para quem está
   *  na carteira daquele pedido mãe. Se o cliente não aparece no filtro,
   *  não é defeito nosso — é o EBM dizendo que ele não pode receber. */
  async function informarClienteFinal(cod) {
    clicarAba('Cliente Carteira');
    await espera(1200);

    const jaMarcado = () => {
      const trs = linhasDe(ID.grdCarteira);
      for (let i = 0; i < trs.length; i++) {
        const c = celulas(trs[i]);
        if (c.some(x => x.trim() === String(cod))) return { i, c };
      }
      return null;
    };

    // 1. o cliente já está à vista? (carteira curta, ou filtro anterior)
    let achou = jaMarcado();

    // 2. senão, filtrar pelo código — é o que a tela oferece
    if (!achou) {
      /* O filtro TEM de ser o da Cliente Carteira. As duas abas dividem a
         mesma área e cada uma tem o seu campo "Código"; pegar o primeiro
         do documento escreve no Grupo Financeiro — foi o que aconteceu.
         Por isso o campo é procurado a partir da GRADE da carteira: o
         primeiro input de código que vem depois dela. */
      const filtro = porXPath("//*[contains(@id,'grdClienteCarteira')]"
                            + "/following::input[contains(@id,'Codigo')][1]")[0]
        || porXPath("//*[contains(@id,'grdClienteCarteira')]"
                  + "/following::input[contains(@id,'odigo')][1]")[0]
        || porXPath("//input[contains(@id,'txtFiltroCodigo')]").filter(e => e.offsetParent).pop()
        || $(ID.filtroCod);
      if (!filtro) {
        return { ok: false, erro: 'não achei o campo "Código" do filtro de clientes',
                 diag: radiografiaCarteira() };
      }
      filtro.focus();
      filtro.value = '';
      escrever(filtro, String(cod));
      /* Escrever o código não basta: quem manda o EBM buscar é o Enter
         ou a LUPA do filtro ("clique para realizar uma busca"). O Enter
         sintético nem sempre chega ao handler da página, então os dois
         são tentados — primeiro o teclado, depois o clique, que é o que
         uma pessoa faria. */
      for (const tipo of ['keydown', 'keypress', 'keyup']) {
        filtro.dispatchEvent(new KeyboardEvent(tipo, { key: 'Enter', code: 'Enter',
          keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      await espera(900);
      if (!jaMarcado()) {
        const lupa = lupaDoFiltro();
        if (lupa) {
          try { lupa.click(); } catch (e) { /* segue com o Enter que já foi */ }
        }
      }

      for (let i = 0; i < 14 && !achou; i++) {
        await espera(700);
        const avisos = await naPaginaDesm('fila') || [];
        const inativo = avisos.find(a => /inativ/i.test(a));
        if (inativo) return { ok: false, erro: 'CLIENTE INATIVO — ' + inativo };
        achou = jaMarcado();
      }
    }

    if (!achou) {
      const trs = linhasDe(ID.grdCarteira);
      const amostra = trs.slice(0, 5).map(tr => celulas(tr).slice(0, 2).join(' ')).join(' | ');
      return { ok: false,
               erro: `o cliente ${cod} não está na Cliente Carteira deste pedido mãe`
                   + (trs.length ? ` (a carteira tem ${trs.length}: ${amostra}…)` : ' (carteira vazia)'),
               diag: radiografiaCarteira() };
    }

    await deixarSoMarcada(ID.grdCarteira, achou.i);
    const razao = achou.c.find(x => x.length > 4 && !/^\d+$/.test(x.trim())) || '';
    return { ok: true, razao };
  }

  /** A lupa do filtro de clientes. Há várias iguais na tela (cada grade
   *  tem a sua), então ela é procurada a partir do próprio campo do
   *  filtro e, só depois, dentro da tabela da Cliente Carteira. */
  function lupaDoFiltro() {
    const pista = i => [(i.getAttribute('src') || ''), (i.getAttribute('title') || ''),
                        (i.getAttribute('alt') || ''), (i.getAttribute('id') || '')]
                        .join(' ').toLowerCase();
    const ehLupa = i => /search|lupa|busca|filtr/.test(pista(i)) && i.offsetParent;
    const perto = porXPath("//*[contains(@id,'grdClienteCarteira')]"
                         + "/following::img[position()<=12]");
    for (const i of perto) if (ehLupa(i)) return i;
    const cont = porXPath("//*[contains(@id,'grdClienteCarteira')]/ancestor::table[1]")[0];
    if (cont) for (const i of cont.querySelectorAll('img')) if (ehLupa(i)) return i;
    return null;
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
      imagens: [...document.querySelectorAll('img')]
        .filter(i => i.offsetParent).map(img).slice(0, 30),
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
