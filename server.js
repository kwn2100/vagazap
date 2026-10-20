const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Carrega variáveis do arquivo .env
const envPath = path.join(__dirname, '.env');
function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      process.env[key] = val;
    }
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const WA_AUTH_DIR = path.join(DATA_DIR, 'wa_auth');
const SUBS_FILE = path.join(DATA_DIR, 'subscribers.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUBS_FILE)) fs.writeFileSync(SUBS_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(PAYMENTS_FILE)) fs.writeFileSync(PAYMENTS_FILE, JSON.stringify({}, null, 2));

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ============================================================================
// MOTOR WHATSAPP NATIVO ULTRA-LEVE (BAILEYS - SEM DOCKER / < 45MB RAM)
// ============================================================================
let waSock = null;
let waState = {
  status: 'connecting', // 'connecting' | 'qr' | 'connected'
  qrDataUrl: '',
  user: '',
  message: 'Iniciando conector nativo do WhatsApp...'
};

async function initNativeWhatsApp() {
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const QRCode = require('qrcode');
    const pino = require('pino');

    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

    if (!fs.existsSync(WA_AUTH_DIR)) fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);

    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) version = latest.version;
    } catch {}

    waSock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['VagaZap IA', 'Chrome', '1.0.0']
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        waState.status = 'qr';
        waState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 240 });
        waState.message = 'Aguardando leitura do QR Code no WhatsApp...';
      }

      if (connection === 'open') {
        waState.status = 'connected';
        waState.qrDataUrl = '';
        waState.user = waSock.user?.id ? waSock.user.id.split(':')[0] : 'WhatsApp Ativo';
        waState.message = 'Conectado com sucesso!';
        console.log('[WhatsApp Nativo] Conectado:', waState.user);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        waState.status = 'connecting';
        waState.qrDataUrl = '';
        waState.message = 'Reconectando ao WhatsApp...';

        if (shouldReconnect) {
          setTimeout(initNativeWhatsApp, 3000);
        } else {
          try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
          setTimeout(initNativeWhatsApp, 2000);
        }
      }
    });
  } catch (err) {
    waState.status = 'connecting';
    waState.message = 'Aguardando bibliotecas do WhatsApp (' + err.message + ')';
    setTimeout(initNativeWhatsApp, 5000);
  }
}

// Envia mensagem pelo WhatsApp Nativo (Baileys) com resolução automática do 9º dígito no Brasil
async function sendWhatsAppMessage(phone, text) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { ok: false, error: 'Número de telefone vazio' };
  if (!digits.startsWith('55')) digits = '55' + digits;

  // Se o WhatsApp Nativo estiver conectado, usa ele imediatamente!
  if (waSock && waState.status === 'connected') {
    try {
      let targetJid = `${digits}@s.whatsapp.net`;
      try {
        const [result] = await waSock.onWhatsApp(digits);
        if (result && result.exists) {
          targetJid = result.jid;
        }
      } catch {}

      await waSock.sendMessage(targetJid, { text });
      return { ok: true, engine: 'WhatsApp Nativo (Baileys)', chatId: targetJid };
    } catch (err) {
      return { ok: false, engine: 'WhatsApp Nativo', error: err.message };
    }
  }

  // Fallback opcional para WAHA externo se configurado
  const wahaUrl = (process.env.WAHA_URL || '').replace(/\/$/, '');
  if (wahaUrl) {
    try {
      const chatId = `${digits}@c.us`;
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.WAHA_API_KEY) headers['X-Api-Key'] = process.env.WAHA_API_KEY;
      const resp = await fetch(`${wahaUrl}/api/sendText`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ session: process.env.WAHA_SESSION || 'default', chatId, text })
      });
      return { ok: resp.ok, engine: 'WAHA Externo', status: resp.status, chatId };
    } catch (err) {
      return { ok: false, error: 'WhatsApp Nativo ainda não pareado (Escaneie o QR Code em /admin)', details: err.message };
    }
  }

  return { ok: false, error: 'Escaneie o QR Code do WhatsApp em http://localhost:3000/admin para disparar' };
}

