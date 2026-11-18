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
    // 'pdf' e o que a Detalhada sempre pediu e segue sendo o padrao. O
    // Controle de Estoque pede 'xls': o mesmo relatorio em planilha, com
    // grade, saldo por tamanho e EBM — o que o lote precisa e o PDF nao
    // entrega de forma legivel.
    formato: dados.formato === 'xls' ? 'xls' : 'pdf',
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

  // Um trabalho que empacou segura todos os outros por oito minutos — o
  // prazo do vigia. Quem pediu pode desistir e liberar a vez.
  if (msg.tipo === 'cancelar') {
    if (job) { encerrar(false, 'Cancelado por quem pediu.'); responder({ ok: true, tinha: true }); }
    else responder({ ok: true, tinha: false });
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
        avisar('progresso', job.formato === 'xls' ? 'Gerando a planilha…' : 'Gerando o PDF…');
        anotar('passo VISUALIZADOR: clicando no disquete');
        return marcar({ acao: 'exportar' });
      }
      return { acao: 'nada' };

    case 'FORMATO':
      if (job.passo === 'FORMATO') {
        job.passo = 'BAIXANDO';
        anotar(`passo FORMATO: ${job.formato} + OK`);
        return marcar({ acao: 'confirmar', formato: job.formato });
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
  // O "selecionar todos" recarrega a lista: ela tem de ser atendida de novo,
  // e a pausa contra o clique duplo só começa quando o pedido for clicado.
  if (job && msg.refazLista) job.pediuPedidoEm = 0;
  if (job && msg.clicouPedido) job.pediuPedidoEm = Date.now();
  if (msg.erro) {
    anotar('página relatou: ' + msg.erro);
    encerrar(false, msg.erro, msg.codigo
      ? { codigo: msg.codigo, ...(msg.cabem ? { cabem: msg.cabem } : {}) }
      : {});
  }
  if (!job && (msg.erro || msg.aviso)) {
    console.log('[CMS] (sem trabalho em curso)', msg.erro || msg.aviso);
  }
});

/* ---------- renomear o PDF que cair ---------- */

chrome.downloads.onDeterminingFilename.addListener((item, sugerir) => {
  if (!job || job.passo !== 'BAIXANDO') return;          // não é nosso
  const ext = job.formato === 'xls' ? 'xls' : 'pdf';
  if (!new RegExp(`ClienteEncomenda.*\.${ext}$`, 'i').test(item.filename)) return;

  const nome = limparNome(job.nomeArquivo) + '.' + ext;
  anotar(`baixando ${item.filename} → ${nome}`);
  job.downloadId = item.id;
  job.nomeFinal = nome;
  sugerir({ filename: nome, conflictAction: 'uniquify' });
  avisar('progresso', job.formato === 'xls' ? 'Salvando a planilha…' : 'Salvando o PDF…');
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
    // A planilha é para ser lida por outra tela, não para ficar numa pasta:
    // vai junto, em base64, para quem pediu. Se o EBM não servir o arquivo
    // uma segunda vez, segue só o caminho e quem pediu resolve pedindo o
    // arquivo ao usuário.
    let conteudo = null;
    if (job.formato === 'xls') {
      try {
        const [it] = await chrome.downloads.search({ id: delta.id });
        const url = (it && (it.finalUrl || it.url)) || '';
        if (url) {
          const r = await fetch(url, { credentials: 'include' });
          if (r.ok) conteudo = await paraBase64(r);
          else anotar(`o EBM não serviu a planilha de novo: HTTP ${r.status}`);
        }
      } catch (e) { anotar(`o EBM não serviu a planilha de novo: ${e && e.message || e}`); }

      // O relatório do EBM é de uso único: a mesma URL não entrega duas vezes.
      // Então vale ler o arquivo que acabou de ser salvo — o que só funciona
      // com "Permitir acesso a URLs de arquivo" ligado nesta extensão.
      if (!conteudo && caminho) {
        try {
          const r = await fetch("file:///" + caminho.replaceAll(String.fromCharCode(92), "/"));
          if (r.ok) conteudo = await paraBase64(r);
          else anotar(`não consegui ler o arquivo salvo: HTTP ${r.status}`);
        } catch (e) {
          anotar(`não consegui ler o arquivo salvo (ligue "Permitir acesso a URLs de arquivo"): ${e && e.message || e}`);
        }
      }
    }
    const oque = job.formato === 'xls' ? 'Planilha' : 'PDF';
    encerrar(true, caminho ? `${oque} salvo em ${caminho}` : `${oque} salvo como ${job.nomeFinal}`,
             { caminho, conteudo, formato: job.formato });
  } else if (estado === 'interrupted') {
    const motivo = (delta.error && delta.error.current) || 'motivo desconhecido';
    encerrar(false, `O download não terminou (${motivo}). Veja em chrome://downloads.`);
  }
});

