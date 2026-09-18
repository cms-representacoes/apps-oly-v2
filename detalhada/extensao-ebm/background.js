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

/* ---------- login guardado ----------
   Usuário e senha do EBM ficam no armazenamento DA EXTENSÃO
   (chrome.storage.local): a página da Detalhada não os guarda, o GitHub
   não os vê e nenhum site consegue ler. Só este arquivo os usa, e só para
   preencher a tela de login quando o EBM pede. Nunca vão para o log. */
async function lerLogin() {
  const { ebmUsuario, ebmSenha } = await chrome.storage.local.get(['ebmUsuario', 'ebmSenha']);
  return ebmUsuario && ebmSenha ? { usuario: ebmUsuario, senha: ebmSenha } : null;
}
async function gravarLogin(usuario, senha) {
  await chrome.storage.local.set({ ebmUsuario: String(usuario), ebmSenha: String(senha) });
}
async function esquecerLogin() {
  await chrome.storage.local.remove(['ebmUsuario', 'ebmSenha']);
}

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
  const linha = `${new Date().toLocaleTimeString('pt-BR')}  ${msg}`;
  console.log('[CMS]', linha);
  if (!job) return;
  job.log.push(linha);

  // Espelha na Detalhada, ao vivo. Enquanto o passo a passo só existia
  // aqui dentro, um trabalho que morria calado não deixava rastro nenhum
  // para quem estava olhando o app — e era preciso ir caçar o console do
  // service worker para descobrir o óbvio.
  if (job.tabOrigem) {
    chrome.tabs.sendMessage(job.tabOrigem, { de: 'cms-ebm', tipo: 'log', texto: linha })
      .catch(() => {});
  }
}

/** Avisa a Detalhada do andamento. */
function avisar(tipo, texto, extra = {}) {
  if (!job || !job.tabOrigem) return;
  chrome.tabs.sendMessage(job.tabOrigem, {
    de: 'cms-ebm', tipo, texto, passo: job.passo, ...extra,
  }).catch(() => { /* a aba pode ter sido fechada */ });
}

