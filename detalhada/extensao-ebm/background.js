/* ============================================================
   ORQUESTRADOR
   ============================================================
   Guarda o estado do trabalho e diz a cada página do EBM o que fazer.
   O content script (ebm.js) morre a cada postback, então quem lembra
   em que ponto estamos é este arquivo, não a página.

   Passos, na ordem:
     1 ABRIR          navega a aba para a tela de consulta
     2 CONSULTA       monta o filtro inteiro. As colunas da grade abrem por
                    ajax, sem recarregar, então isso vai de ponta a ponta
                    numa vez só; criar a linha é que recarrega e traz de
                    volta para cá.
     3 RESULTADO      lista com várias encomendas: marca todas e abre o pedido
       DETALHE        um GCI só: o EBM já cai no detalhe, e o botão é outro
     4 VISUALIZADOR   clica no disquete
     5 FORMATO        Adobe PDF + printReport()
     6 pronto         o download cai e a gente renomeia
   ============================================================ */

const URL_CONSULTA =
  'https://www.vulcabras.com.br/ebm4web/faces/UC1183_RealizarConsultaEncomendaVenda.jsp';
const URL_LOGIN = 'https://www.vulcabras.com.br/ebm4web/ebmMain.jsp';

// O caminho todo — consulta, pedido, visualizador, PDF — leva alguns
// minutos num dia ruim de rede. Curto demais mata trabalho que ia dar certo.
// E rodando minimizado o Chrome afrouxa os temporizadores das páginas, o
// que deixa tudo mais lento do que quando a aba está à vista.
const TEMPO_LIMITE = 8 * 60 * 1000;

/** Trabalho em andamento. Um de cada vez — dois pedidos ao mesmo tempo
    brigariam pela sessão do EBM, que é única. */
let job = null;

function novoJob(dados, tabOrigem) {
  return {
    id: 'job_' + Date.now(),
    gcis: dados.gcis,
    status: dados.status || 'A',
    nomeArquivo: dados.nomeArquivo || 'pedido',
    debug: !!dados.debug,
    tabOrigem,
    tabEbm: null,
    tabsExtras: [],      // popups do visualizador e do "salvar como"
    passo: 'ABRIR',
    log: [],
    prazo: Date.now() + TEMPO_LIMITE,
  };
}

function anotar(msg) {
  if (!job) return;
  const linha = `${new Date().toLocaleTimeString('pt-BR')}  ${msg}`;
  job.log.push(linha);
  console.log('[CMS]', linha);
}

/** Avisa a Detalhada do andamento. */
function avisar(tipo, texto, extra = {}) {
  if (!job || !job.tabOrigem) return;
  chrome.tabs.sendMessage(job.tabOrigem, {
    de: 'cms-ebm', tipo, texto, passo: job.passo, ...extra,
  }).catch(() => { /* a aba pode ter sido fechada */ });
}

async function encerrar(ok, texto) {
  if (!job) return;
  anotar((ok ? 'PRONTO: ' : 'FALHOU: ') + texto);
  avisar(ok ? 'fim' : 'erro', texto, { log: job.log });

  chrome.alarms.clear(VIGIA);

  if (!job.debug) {
    for (const id of [...job.tabsExtras, job.tabEbm]) {
      if (id != null) chrome.tabs.remove(id).catch(() => {});
    }
    if (job.janelaEbm != null) chrome.windows.remove(job.janelaEbm).catch(() => {});
  }
  job = null;
}