/** Corpo da resposta em base64, que é como o conteúdo viaja até a página. */
async function paraBase64(r) {
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  anotar(`planilha lida: ${buf.length} bytes`);
  return btoa(bin);
}

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

/* ============================================================
   DESMEMBRAMENTO — ORQUESTRADOR
   ============================================================
   Vive ao lado do trabalho do PDF, sem se misturar com ele: outro job,
   outro alarme, outras mensagens. O que os dois têm em comum é o
   desenho — a página do EBM se apresenta, aqui se decide o que ela faz,
   e o estado mora neste arquivo porque o content script morre a cada
   postback.

   Esta versão só CONFERE: abre cada pedido mãe da lista, lê os artigos
   e devolve. Nada é marcado, digitado ou gerado. A conferência é o
   passo que falta no robô de hoje — lá os problemas só aparecem quando
   a digitação já está em curso.

   O roteiro, por pedido:
     RESULTADO/clicar  → marca a linha, dá o postback e clica em manutenção
     MANUTENCAO/ler    → lê os artigos e volta para a lista
   ============================================================ */

const DESM_VIGIA = 'cms-desm-vigia';
const DESM_PRAZO = 10 * 60 * 1000;
let jobDesm = null;

function desmAnotar(texto, tag = 'info') {
  const linha = `${new Date().toLocaleTimeString('pt-BR')}  ${texto}`;
  console.log('[CMS-DESM]', linha);
  if (!jobDesm) return;
  jobDesm.log.push({ txt: texto, tag, em: Date.now() });
  desmAvisar({ tipo: 'log', texto, tag });
}

function desmAvisar(msg) {
  if (!jobDesm || jobDesm.tabOrigem == null) return;
  chrome.tabs.sendMessage(jobDesm.tabOrigem, { de: 'cms-desm', ...msg }).catch(() => {});
}

function desmEncerrar(ok, texto, extra = {}) {
  if (!jobDesm) return;
  desmAnotar((ok ? 'PRONTO: ' : 'PAROU: ') + texto, ok ? 'ok' : 'erro');
  desmAvisar({ tipo: 'fim', ok, texto, lidos: jobDesm.lidos, log: jobDesm.log, ...extra });
  chrome.alarms.clear(DESM_VIGIA);
  jobDesm = null;
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== DESM_VIGIA) return;
  if (!jobDesm) { chrome.alarms.clear(DESM_VIGIA); return; }
  if (Date.now() > jobDesm.prazo) {
    desmEncerrar(false, `O EBM nao respondeu a tempo (parou em ${jobDesm.etapa}).`);
  }
});

/* O gatilho do content script é a tela MUDAR. Quando o roteiro precisa
   seguir sem que nada mude na tela (um pedido que não abriu, a vez do
   próximo), é daqui que vem o empurrão. */
function desmCutucar(ms = 900) {
  if (!jobDesm) return;
  const tab = jobDesm.tabEbm;
  setTimeout(() => {
    chrome.tabs.sendMessage(tab, { de: 'cms-desm', tipo: 'acorda' }).catch(() => {});
  }, ms);
}

/** A aba do EBM que já está aberta. O desmembramento não abre janela
 *  escondida como o PDF: quem confere quer ver a tela trabalhando, e o
 *  EBM precisa da sessão que a pessoa já abriu. */
async function abaDoEbm() {
  const abas = await chrome.tabs.query({ url: '*://*.vulcabras.com.br/ebm4web/*' });
  return abas && abas.length ? abas[0] : null;
}