async function encerrar(ok, texto, extra = {}) {
  if (!job) return;
  anotar((ok ? 'PRONTO: ' : 'FALHOU: ') + texto);
  avisar(ok ? 'fim' : 'erro', texto, { log: job.log, ...extra });

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

  if (msg.tipo === 'ping') { responder({ ok: true, versao: '0.3.0' }); return true; }

  // O modal da Detalhada manda o login para cá; daqui ele não volta.
  if (msg.tipo === 'salvarLogin') {
    const u = String(msg.usuario || '').trim(), p = String(msg.senha || '');
    if (!u || !p) { responder({ ok: false, erro: 'Informe usuário e senha.' }); return true; }
    gravarLogin(u, p).then(() => responder({ ok: true }),
                           (e) => responder({ ok: false, erro: String(e && e.message || e) }));
    return true;
  }
  if (msg.tipo === 'esquecerLogin') {
    esquecerLogin().then(() => responder({ ok: true }));
    return true;
  }
  if (msg.tipo === 'temLogin') {
    lerLogin().then((l) => responder({ ok: true, tem: !!l }));
    return true;
  }

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
  job.login = await lerLogin();       // null: sem login guardado
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
  if (!job) {
    // Sem isto, um trabalho que morreu antes da hora deixa o EBM parado
    // numa tela pronta e o log vazio — parece que a página é que falhou.
    console.log('[CMS] chegou', msg.tela, 'mas não há trabalho em curso');
    return { acao: 'nada' };
  }

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
  //
  // Vale em QUALQUER aba do trabalho. O EBM mostra o login num popup
  // (Login.jsp), não na aba principal — restringir à principal deixava
  // o vendedor deslogado esperando em silêncio até o prazo estourar,
  // que é pior do que um aviso a mais.
  if (msg.tela === 'LOGIN') {
    // Se já passamos por uma tela de dentro do EBM, a sessão existe — e
    // este login é o popup de controle de sessão que o EBM abre sozinho.
    // Derrubar o trabalho por causa dele deixava a lista pronta na tela
    // esperando um clique que nunca vinha.
    if (job.viuEbm) {
      anotar(`popup de login ignorado (já estamos dentro): ${url.split('/').pop()}`);
      return { acao: 'nada' };
    }
    anotar(`tela de login em ${url.split('/').pop()}`);

    // Sem login guardado: a Detalhada pede usuário e senha e tenta de novo.
    if (!job.login) {
      encerrar(false, 'Entre no EBM antes de gerar o PDF.', { codigo: 'precisa-login' });
      return { acao: 'nada' };
    }

    // Já mandamos o login e a tela de login voltou. Pode ser recusa, mas
    // também pode ser só o EBM se reorganizando depois de entrar — então
    // primeiro confere: manda a aba para a consulta. Se lá ainda pedir
    // login, aí sim o EBM recusou. (O popup de controle de sessão só
    // aparece depois de estarmos dentro, e esse já é ignorado acima.)
    if (job.loginEnviado) {
      const desde = Date.now() - job.loginEnviado.em;
      if (desde < 4000 || msg.doc === job.loginEnviado.doc) return { acao: 'nada' };
      if (!job.conferindoLogin) {
        job.conferindoLogin = Date.now();
        anotar('a tela de login voltou; conferindo pela consulta');
        chrome.tabs.update(job.tabEbm, { url: URL_CONSULTA }).catch(() => {});
        return { acao: 'nada' };
      }
      if (Date.now() - job.conferindoLogin > 3000) {
        encerrar(false, 'O EBM recusou o usuário ou a senha guardados.', { codigo: 'login-recusado' });
      }
      return { acao: 'nada' };
    }

    // Primeira vez: preenche e entra. Depois do login o EBM pode cair na
    // tela inicial em vez da consulta — se em alguns segundos nenhuma tela
    // de dentro aparecer, a aba é mandada de volta para a consulta.
    job.loginEnviado = { tabId, doc: msg.doc, em: Date.now() };
    avisar('progresso', 'Entrando no EBM…');
    anotar('preenchendo o login guardado');
    const reabrir = () => {
      if (job && !job.viuEbm && job.tabEbm != null) {
        anotar('login feito; abrindo a consulta');
        chrome.tabs.update(job.tabEbm, { url: URL_CONSULTA }).catch(() => {});
      }
    };
    setTimeout(reabrir, 8000);
    setTimeout(reabrir, 20000);
    job.docAtendido = msg.doc;
    return { acao: 'login', usuario: job.login.usuario, senha: job.login.senha };
  }

  // Qualquer tela de dentro prova que a sessão está aberta
  job.viuEbm = true;

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
      // O passo NÃO avança aqui. Se faltar marcar alguma encomenda, a
      // página recarrega e volta a esta tela — e antes, com o passo já em
      // VISUALIZADOR, ela ouvia "não faça nada" e o trabalho travava com
      // a lista pronta na tela, esperando um clique que nunca vinha.
      if (job.passo === 'CONSULTA' || job.passo === 'RESULTADO') {
        // Depois do clique a página se reapresenta como lista, e sem esta
        // pausa o roteiro mandava "visualizar pedido" de novo — caminho
        // curto para dois visualizadores e dois downloads do mesmo pedido.
        const desde = Date.now() - (job.pediuPedidoEm || 0);
        if (desde < 20000) {
          anotar(`lista de novo ${Math.round(desde / 1000)}s após o clique — ignorando`);
          return { acao: 'nada' };
        }

        job.passo = 'RESULTADO';
        job.voltasResultado = (job.voltasResultado || 0) + 1;
        if (job.voltasResultado > 3) {
          encerrar(false, 'A lista de encomendas ficou em laço ao marcar as linhas.');
          return { acao: 'nada' };
        }
        job.pediuPedidoEm = Date.now();
        avisar('progresso', 'Abrindo o pedido…');
        anotar(`passo RESULTADO (volta ${job.voltasResultado})`);
        // Os GCIs vao junto so para o log conseguir dizer "trouxe 1 de 3".
        return marcar({ acao: 'resultado', gcis: job.gcis });
      }
      return { acao: 'nada' };

    case 'DETALHE':
      // Com um GCI só o EBM pula a lista e cai direto no detalhe.
      // Mesmo ponto do roteiro, botão diferente.
      if (job.passo === 'CONSULTA' || job.passo === 'RESULTADO') {
        job.passo = 'RESULTADO';
        avisar('progresso', 'Abrindo o pedido…');
        anotar('passo DETALHE: visualizar pedido');
        return marcar({ acao: 'detalhe' });
      }
      return { acao: 'nada' };

    case 'VISUALIZADOR':
      if (job.passo === 'RESULTADO' || job.passo === 'VISUALIZADOR') {
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
  if (msg.aviso) anotar('página: ' + msg.aviso);
  if (msg.erro) {
    anotar('página relatou: ' + msg.erro);
    encerrar(false, msg.erro, msg.codigo ? { codigo: msg.codigo } : {});
  }
  if (!job && (msg.erro || msg.aviso)) {
    console.log('[CMS] (sem trabalho em curso)', msg.erro || msg.aviso);
  }
});

/* ---------- renomear o PDF que cair ---------- */

chrome.downloads.onDeterminingFilename.addListener((item, sugerir) => {
  if (!job || job.passo !== 'BAIXANDO') return;          // não é nosso
  if (!/ClienteEncomenda.*\.pdf$/i.test(item.filename)) return;

  const nome = limparNome(job.nomeArquivo) + '.pdf';
  anotar(`baixando ${item.filename} → ${nome}`);
  job.downloadId = item.id;
  job.nomeFinal = nome;
  sugerir({ filename: nome, conflictAction: 'uniquify' });
  avisar('progresso', 'Salvando o PDF…');
  // NÃO encerra aqui. Este é só o momento em que o Chrome dá nome ao
  // arquivo — ele ainda está chegando. Encerrar agora fechava a janela do
  // EBM no meio do download: o aviso dizia "salvo" e o arquivo não
  // aparecia na pasta. Quem encerra é o onChanged, abaixo.
});

// O download terminou (ou falhou): só agora o trabalho acaba e a janela do
// EBM pode fechar. O aviso leva o caminho completo, que é o que responde
// "cadê o arquivo?".
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!job || job.downloadId == null || delta.id !== job.downloadId) return;
  const estado = delta.state && delta.state.current;
  if (estado === 'complete') {
    let caminho = '';
    try {
      const [it] = await chrome.downloads.search({ id: delta.id });
      caminho = (it && it.filename) || '';
    } catch (e) { /* sem o caminho, fica o nome */ }
    anotar(`download concluído: ${caminho || job.nomeFinal}`);
    encerrar(true, caminho ? `PDF salvo em ${caminho}` : `PDF salvo como ${job.nomeFinal}`, { caminho });
  } else if (estado === 'interrupted') {
    const motivo = (delta.error && delta.error.current) || 'motivo desconhecido';
    encerrar(false, `O download do PDF não terminou (${motivo}). Veja em chrome://downloads.`);
  }
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