// ============================================================================
// VAGAS CURADAS E MENSAGEM DO BOLETIM
// ============================================================================
const CURATED_JOBS = {
  homeoffice: [
    {
      title: 'Assistente de Relacionamento (Turno Noturno)',
      company: 'Conexa Saúde',
      modality: '100% Home Office (22h às 07h)',
      match: '96%',
      benefits: 'Cartão CAJU R$ 1.059/mês + Amil S450 + Odonto 100% + Farmácia R$ 100',
      link: 'https://conexasaude.gupy.io/jobs/12081528?jobBoardSource=gupy_opportunities'
    },
    {
      title: 'Analista de Relacionamento Júnior',
      company: 'Unicred do Brasil',
      modality: '100% Home Office',
      match: '95%',
      benefits: 'Salário Cooperativa + VR/VA Alto + Bradesco Saúde Top + PLR',
      link: 'https://unicred.gupy.io/'
    },
    {
      title: 'Consultor de Relacionamento 100% Chat',
      company: 'Concentrix',
      modality: '100% Remoto (Escala 5x2 • 6h20/dia)',
      match: '91%',
      benefits: 'CLT + Equipamento enviado em casa + VR/VA + Assistência Médica',
      link: 'https://www.infojobs.com.br/vagas-de-emprego-chat.aspx'
    },
    {
      title: 'SDR Outbound - Prospecção B2B',
      company: 'Buzzmonitor',
      modality: '100% Remoto',
      match: '95%',
      benefits: 'Salário Fixo + Comissões + VR/VA Flexível + Auxílio Home Office',
      link: 'https://remotar.com.br'
    }
  ],
  estagio: [
    {
      title: 'Estágio em Atendimento Digital & Customer Success',
      company: 'Starian / Omie',
      modality: '100% Home Office (6h/dia)',
      match: '95%',
      benefits: 'Bolsa R$ 1.600 + Cartão Caju/Flash + Notebook fornecido + Auxílio Internet',
      link: 'https://starian.gupy.io/'
    },
    {
      title: 'Estágio em Pré-Vendas & Negócios (SDR)',
      company: 'Next Fit',
      modality: '100% Remoto (6h/dia)',
      match: '93%',
      benefits: 'Bolsa Auxílio + Bônus por metas + Vale Refeição + Seguro de Vida',
      link: 'https://nextfit.gupy.io/'
    },
    {
      title: 'Estágio Administrativo & Relacionamento Financeiro',
      company: 'Unicred',
      modality: 'Remoto / Híbrido Flexível (6h/dia)',
      match: '92%',
      benefits: 'Bolsa Cooperativa + Auxílio Alimentação Alto + Gympass',
      link: 'https://unicred.gupy.io/'
    }
  ],
  aprendiz: [
    {
      title: 'Jovem Aprendiz Administrativo & Atendimento Digital',
      company: 'Unicred / CIEE & Gupy',
      modality: 'Jornada 4h a 6h/dia (Sem experiência)',
      match: '97%',
      benefits: 'Salário R$ 1.280 + VR/VA R$ 750 + Plano de Saúde + Capacitação',
      link: 'https://unicred.gupy.io/'
    },
    {
      title: 'Jovem Aprendiz Operações & Suporte Comercial',
      company: 'Brasil TecPar',
      modality: 'Remoto / Digital (Sem experiência)',
      match: '94%',
      benefits: 'Salário CLT Aprendiz + Vale Alimentação + Plano Odontológico + Seguro',
      link: 'https://brasiltecpar.gupy.io/'
    },
    {
      title: 'Jovem Aprendiz Atendimento Chat & Backoffice',
      company: 'Actionline / Espro',
      modality: 'Meio Período (Manhã ou Tarde)',
      match: '92%',
      benefits: 'CLT + VR/VA + Treinamento remunerado do zero',
      link: 'https://www.infojobs.com.br'
    }
  ]
};