async function desmIniciar(pacote, tabOrigem, piloto, modo) {
  /* Antes a aba tinha de estar aberta e na tela certa. Agora, se não
     houver nenhuma, a extensão abre o EBM sozinha — e dali em diante o
     roteiro resolve login, menu e consulta. */
  let aba = await abaDoEbm();
  let abriu = false;
  if (!aba) {
    aba = await chrome.tabs.create({ url: URL_LOGIN, active: false });
    abriu = true;
  }
  /* O piloto trabalha UM cliente de UM pedido: é o primeiro contato da
     extensão com a parte que escreve no EBM, e ninguém quer descobrir um
     engano depois de dezesseis digitações. */
  const ebms = piloto && piloto.ebm
    ? [String(piloto.ebm)]
    : pacote.pedidos.map(p => String(p.ebm)).filter(Boolean);
  const id = 'desm_' + Date.now();
  jobDesm = {
    id, modo: modo || (piloto ? 'piloto' : 'conferir'), piloto: piloto || null,
    pacote, ebms, fila: [...ebms], atual: null, etapa: 'inicio',
    lidos: {}, log: [], tabOrigem, tabEbm: aba.id,
    prazo: Date.now() + DESM_PRAZO,
  };
  jobDesm.abriuAba = abriu;
  jobDesm.login = await lerLogin();
  chrome.alarms.create(DESM_VIGIA, { periodInMinutes: 0.5 });
  desmAnotar(piloto
    ? `piloto: pedido mae ${ebms[0]}, cliente ${piloto.cod} (${piloto.pedidoCliente})`
    : `conferencia de ${ebms.length} pedido(s) mae: ${ebms.join(', ')}`, 'acao');

  /* A tela pode estar parada há minutos; sem o cutucão ninguém fala. E
     recarregar a extensão mata os scripts já injetados: a aba do EBM
     fica com uma versão órfã, que não responde nem avisa. Por isso o
     silêncio aqui vira instrução, e não espera. */
  let acordou = abriu;
  if (abriu) {
    desmAnotar('abri o EBM numa aba nova; vou entrar e consultar sozinho.', 'acao');
  } else {
    try {
      const r = await chrome.tabs.sendMessage(aba.id, { de: 'cms-desm', tipo: 'acorda' });
      if (r && r.tela) { acordou = true; desmAnotar(`tela do EBM: ${r.tela}`, 'info'); }
    } catch (e) { /* ninguém do outro lado */ }
    if (!acordou) {
      desmAnotar('a aba do EBM nao reagiu - vou recarrega-la.', 'warn');
      try { await chrome.tabs.reload(aba.id); acordou = true; } catch (e) { /* segue */ }
    }
  }

  /* Rede de segurança: se em 12 segundos a página do EBM não falou nada,
     não adianta esperar o prazo de 10 minutos para dizer o óbvio. */
  setTimeout(() => {
    if (jobDesm && jobDesm.id === id && jobDesm.etapa === 'inicio' && !jobDesm.abriuAba) {
      desmEncerrar(false, 'A aba do EBM nao respondeu. Confira se ela esta na '
        + 'tela "Desmembrar Pedido Mae" com a LISTA dos pedidos e de F5 nela.',
        { codigo: 'ebm-mudo' });
    }
  }, 12000);
  return { ok: true };
}