/* ---------- entrada: a Detalhada pede um PDF ---------- */

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (msg?.de !== 'cms-detalhada') {
    // Pedido vindo de uma página do EBM: "cheguei, o que faço?"
    // Só quem informa `tela` está pedindo comando; o resto é aviso/erro,
    // tratado no outro ouvinte lá embaixo.
    if (msg?.de === 'cms-ebm-pagina' && msg.tela) {
      responder(comandoPara(msg, sender));
      return true;
    }
    return;
  }

  if (msg.tipo === 'ping') { responder({ ok: true, versao: '0.1.0' }); return true; }

  if (msg.tipo === 'gerarPdf') {
    if (job) { responder({ ok: false, erro: 'Já existe um PDF sendo gerado.' }); return true; }
    iniciar(msg.dados, sender.tab.id).then(
      () => responder({ ok: true }),
      (e) => responder({ ok: false, erro: String(e && e.message || e) })
    );
    return true;
  }
});

/** Vigia do prazo.
 *
 *  O prazo também é conferido em `comandoPara`, mas aquilo só roda quando
 *  alguma página FALA. Quando o roteiro empaca numa tela que ninguém
 *  reconhece, ninguém fala — e o app ficava com a tarja girando para
 *  sempre, sem dizer o motivo. O alarme sobrevive ao service worker
 *  dormir, o que um setTimeout não faria. */
const VIGIA = 'cms-vigia';

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== VIGIA) return;
  if (!job) { chrome.alarms.clear(VIGIA); return; }
  if (Date.now() > job.prazo) {
    encerrar(false, `O EBM não respondeu a tempo. Parou no passo ${job.passo}.`);
    chrome.alarms.clear(VIGIA);
  }
});

async function iniciar(dados, tabOrigem) {
  job = novoJob(dados, tabOrigem);
  chrome.alarms.create(VIGIA, { periodInMinutes: 0.5 });
  anotar(`início · ${job.gcis.length} GCI(s) · status ${job.status} · arquivo "${job.nomeArquivo}"`);
  avisar('progresso', 'Abrindo o EBM…');

  if (job.debug) {
    // acompanhamento: aba à mostra, na janela atual, e não fecha no fim
    const aba = await chrome.tabs.create({ url: URL_CONSULTA, active: true });
    job.tabEbm = aba.id;
  } else {
    // Janela própria, minimizada e sem foco: o vendedor não vê o EBM
    // trabalhar, só a tarja da Detalhada. Ela é fechada ao terminar.
    const jan = await chrome.windows.create({
      url: URL_CONSULTA, focused: false, state: 'minimized' });
    job.janelaEbm = jan.id;
    job.tabEbm = jan.tabs[0].id;
  }
  job.passo = 'CONSULTA';
}

/* ---------- o content script pergunta o que fazer ---------- */