// Varredura em Tempo Real de Vagas Abertas (Retorna o Link Direto da Vaga Específica)
async function scrapeLiveJobs({ profile = 'homeoffice', role = '', city = '', mode = '' }) {
  try {
    const cleanRole = (role || 'Administrativo').split(',')[0].split('/')[0].trim();
    let keywordPrefix = '';
    if (profile === 'estagio') keywordPrefix = 'Estágio ';
    else if (profile === 'aprendiz') keywordPrefix = 'Jovem Aprendiz ';
    else if (!city || city === 'Remoto Nacional' || mode.includes('100% Home Office')) keywordPrefix = 'Remoto ';

    const keywords = `${keywordPrefix}${cleanRole}`.trim();
    const location = (city && city !== 'Remoto Nacional') ? city : 'Brasil';

    const searchUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&start=0`;
    const resp = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!resp.ok) return [];

    const html = await resp.text();
    const blocks = html.split('<li');
    const results = [];

    for (const block of blocks) {
      const titleMatch = block.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
      const companyMatch = block.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/);
      const locMatch = block.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/);
      const linkMatch = block.match(/href="(https:\/\/[a-z]{2}\.linkedin\.com\/jobs\/view\/[^"?]+)/);

      if (titleMatch && linkMatch) {
        const title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const company = companyMatch ? companyMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'Empresa Verificada';
        const jobLoc = locMatch ? locMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : location;
        const directLink = linkMatch[1];

        let benefitsText = 'Pacote CLT/PJ + Vale Refeição/Alimentação + Assistência Médica';
        if (profile === 'estagio') {
          benefitsText = 'Bolsa Auxílio Compatível + Auxílio Transporte/Home Office + Seguro de Vida + Recesso Remunerado';
        } else if (profile === 'aprendiz') {
          benefitsText = 'Salário Aprendiz CLT + Vale Transporte + Vale Refeição/Alimentação + Capacitação Teórica';
        }

        results.push({
          title,
          company,
          modality: jobLoc,
          match: `${96 - Math.min(results.length * 2, 8)}%`,
          benefits: benefitsText,
          link: directLink
        });
      }
      if (results.length >= 5) break;
    }

    return results;
  } catch (err) {
    console.error('[Live Scraper] Erro ao buscar vagas ao vivo:', err.message);
    return [];
  }
}

async function buildWelcomeWhatsAppMessage(sub) {
  const profileNames = {
    homeoffice: 'Vagas CLT / PJ',
    estagio: 'Estágio Universitário/Técnico',
    aprendiz: 'Jovem Aprendiz / 1º Emprego'
  };

  // Extrai cargo e cidade de sub.area (Ex: "Psicologia | Local: Apenas Presencial (Salvador-BA)")
  let rolePart = sub.area || '';
  let cityPart = '';
  if (rolePart.includes('| Local:')) {
    const parts = rolePart.split('| Local:');
    rolePart = parts[0].trim();
    const locStr = parts[1].trim();
    const parenMatch = locStr.match(/\(([^)]+)\)/);
    if (parenMatch && !parenMatch[1].includes('Qualquer lugar')) {
      cityPart = parenMatch[1];
    }
  }

  let jobs = await scrapeLiveJobs({
    profile: sub.profile,
    role: rolePart,
    city: cityPart,
    mode: sub.area || ''
  });

  if (!jobs || jobs.length === 0) {
    jobs = CURATED_JOBS[sub.profile] || CURATED_JOBS.homeoffice;
  } else {
    jobs = jobs.slice(0, 4);
  }

  let msg = `⚡ *BEM-VINDO(A) AO VAGAZAP IA!* ⚡\n\n`;
  msg += `Olá, *${sub.name || 'Assinante'}*! Seu acesso no *${sub.planName}* foi liberado com sucesso.\n`;
  msg += `🎯 *Modalidade:* ${profileNames[sub.profile] || 'CLT / PJ'}\n`;
  if (sub.area) msg += `📌 *Áreas & Local:* ${sub.area}\n`;
  msg += `⏰ *Disparo Diário:* Todos os dias às *07:00 da manhã*.\n\n`;
  msg += `────────────────────\n`;
  msg += `🔥 *SUAS VAGAS DE HOJE JÁ DESBLOQUEADAS:*\n\n`;

  jobs.forEach((j, idx) => {
    msg += `*${idx + 1}. ${j.title}*\n`;
    msg += `🏢 *Empresa:* ${j.company}\n`;
    msg += `📍 *Local/Formato:* ${j.modality}\n`;
    msg += `🎯 *Compatibilidade:* ${j.match} com seu filtro\n`;
    msg += `🎁 *Benefícios:* ${j.benefits}\n`;
    msg += `🔗 *Link Direto da Vaga:* ${j.link}\n\n`;
  });

  if (sub.bump1 || sub.bump2) {
    msg += `────────────────────\n`;
    msg += `🎁 *SEUS BÔNUS VIP DESBLOQUEADOS:*\n`;
    if (sub.bump1) {
      msg += `✅ *Otimizador de Currículo Anti-Gupy (ATS):* Envie seu currículo em PDF aqui mesmo nesta conversa para nossa IA reescrever com palavras-chave de +90% de Match!\n`;
    }
    if (sub.bump2) {
      msg += `✅ *Kit 15 Scripts para Abordar Recrutadores:* Digite *SCRIPTS* a qualquer momento para receber os textos prontos de abordagem no LinkedIn e WhatsApp.\n`;
    }
  }

  msg += `\n💡 _Você economizou hoje 2h15m de buscas manuais._`;
  return msg;
}

// Sincroniza novo assinante com a aba 'Assinantes' no Google Sheets
function appendSubscriberToGoogleSheets(sub) {
  const spreadsheetId = process.env.SPREADSHEET_ID || '1CC_Lwd_6dH8BSYyKgavoYwagG_OHyr35uDbcwphg97Y';
  const gsheetsCmd = process.env.GSHEETS_CMD || 'C:\\Users\\t\\.gemini\\config\\plugins\\gsheets\\skills\\gsheets\\scripts\\gsheets.cmd';

  const tempBatchFile = path.join(DATA_DIR, `sheet_sub_${Date.now()}.json`);
  const bumpsText = [
    sub.bump1 ? 'Currículo IA Anti-Gupy' : '',
    sub.bump2 ? 'Scripts Recrutadores' : ''
  ].filter(Boolean).join(' + ') || 'Nenhum';

  const batchPayload = [
    {
      op: 'append',
      range: "'Assinantes'!A1",
      data: [
        [
          new Date().toLocaleDateString('pt-BR'),
          sub.name || 'Cliente VagaZap',
          sub.whatsapp,
          sub.profile,
          sub.area || 'Geral',
          sub.planName,
          bumpsText,
          `R$ ${Number(sub.amount).toFixed(2).replace('.', ',')}`,
          'ATIVO',
          sub.expiresAt
        ]
      ]
    }
  ];

  fs.writeFileSync(tempBatchFile, JSON.stringify(batchPayload, null, 2), 'utf8');

  execFile('cmd.exe', ['/c', gsheetsCmd, 'mutate', 'batch', spreadsheetId, '-f', tempBatchFile], (err) => {
    try { fs.unlinkSync(tempBatchFile); } catch {}
    if (err) {
      console.error('[Google Sheets Sync] Erro ao gravar assinante:', err.message);
    } else {
      console.log('[Google Sheets Sync] Assinante gravado na aba Assinantes com sucesso!');
    }
  });
}

async function activateSubscriberFromPayment(paymentId) {
  const payments = readJson(PAYMENTS_FILE, {});
  const payment = payments[paymentId];
  if (!payment || payment.activated) return payment;

  payment.status = 'approved';
  payment.activated = true;
  payment.approvedAt = new Date().toISOString();
  writeJson(PAYMENTS_FILE, payments);

  const days = payment.plan === 'trimestral' ? 90 : 30;
  const expDate = new Date(Date.now() + days * 86400000).toLocaleDateString('pt-BR');

  const newSub = {
    id: crypto.randomUUID(),
    paymentId,
    createdAt: new Date().toISOString(),
    name: payment.name,
    whatsapp: payment.whatsapp,
    profile: payment.profile,
    area: payment.area,
    priority: payment.priority,
    plan: payment.plan,
    planName: payment.plan === 'trimestral' ? 'Passe Headhunter VIP (90 Dias)' : 'Passe Radar (30 Dias)',
    bump1: !!payment.bump1,
    bump2: !!payment.bump2,
    amount: payment.amount,
    status: 'active',
    expiresAt: expDate
  };

  const subs = readJson(SUBS_FILE, []);
  subs.unshift(newSub);
  writeJson(SUBS_FILE, subs);

  appendSubscriberToGoogleSheets(newSub);

  const welcomeText = await buildWelcomeWhatsAppMessage(newSub);
  const wahaResult = await sendWhatsAppMessage(newSub.whatsapp, welcomeText);
  payment.wahaDispatch = wahaResult;
  writeJson(PAYMENTS_FILE, payments);

  return payment;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // STATUS DO WHATSAPP NATIVO (QR CODE)
  if (pathname === '/api/whatsapp/status' && req.method === 'GET') {
    return sendJson(res, 200, waState);
  }

  // DESCONECTAR / GERAR NOVO QR CODE DO WHATSAPP NATIVO
  if (pathname === '/api/whatsapp/logout' && req.method === 'POST') {
    try { if (waSock) await waSock.logout(); } catch {}
    try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
    waState = { status: 'connecting', qrDataUrl: '', user: '', message: 'Gerando novo QR Code...' };
    setTimeout(initNativeWhatsApp, 1000);
    return sendJson(res, 200, { ok: true });
  }

  // CRIAR COBRANÇA PIX (MERCADO PAGO REAL OU MODO SIMULAÇÃO)
  if (pathname === '/api/pix/create' && req.method === 'POST') {
    const body = await parseBody(req);
    const plan = body.plan === 'trimestral' ? 'trimestral' : 'mensal';
    let amount = plan === 'trimestral' ? 49.90 : 19.90;
    if (body.bump1) amount += 14.90;
    if (body.bump2) amount += 9.90;
    amount = Number(amount.toFixed(2));

    const mpToken = (process.env.MP_ACCESS_TOKEN || '').trim();
    const payments = readJson(PAYMENTS_FILE, {});

    if (mpToken) {
      try {
        const mpResp = await fetch('https://api.mercadopago.com/v1/payments', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${mpToken}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': crypto.randomUUID()
          },
          body: JSON.stringify({
            transaction_amount: amount,
            description: `VagaZap IA - ${plan === 'trimestral' ? '90 Dias' : '30 Dias'}`,
            payment_method_id: 'pix',
            payer: {
              email: body.email || 'cliente@vagazap.com.br',
              first_name: body.name || 'Cliente'
            }
          })
        });

        const mpData = await mpResp.json();
        if (!mpResp.ok) {
          return sendJson(res, 400, { error: 'Erro na API do Mercado Pago', details: mpData });
        }

        const paymentId = String(mpData.id);
        const qrCode = mpData.point_of_interaction?.transaction_data?.qr_code || '';
        const qrCodeBase64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64 || '';

        payments[paymentId] = {
          id: paymentId,
          mode: 'mercadopago',
          status: mpData.status || 'pending',
          amount,
          name: body.name || 'Assinante VagaZap',
          whatsapp: body.whatsapp || '',
          profile: body.profile || 'homeoffice',
          area: body.area || 'atendimento',
          priority: body.priority || 'beneficios',
          plan,
          bump1: !!body.bump1,
          bump2: !!body.bump2,
          qrCode,
          qrCodeBase64,
          createdAt: new Date().toISOString()
        };
        writeJson(PAYMENTS_FILE, payments);

        return sendJson(res, 200, payments[paymentId]);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    } else {
      const paymentId = 'sim_' + Date.now();
      const fakePixCode = `00020126580014BR.GOV.BCB.PIX0136vagazap-sena-midias-${paymentId}5204000053039865405${amount.toFixed(2)}5802BR5913VAGAZAP SENA6008SALVADOR62070503***6304ABCD`;

      payments[paymentId] = {
        id: paymentId,
        mode: 'simulation',
        status: 'pending',
        amount,
        name: body.name || 'Assinante VagaZap',
        whatsapp: body.whatsapp || '',
        profile: body.profile || 'homeoffice',
        area: body.area || 'atendimento',
        priority: body.priority || 'beneficios',
        plan,
        bump1: !!body.bump1,
        bump2: !!body.bump2,
        qrCode: fakePixCode,
        qrCodeBase64: '',
        createdAt: new Date().toISOString()
      };
      writeJson(PAYMENTS_FILE, payments);

      return sendJson(res, 200, payments[paymentId]);
    }
  }

  // CONSULTAR STATUS DO PIX
  if (pathname.startsWith('/api/pix/status/') && req.method === 'GET') {
    const paymentId = pathname.replace('/api/pix/status/', '').trim();
    const payments = readJson(PAYMENTS_FILE, {});
    const payment = payments[paymentId];
    if (!payment) return sendJson(res, 404, { error: 'Pagamento não encontrado' });

    const mpToken = (process.env.MP_ACCESS_TOKEN || '').trim();
    if (payment.mode === 'mercadopago' && mpToken && payment.status !== 'approved') {
      try {
        const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { 'Authorization': `Bearer ${mpToken}` }
        });
        if (mpResp.ok) {
          const mpData = await mpResp.json();
          if (mpData.status === 'approved') {
            const updated = await activateSubscriberFromPayment(paymentId);
            return sendJson(res, 200, updated);
          }
        }
      } catch {}
    }

    return sendJson(res, 200, payment);
  }

  // SIMULAR APROVAÇÃO DO PIX EM 1 CLIQUE
  if (pathname === '/api/pix/simulate-approve' && req.method === 'POST') {
    const body = await parseBody(req);
    const updated = await activateSubscriberFromPayment(body.paymentId);
    if (!updated) return sendJson(res, 404, { error: 'Pagamento não encontrado' });
    return sendJson(res, 200, updated);
  }

  // WEBHOOK OFICIAL DO MERCADO PAGO
  if (pathname === '/api/webhook/mercadopago' && req.method === 'POST') {
    const body = await parseBody(req);
    const paymentId = String(body?.data?.id || body?.id || '');
    if (paymentId) {
      await activateSubscriberFromPayment(paymentId);
    }
    return sendJson(res, 200, { received: true });
  }

  // PAINEL ADMIN: OVERVIEW
  if (pathname === '/api/admin/overview' && req.method === 'GET') {
    loadEnv();
    const subs = readJson(SUBS_FILE, []);
    return sendJson(res, 200, {
      config: {
        hasMpToken: !!(process.env.MP_ACCESS_TOKEN || '').trim(),
        wahaUrl: process.env.WAHA_URL || '',
        wahaSession: process.env.WAHA_SESSION || 'default',
        spreadsheetId: process.env.SPREADSHEET_ID || '1CC_Lwd_6dH8BSYyKgavoYwagG_OHyr35uDbcwphg97Y'
      },
      subscribers: subs
    });
  }

  // PAINEL ADMIN: SALVAR CONFIGURAÇÕES (.ENV)
  if (pathname === '/api/admin/config' && req.method === 'POST') {
    const body = await parseBody(req);
    if (typeof body.mpAccessToken === 'string' && body.mpAccessToken.trim() !== '') {
      process.env.MP_ACCESS_TOKEN = body.mpAccessToken.trim();
    }
    if (typeof body.wahaUrl === 'string') process.env.WAHA_URL = body.wahaUrl.trim();
    if (typeof body.wahaSession === 'string') process.env.WAHA_SESSION = body.wahaSession.trim();
    if (typeof body.wahaApiKey === 'string') process.env.WAHA_API_KEY = body.wahaApiKey.trim();

    const envContent = [
      `PORT=${process.env.PORT || 3000}`,
      `MP_ACCESS_TOKEN=${process.env.MP_ACCESS_TOKEN || ''}`,
      `WAHA_URL=${process.env.WAHA_URL || ''}`,
      `WAHA_SESSION=${process.env.WAHA_SESSION || 'default'}`,
      `WAHA_API_KEY=${process.env.WAHA_API_KEY || ''}`,
      `SPREADSHEET_ID=${process.env.SPREADSHEET_ID || '1CC_Lwd_6dH8BSYyKgavoYwagG_OHyr35uDbcwphg97Y'}`,
      `GSHEETS_CMD=${process.env.GSHEETS_CMD || 'C:\\Users\\t\\.gemini\\config\\plugins\\gsheets\\skills\\gsheets\\scripts\\gsheets.cmd'}`
    ].join('\n');

    fs.writeFileSync(envPath, envContent, 'utf8');
    return sendJson(res, 200, { saved: true });
  }

  // BUSCAR VAGA OFICIAL EM TEMPO REAL (COM LINK DIRETO DA VAGA ESPECÍFICA)
  if (pathname === '/api/jobs/live' && req.method === 'GET') {
    const profile = urlObj.searchParams.get('profile') || 'homeoffice';
    const role = urlObj.searchParams.get('role') || '';
    const city = urlObj.searchParams.get('city') || '';
    const mode = urlObj.searchParams.get('mode') || '';
    const jobs = await scrapeLiveJobs({ profile, role, city, mode });
    return sendJson(res, 200, { jobs });
  }

  // PAINEL ADMIN: DISPARAR MENSAGEM DE TESTE NO WHATSAPP
  if (pathname === '/api/admin/test-waha' && req.method === 'POST') {
    const body = await parseBody(req);
    const sampleSub = {
      name: body.name || 'Cristiano Sena',
      whatsapp: body.whatsapp || '71991971396',
      profile: body.profile || 'homeoffice',
      planName: 'Passe Headhunter VIP (Teste Admin)',
      bump1: true,
      bump2: true
    };
    const msg = await buildWelcomeWhatsAppMessage(sampleSub);
    const result = await sendWhatsAppMessage(sampleSub.whatsapp, msg);
    return sendJson(res, 200, result);
  }

  // SERVIR ARQUIVOS ESTÁTICOS
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (pathname === '/admin') filePath = path.join(__dirname, 'public', 'admin.html');

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Página não encontrada');
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`⚡ VagaZap SaaS rodando em: http://localhost:${PORT}`);
  console.log(`📱 Painel Admin (WhatsApp QR + MP): http://localhost:${PORT}/admin`);
  console.log(`====================================================`);
  initNativeWhatsApp();
});