/** O que a página do EBM deve fazer agora. */
function desmComando(msg, sender) {
  if (!jobDesm) return { acao: 'nada' };
  if (Date.now() > jobDesm.prazo) { desmEncerrar(false, 'Tempo esgotado.'); return { acao: 'nada' }; }
  // só a aba do trabalho manda; outras janelas do EBM ficam de fora
  if (sender.tab && sender.tab.id !== jobDesm.tabEbm) return { acao: 'nada' };
  jobDesm.prazo = Date.now() + DESM_PRAZO;

  if (msg.tela === 'LOGIN') {
    if (!jobDesm.login) {
      desmEncerrar(false, 'O EBM pediu login e a extensao nao tem um guardado. '
        + 'Entre no EBM uma vez (ou salve o login pela Detalhada) e repita.',
        { codigo: 'precisa-login' });
      return { acao: 'nada' };
    }
    if (jobDesm.tentouLogin) {
      desmEncerrar(false, 'O EBM recusou o login guardado.', { codigo: 'precisa-login' });
      return { acao: 'nada' };
    }
    jobDesm.tentouLogin = true;
    desmAnotar('entrando no EBM...', 'acao');
    return { acao: 'login', usuario: jobDesm.login.usuario, senha: jobDesm.login.senha };
  }

  if (msg.tela === 'MENU') {
    /* O CABEÇALHO DO EBM É OUTRO FRAME, e tem o campo Funcionalidade:
       ele se apresenta como "MENU" em qualquer tela. Depois que algum
       frame mostrou tela de dentro (critérios, lista, manutenção), o
       menu não manda mais nada - senão ele navega por cima do trabalho
       que o outro frame está fazendo, que foi o que derrubou a consulta
       no meio. */
    if (jobDesm.viuDentro) return { acao: 'nada' };
    /* Chegar ao menu três vezes quer dizer que a navegação não está
       saindo do lugar — repetir vira laço, e foi o que aconteceu. */
    jobDesm.noMenu = (jobDesm.noMenu || 0) + 1;
    if (jobDesm.noMenu > 3) {
      desmEncerrar(false, 'Nao consegui abrir o Desmembrar Pedido Mae sozinho. '
        + 'Abra a tela no EBM (Funcionalidade FUC1515), consulte os pedidos e '
        + 'tente de novo.', { codigo: 'sem-navegacao' });
      return { acao: 'nada' };
    }
    desmAnotar(`abrindo Desmembrar Pedido Mae (${jobDesm.noMenu}/3)...`, 'acao');
    return { acao: 'irParaConsulta' };
  }

  if (msg.tela === 'CONSULTA' || msg.tela === 'RESULTADO'
      || msg.tela === 'MANUTENCAO' || msg.tela === 'ITEM') {
    jobDesm.viuDentro = true;
  }

  if (msg.tela === 'CONSULTA') {
    /* Voltar para os critérios depois de consultar significa que a lista
       não abriu. Uma segunda tentativa resolve tropeço de ajax; a
       terceira seria teimosia. */
    jobDesm.consultou = (jobDesm.consultou || 0) + 1;
    if (jobDesm.consultou > 2) {
      desmEncerrar(false, 'A consulta nao trouxe a lista de pedidos. '
        + 'Confira os numeros e o status das encomendas no EBM.');
      return { acao: 'nada' };
    }
    if (jobDesm.consultou > 1) {
      desmAnotar('voltei para os criterios; refazendo a consulta...', 'warn');
    }
    desmAnotar(`consultando ${jobDesm.ebms.length} pedido(s): ${jobDesm.ebms.join(', ')}`, 'acao');
    return { acao: 'montarConsulta', ebms: jobDesm.ebms };
  }

  if (msg.tela === 'RESULTADO') {
    // nada em curso: ou acabou, ou é hora do próximo
    if (!jobDesm.atual) {
      if (!jobDesm.fila.length) {
        const n = Object.keys(jobDesm.lidos).length;
        desmEncerrar(true, `${n} de ${jobDesm.ebms.length} pedido(s) mae conferido(s).`);
        return { acao: 'nada' };
      }
      jobDesm.atual = jobDesm.fila.shift();
      jobDesm.tentativas = 0;
      jobDesm.etapa = 'selecionar';
      desmAnotar(`pedido mae ${jobDesm.atual}: abrindo...`, 'acao');
      return { acao: 'selecionarLinha', ebm: jobDesm.atual };
    }
    // a lista voltou do postback do grid: agora é clicar
    if (jobDesm.etapa === 'selecionar') {
      jobDesm.etapa = 'clicar';
      return { acao: 'clicarManter', ebm: jobDesm.atual };
    }
    /* Voltamos para a lista sem a manutenção ter aberto. Acontece quando
       o EBM não registrou a seleção — o robô também repete nesse caso.
       Duas tentativas; depois o pedido fica anotado como não aberto e a
       conferência segue, que é melhor do que travar no primeiro teimoso. */
    jobDesm.tentativas = (jobDesm.tentativas || 0) + 1;
    if (jobDesm.tentativas > 2) {
      desmAnotar(`${jobDesm.atual}: a manutencao nao abriu em 2 tentativas.`, 'erro');
      jobDesm.lidos[jobDesm.atual] = { erro: 'a manutencao nao abriu' };
      jobDesm.atual = null;
      desmCutucar();
      return { acao: 'nada' };
    }
    desmAnotar(`${jobDesm.atual}: o EBM nao registrou a selecao; repetindo `
               + `(${jobDesm.tentativas}/2)...`, 'warn');
    jobDesm.etapa = 'selecionar';
    return { acao: 'selecionarLinha', ebm: jobDesm.atual };
  }

  if (msg.tela === 'MANUTENCAO') {
    if (jobDesm.atual && jobDesm.modo === 'raiox') {
      if (jobDesm.etapa === 'fim') return { acao: 'nada' };
      jobDesm.etapa = 'fim';
      return { acao: 'raioX', ebm: jobDesm.atual };
    }
    if (jobDesm.atual && jobDesm.modo === 'piloto') {
      /* ESCREVER NA TELA DO EBM FAZ POSTBACK. O content script morre, a
         página nova se apresenta e, se o roteiro recomeçasse do zero,
         criaria outra linha de cliente a cada volta - foi o que encheu a
         Cliente Carteira de linhas vazias no primeiro teste. Por isso o
         preparo é dividido em etapas, e cada fala da página leva a
         PRÓXIMA, nunca a mesma. */
      if (jobDesm.etapa === 'preparado' || jobDesm.etapa === 'fim') return { acao: 'nada' };

      /* 'clicar' é a etapa em que a manutenção acaba de abrir (o RESULTADO
         a deixa assim ao clicar em manutenção). Esquecer dela fazia o
         roteiro chegar na tela certa e não começar nada. */
      if (jobDesm.etapa === 'clicar' || jobDesm.etapa === 'ler'
          || jobDesm.etapa === 'inicio') {
        jobDesm.etapa = 'cliente';
        jobDesm.voltas = 0;
        return { acao: 'informarCliente', ebm: jobDesm.atual, cliente: jobDesm.piloto };
      }
      if (jobDesm.etapa === 'cliente') {
        // voltou do postback de escrever o código: conferir e marcar
        jobDesm.voltas = (jobDesm.voltas || 0) + 1;
        if (jobDesm.voltas > 4) {
          desmEncerrar(false, 'O EBM ficou recarregando sem fixar o cliente. '
            + 'Cancele o desmembramento na tela e tente de novo.');
          return { acao: 'nada' };
        }
        return { acao: 'marcarCliente', ebm: jobDesm.atual, cliente: jobDesm.piloto };
      }
      if (jobDesm.etapa === 'artigos') {
        return { acao: 'adicionarArtigos', ebm: jobDesm.atual, cliente: jobDesm.piloto };
      }
      if (jobDesm.etapa === 'preencher') {
        return { acao: 'preencherLinhas', ebm: jobDesm.atual, cliente: jobDesm.piloto };
      }
      return { acao: 'nada' };
    }
    if (jobDesm.atual) {
      jobDesm.etapa = 'lendo';
      return { acao: 'lerPedido', ebm: jobDesm.atual };
    }
    // manutenção aberta fora de hora (a pessoa deixou um pedido aberto):
    // volta para a lista, que é de onde o roteiro sabe andar
    desmAnotar('havia um pedido aberto na tela; voltando para a lista...', 'warn');
    return { acao: 'voltar' };
  }

  return { acao: 'nada' };
}