function comandoPara(msg, sender) {
  if (!job) return { acao: 'nada' };

  if (Date.now() > job.prazo) {
    encerrar(false, 'O EBM demorou demais para responder.');
    return { acao: 'nada' };
  }

  const tabId = sender.tab?.id;
  const url = msg.url || '';

  // Popups (visualizador e "salvar como") nascem como abas novas
  if (tabId != null && tabId !== job.tabEbm && !job.tabsExtras.includes(tabId)) {
    job.tabsExtras.push(tabId);
    anotar(`popup detectado: ${url.split('/').pop()}`);
    // O visualizador e o "salvar como" são abertos pelo próprio EBM, em
    // janela nova — não há como impedir. Dá para mandá-las para baixo
    // assim que aparecem: pisca e some.
    if (!job.debug) esconder(tabId);
  }

  // Cinto de segurança por documento: a mesma página só recebe um comando.
  // Página nova depois de um postback tem outro id, então segue normalmente.
  if (msg.doc && job.docAtendido === msg.doc) {
    return { acao: 'nada' };
  }

  // Caiu na tela de login: a sessão do EBM não está aberta.
  // Só vale para a aba principal — o EBM abre popups Login.jsp de
  // controle de sessão, e derrubar o trabalho por causa deles fazia
  // falhar quem estava logado.
  if (msg.tela === 'LOGIN') {
    if (tabId === job.tabEbm) {
      encerrar(false, 'Você não está logado no EBM. Abra o EBM, faça login e tente de novo.');
    } else {
      anotar('popup de login ignorado: ' + url.split('/').pop());
    }
    return { acao: 'nada' };
  }

  const marcar = (cmd) => { job.docAtendido = msg.doc; return cmd; };

  switch (msg.tela) {
    case 'CONSULTA':
      // Um passo só: a própria página decide o que ainda falta montar.
      // Ela recarrega a cada postback e volta aqui, até chegar no consultar.
      if (job.passo === 'CONSULTA') {
        job.voltas = (job.voltas || 0) + 1;
        if (job.voltas > 12) { encerrar(false, 'A tela de consulta ficou em laço.'); return { acao: 'nada' }; }
        avisar('progresso', 'Montando o filtro…');
        anotar(`tela de consulta (volta ${job.voltas})`);
        return marcar({ acao: 'consulta', status: job.status, gcis: job.gcis });
      }
      return { acao: 'nada' };

    case 'RESULTADO':
      if (job.passo === 'CONSULTA' || job.passo === 'RESULTADO') {
        job.passo = 'VISUALIZADOR';
        avisar('progresso', 'Abrindo o pedido…');
        anotar('passo RESULTADO: marcar todas + visualizar pedido');
        return marcar({ acao: 'resultado' });
      }
      return { acao: 'nada' };

    case 'DETALHE':
      // Com um GCI só o EBM pula a lista e cai direto no detalhe.
      // Mesmo ponto do roteiro, botão diferente.
      if (job.passo === 'CONSULTA' || job.passo === 'RESULTADO') {
        job.passo = 'VISUALIZADOR';
        avisar('progresso', 'Abrindo o pedido…');
        anotar('passo DETALHE: visualizar pedido');
        return marcar({ acao: 'detalhe' });
      }
      return { acao: 'nada' };

    case 'VISUALIZADOR':
      if (job.passo === 'VISUALIZADOR') {
        job.passo = 'FORMATO';
        avisar('progresso', 'Gerando o PDF…');
        anotar('passo VISUALIZADOR: clicando no disquete');
        return marcar({ acao: 'exportar' });
      }
      return { acao: 'nada' };

    case 'FORMATO':
      if (job.passo === 'FORMATO') {
        job.passo = 'BAIXANDO';
        anotar('passo FORMATO: Adobe PDF + OK');
        return marcar({ acao: 'confirmar' });
      }
      return { acao: 'nada' };
  }

  return { acao: 'nada' };
}

async function esconder(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.windows.update(t.windowId, { state: 'minimized' });
  } catch (e) { /* a janela pode já ter fechado */ }
}

/* ---------- o content script relata problema ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.de !== 'cms-ebm-pagina') return;
  if (msg.erro) { anotar('página relatou: ' + msg.erro); encerrar(false, msg.erro); }
  if (msg.aviso) anotar('página: ' + msg.aviso);
});

/* ---------- renomear o PDF que cair ---------- */

chrome.downloads.onDeterminingFilename.addListener((item, sugerir) => {
  if (!job || job.passo !== 'BAIXANDO') return;          // não é nosso
  if (!/ClienteEncomenda.*\.pdf$/i.test(item.filename)) return;

  const nome = limparNome(job.nomeArquivo) + '.pdf';
  anotar(`baixou ${item.filename} → ${nome}`);
  sugerir({ filename: nome, conflictAction: 'uniquify' });
  encerrar(true, `PDF salvo como ${nome}`);
});

function limparNome(s) {
  return String(s || 'pedido')
    .replace(/[\\/:*?"<>|]/g, '-')     // proibidos no Windows
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'pedido';
}

/* ---------- limpeza ---------- */

chrome.tabs.onRemoved.addListener((tabId) => {
  if (job && tabId === job.tabEbm && job.passo !== 'BAIXANDO') {
    encerrar(false, 'A aba do EBM foi fechada antes de terminar.');
  }
});