/** O que a página relatou (leitura, erro, pedido fora da lista). */
function desmRelato(msg) {
  if (!jobDesm) return;
  if (msg.resultado === 'nao-achou') {
    desmAnotar(`${msg.ebm}: ${msg.texto}`, 'erro');
    jobDesm.lidos[msg.ebm] = { erro: msg.texto };
    jobDesm.atual = null;
    jobDesm.etapa = 'proximo';
    return;
  }
  if (msg.resultado === 'leitura') {
    const d = msg.dados || {};
    jobDesm.lidos[msg.ebm] = d;
    const art = d.artigos || [];
    desmAnotar(`${msg.ebm}: ${art.length} artigo(s) na tela`
      + (d.digitacoesExistentes ? `, ${d.digitacoesExistentes} digitacao(oes) ja salva(s)` : '')
      + (d.pedidoNaTela && String(d.pedidoNaTela) !== String(msg.ebm)
          ? ` - ATENCAO: o cabecalho diz ${d.pedidoNaTela}` : ''), 'ok');
    for (const a of art) {
      desmAnotar(`   ${a.codigo} ${a.cor} - grade ${a.grade || '?'} `
        + `a partir do ${a.tamInicial || '?'} - saldo ${a.saldo}`, 'info');
    }
    if ((d.mensagens || []).length) desmAnotar('   EBM: ' + d.mensagens.join(' | '), 'warn');
    desmAvisar({ tipo: 'pedido', ebm: msg.ebm, dados: d });
    jobDesm.atual = null;
    jobDesm.etapa = 'proximo';
    return;
  }
  if (msg.resultado === 'limpou') {
    desmAnotar(`${msg.ebm}: ${msg.texto}`, 'warn');
    jobDesm.etapa = 'inicio';
    desmCutucar(2500);
    return;
  }
  if (msg.resultado === 'cliente-ok') {
    jobDesm.etapa = 'artigos';
    desmAnotar(`   cliente ${msg.cod} marcado na Cliente Carteira`
      + (msg.razao ? ` (${msg.razao})` : ''), 'ok');
    desmCutucar();
    return;
  }
  if (msg.resultado === 'artigos-ok') {
    jobDesm.etapa = 'preencher';
    desmAnotar(`   ${msg.quantas} linha(s) criada(s) em "Artigos desmembramento"`, 'ok');
    desmCutucar();
    return;
  }
  if (msg.resultado === 'preparado') {
    const d = msg.dados || {};
    jobDesm.etapa = 'preparado';
    desmAnotar(`${msg.ebm}: cliente ${d.cliente} preenchido como "${d.pedidoCliente}".`, 'ok');
    for (const l of (d.linhas || [])) {
      desmAnotar(`   linha ${l.linha + 1}: ${l.caixas} caixa(s)`
        + (l.total ? `, Qtd. ${l.total} na tela` : '')
        + (l.okPed ? '' : ' - NAO consegui escrever o Pedido do Cliente')
        + (l.okCx ? '' : ' - NAO consegui escrever as caixas'), 'info');
    }
    if ((d.avisos || []).length) desmAnotar('   EBM avisou: ' + d.avisos.join(' | '), 'warn');
    if ((d.mensagens || []).length) desmAnotar('   tela: ' + d.mensagens.join(' | '), 'warn');
    desmAnotar('PARADO antes de salvar. Confira a tela do EBM e decida.', 'acao');
    desmAvisar({ tipo: 'preparado', ebm: msg.ebm, dados: d });
    return;
  }
  if (msg.resultado === 'salvou') {
    const d = msg.dados || {};
    if (msg.ok) {
      desmAnotar(`${msg.ebm}: desmembramento SALVO`
        + (d.digitacoes ? ` (a tela mostra ${d.digitacoes} digitacao(oes))` : '') + '.', 'ok');
    } else {
      desmAnotar(`${msg.ebm}: o salvar NAO concluiu - a linha continua na tela`
        + ((d.avisos || []).length ? ' - ' + d.avisos.join(' | ') : '')
        + ((d.mensagens || []).length ? ' - ' + d.mensagens.join(' | ') : '') + '.', 'erro');
    }
    jobDesm.etapa = 'fim';
    desmAvisar({ tipo: 'salvou', ebm: msg.ebm, ok: !!msg.ok, dados: d });
    desmEncerrar(!!msg.ok, msg.ok ? 'Digitacao salva no EBM.' : 'O EBM nao salvou.');
    return;
  }
  if (msg.resultado === 'cancelou') {
    jobDesm.etapa = 'fim';
    desmEncerrar(true, 'Cancelado na tela do EBM. Nada foi salvo.');
    return;
  }
  if (msg.resultado === 'consultando') {
    desmAnotar('   ' + msg.texto, 'info');
    return;
  }
  if (msg.resultado === 'raiox') {
    const d = msg.dados || {};
    desmAnotar('RAIO-X da tela (nada foi alterado):', 'acao');
    desmAnotar(`   carteira antes=${d.antes.carteira} linha(s), depois do clique=`
      + `${d.depois.carteira} | grupo antes=${d.antes.grupo}, depois=${d.depois.grupo}`,
      d.depois.carteira > d.antes.carteira ? 'ok' : 'erro');
    for (const c of (d.candidatos || [])) {
      desmAnotar(`   <${c.tag}${c.id ? ' id=' + c.id : ''}> "${c.texto}"`
        + (c.classe ? ` class=${c.classe}` : '')
        + (c.href ? ` href=${c.href}` : '')
        + (c.onclick ? ` onclick=${c.onclick}` : '')
        + (c.paiOnclick ? ` | pai <${c.paiTag} ${c.paiId}> onclick=${c.paiOnclick}` : ''), 'info');
    }
    const cf = (d.diag && d.diag.camposFiltro) || [];
    if (cf.length) desmAnotar('   campos de filtro visiveis: ' + cf.join(' ; '), 'info');
    jobDesm.etapa = 'fim';
    desmEncerrar(true, 'Raio-X concluido. Nada foi alterado no EBM.');
    return;
  }
  if (msg.resultado === 'falhou') {
    desmAnotar(`${msg.ebm}: ${msg.texto}`, 'erro');
    if (msg.diag) {
      const d = msg.diag;
      desmAnotar(`   tela: carteira=${d.temGradeCarteira ? d.linhasCarteira + ' linha(s)' : 'NAO EXISTE'}`
        + ` | artigos=${d.temGradeArtigo} | grupo=${d.temGradeGrupo} | desm=${d.temGradeDesm}`, 'warn');
      if ((d.gradesNaTela || []).length)
        desmAnotar('   grades: ' + d.gradesNaTela.join(', '), 'info');
      if ((d.abas || []).length) desmAnotar('   abas/rotulos: ' + d.abas.join(' / '), 'info');
      if ((d.imagens || []).length) desmAnotar('   icones: ' + d.imagens.join(' ; '), 'info');
    }
    jobDesm.etapa = 'fim';
    desmEncerrar(false, msg.texto || 'Nao consegui preparar a digitacao.');
    return;
  }
  if (msg.erro) desmAnotar(`${msg.tela || ''}: ${msg.erro}`, 'erro');
}

/** Manda a página do EBM executar algo agora (salvar, cancelar). */
async function desmExecutar(acao, cmd) {
  if (!jobDesm) return { ok: false, erro: 'Nao ha trabalho em curso.' };
  try {
    await chrome.tabs.sendMessage(jobDesm.tabEbm,
      { de: 'cms-desm', tipo: 'executar', acao, cmd: cmd || {} });
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: 'A aba do EBM nao respondeu. De F5 nela.' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (msg && msg.de === 'cms-desm-pagina') {
    if (msg.tela && !msg.resultado && !msg.erro) {
      responder(desmComando(msg, sender));
    } else {
      desmRelato(msg);
      responder({ ok: true });
    }
    return true;
  }
  if (!msg || msg.de !== 'cms-desm-app') return;

  if (msg.tipo === 'raiox') {
    if (jobDesm) { responder({ ok: false, erro: 'Ja existe um trabalho em curso.' }); return true; }
    desmIniciar(msg.pacote, sender.tab && sender.tab.id, msg.cliente, 'raiox').then(responder,
      (e) => responder({ ok: false, erro: String(e && e.message || e) }));
    return true;
  }
  if (msg.tipo === 'conferir' || msg.tipo === 'piloto') {
    if (jobDesm) { responder({ ok: false, erro: 'Ja existe um trabalho em curso.' }); return true; }
    desmIniciar(msg.pacote, sender.tab && sender.tab.id,
                msg.tipo === 'piloto' ? msg.cliente : null).then(responder,
      (e) => responder({ ok: false, erro: String(e && e.message || e) }));
    return true;
  }
  if (msg.tipo === 'salvarPiloto' || msg.tipo === 'cancelarPiloto') {
    if (!jobDesm || jobDesm.etapa !== 'preparado') {
      responder({ ok: false, erro: 'Nao ha digitacao preparada esperando decisao.' });
      return true;
    }
    desmAnotar(msg.tipo === 'salvarPiloto' ? 'salvando...' : 'cancelando na tela...', 'acao');
    desmExecutar(msg.tipo === 'salvarPiloto' ? 'salvarCliente' : 'cancelarNaTela',
                 { ebm: jobDesm.atual }).then(responder);
    return true;
  }
  if (msg.tipo === 'parar') {
    const tinha = !!jobDesm;
    if (jobDesm) desmEncerrar(false, 'Parado por voce.');
    responder({ ok: true, tinha });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (jobDesm && tabId === jobDesm.tabEbm) {
    desmEncerrar(false, 'A aba do EBM foi fechada antes de terminar.');
  }
});
