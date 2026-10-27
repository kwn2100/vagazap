const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Proteção global para o servidor nunca cair por oscilação de rede no socket do WhatsApp
process.on('uncaughtException', (err) => {
  console.error('[Proteção Anti-Queda] Exceção capturada:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Proteção Anti-Queda] Rejeição capturada:', reason?.message || reason);
});

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

const DEFAULT_SUBS = [
  {
    id: '88918f6e-9fc9-4b7d-8545-ce393223b847',
    paymentId: 'trial_1793031584578',
    createdAt: '2026-10-26T16:19:44.578Z',
    name: 'Maria Rafaela',
    whatsapp: '71988382214',
    profile: 'homeoffice',
    area: '[💼 CLT/PJ + 🎓 Estágio + 🚀 Jovem Aprendiz] Atendimento & Chat, Comercial & SDR, Administrativo & Finanças, Saúde, Psicologia & Educação, Marketing & Criativo | Local: (100% Home Office)',
    plan: 'trial_3d',
    planName: 'Teste Grátis (3 Dias)',
    bump1: true,
    bump2: true,
    amount: 0,
    status: 'active',
    expiresAt: '29/10/2026',
    sentJobLinks: []
  }
];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUBS_FILE)) fs.writeFileSync(SUBS_FILE, JSON.stringify(DEFAULT_SUBS, null, 2));
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

    // ========================================================================
    // RESPOSTA AUTOMÁTICA NO WHATSAPP (CURRÍCULO, SCRIPTS, PIX, SUPORTE, PARAR)
    // ========================================================================
    waSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (!m.message || m.key.fromMe) continue;
          const senderJid = m.key.remoteJid || '';
          if (senderJid.endsWith('@g.us') || senderJid === 'status@broadcast') continue;

          const textMsg = (
            m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            m.message.imageMessage?.caption ||
            ''
          ).trim();

          const docMsg =
            m.message.documentMessage ||
            m.message.documentWithCaptionMessage?.message?.documentMessage ||
            null;

          // Procura assinante pelo número para personalizar com a área dele
          const senderDigits = senderJid.replace(/\D/g, '').slice(-8);
          const subs = readJson(SUBS_FILE, []);
          const foundSub = subs.find(s => String(s.whatsapp || '').replace(/\D/g, '').endsWith(senderDigits));
          const userArea = foundSub?.area ? foundSub.area.split('|')[0].trim() : 'sua área de atuação';
          const userName = foundSub?.name || 'Candidato(a)';

          const upper = textMsg.toUpperCase();

          // 1. Se a pessoa digitou CANCELAR, PARAR ou SAIR (Bloqueio Imediato):
          if (upper === 'CANCELAR' || upper === 'PARAR' || upper === 'SAIR') {
            if (foundSub) {
              foundSub.status = 'canceled';
              writeJson(SUBS_FILE, subs);
            }
            await waSock.sendMessage(senderJid, {
              text: `✅ *Envios cancelados com sucesso.*\nVocê não receberá novos disparos automáticos do VagaZap IA.\n\nCaso queira reativar seus alertas no futuro, basta nos chamar por aqui!`
            });
            continue;
          }

          // 2. Se a pessoa pediu EXCLUIR DADOS (Direito LGPD):
          if (upper === 'EXCLUIR DADOS' || upper === 'EXCLUIR') {
            const filtered = subs.filter(s => !String(s.whatsapp || '').replace(/\D/g, '').endsWith(senderDigits));
            writeJson(SUBS_FILE, filtered);
            await waSock.sendMessage(senderJid, {
              text: `🔒 *Seus dados foram excluídos da nossa base conforme a LGPD.*\nVocê não receberá mais nenhuma mensagem.`
            });
            continue;
          }

          // 3. Se a pessoa pediu PIX, ASSINAR ou RENOVAR (Fluxo de Cobrança R$ 19/mês):
          if (upper === 'PIX' || upper === 'ASSINAR' || upper === 'RENOVAR') {
            const pixMsg = await buildTrialEndPixMessage(foundSub || { name: userName, whatsapp: senderDigits });
            await waSock.sendMessage(senderJid, { text: pixMsg });
            continue;
          }

          // 4. Se a pessoa pediu SUPORTE ou AJUDA:
          if (upper === 'SUPORTE' || upper === 'AJUDA') {
            await waSock.sendMessage(senderJid, {
              text:
                `💬 *SUPORTE VAGAZAP IA*\n\n` +
                `Olá, *${userName}*! Como podemos ajudar?\n` +
                `• Para alterar sua cidade ou área de filtro, escreva aqui qual cargo e cidade deseja.\n` +
                `• Para assinar ou renovar o plano mensal (R$ 19,00/mês via Pix), digite *PIX*.\n` +
                `• Para parar de receber mensagens a qualquer momento, digite *PARAR*.\n\n` +
                `_Nosso atendimento humano já foi notificado e responderá em instantes se precisar de ajuda adicional!_`
            });
            continue;
          }

          // 5. Se a pessoa enviou um currículo em PDF / Word no WhatsApp:
          if (docMsg) {
            const fileName = docMsg.fileName || 'Currículo.pdf';
            const replyResume =
              `🤖 *SUGESTÕES DE MELHORIA PARA SEU CURRÍCULO* 📄\n\n` +
              `Olá, *${userName}*! Recebi o seu arquivo *${fileName}* com foco em *${userArea}*.\n\n` +
              `✅ *PASSO 1: Sugestão de Resumo Profissional para colocar no topo do currículo:*\n` +
              `_"Profissional com foco em ${userArea}, facilidade de aprendizado, comunicação clara, organização de rotinas, atendimento e domínio de ferramentas digitais. Disponibilidade para início e foco em resultados."_\n\n` +
              `🔑 *PASSO 2: Palavras-Chave Recomendadas para a seção de Habilidades:*\n` +
              `• ${userArea} • Comunicação • Pacote Office / Ferramentas Digitais • Gestão do Tempo • Resolução de Problemas • Atendimento • Organização de Processos • Trabalho em Equipe.\n\n` +
              `⚠️ *PASSO 3: Dica de Formatação:*\n` +
              `Prefira currículos em 1 coluna simples (Word ou Google Docs exportado em PDF), pois leitores automáticos de portais leem melhor textos lineares.\n\n` +
              `💡 _Digite *SCRIPTS* se quiser modelos de mensagens para enviar a recrutadores, ou *PARAR* a qualquer momento para cancelar os alertas._`;

            await waSock.sendMessage(senderJid, { text: replyResume });
            continue;
          }

          // 6. Se a pessoa digitou SCRIPTS:
          if (upper === 'SCRIPTS' || upper === 'SCRIPT') {
            const replyScripts =
              `🎯 *MODELOS DE MENSAGEM PARA CANDIDATURA (VAGAZAP IA)* 🎯\n\n` +
              `Use estes modelos ao se candidatar nas vagas enviadas às 07h00:\n\n` +
              `1️⃣ *Mensagem para abordar Recrutador no LinkedIn após se inscrever:*\n` +
              `_"Olá [Nome], tudo bem? Acabei de realizar minha inscrição na vaga de *${userArea}* pela plataforma oficial e gostaria de me colocar à disposição por aqui também. Meu currículo está atualizado no perfil. Muito obrigado(a)!"_\n\n` +
              `2️⃣ *Mensagem para enviar Currículo por E-mail ou WhatsApp:*\n` +
              `_"Bom dia! Vi a oportunidade aberta para *${userArea}* e encaminho meu currículo em anexo para avaliação. Tenho disponibilidade e facilidade com rotinas da área. Fico à disposição!"_\n\n` +
              `3️⃣ *Mensagem para Estágio / 1º Emprego:*\n` +
              `_"Olá! Estou me candidatando à oportunidade de *${userArea}*. Tenho muita dedicação aos estudos na área, facilidade com tecnologia e vontade de aprender junto à equipe. Agradeço a atenção!"_`;

            await waSock.sendMessage(senderJid, { text: replyScripts });
            continue;
          }
        } catch (err) {
          console.error('[WhatsApp AutoReply] Erro:', err.message);
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
// BUSCA DE VAGAS ABERTAS NO DIA E PREVENÇÃO DE REPETIÇÃO ENTRE DIAS
// ============================================================================
const FALLBACK_ACTIVE_SEARCHES = {
  homeoffice: [
    {
      title: 'Atendimento ao Cliente & Suporte Digital (Remoto)',
      company: 'Vagas Abertas • Filtro Recente',
      modality: 'Home Office / Remoto',
      benefits: 'CLT/PJ • Confira os requisitos e benefícios na página oficial da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Atendimento%20Remoto&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Assistente Administrativo & Operações (Remoto)',
      company: 'Vagas Abertas • Filtro Recente',
      modality: 'Home Office / Remoto',
      benefits: 'CLT/PJ • Confira os requisitos e benefícios na página oficial da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Assistente%20Administrativo%20Remoto&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Analista de Relacionamento & Customer Success',
      company: 'Vagas Abertas • Filtro Recente',
      modality: 'Home Office / Remoto',
      benefits: 'CLT/PJ • Confira os requisitos e benefícios na página oficial da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Customer%20Success%20Remoto&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Representante Comercial / SDR (Inside Sales)',
      company: 'Vagas Abertas • Filtro Recente',
      modality: 'Home Office / Remoto',
      benefits: 'CLT/PJ • Confira os requisitos e benefícios na página oficial da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=SDR%20Remoto&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Auxiliar de Backoffice & Suporte Operacional',
      company: 'Vagas Abertas • Filtro Recente',
      modality: 'Home Office / Remoto',
      benefits: 'CLT/PJ • Confira os requisitos e benefícios na página oficial da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Backoffice%20Remoto&location=Brasil&f_TPR=r604800'
    }
  ],
  estagio: [
    {
      title: 'Estágio em Administração & Processos',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '6h/dia • Estágio',
      benefits: 'Bolsa Auxílio + Auxílio Transporte • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Est%C3%A1gio%20Administra%C3%A7%C3%A3o&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Estágio em Atendimento & Suporte ao Cliente',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '6h/dia • Estágio',
      benefits: 'Bolsa Auxílio + Auxílio Transporte • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Est%C3%A1gio%20Atendimento&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Estágio em Comercial, Marketing & Negócios',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '6h/dia • Estágio',
      benefits: 'Bolsa Auxílio + Auxílio Transporte • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Est%C3%A1gio%20Comercial&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Estágio em Tecnologia & Suporte de TI',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '6h/dia • Estágio',
      benefits: 'Bolsa Auxílio + Auxílio Transporte • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Est%C3%A1gio%20TI&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Estágio em Recursos Humanos & Psicologia',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '6h/dia • Estágio',
      benefits: 'Bolsa Auxílio + Auxílio Transporte • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Est%C3%A1gio%20Psicologia%20RH&location=Brasil&f_TPR=r604800'
    }
  ],
  aprendiz: [
    {
      title: 'Jovem Aprendiz Administrativo',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '4h a 6h/dia • Primeiro Emprego',
      benefits: 'Salário Aprendiz CLT + VT + VR/VA • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Jovem%20Aprendiz%20Administrativo&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Jovem Aprendiz Atendimento & Recepção',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '4h a 6h/dia • Primeiro Emprego',
      benefits: 'Salário Aprendiz CLT + VT + VR/VA • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Jovem%20Aprendiz%20Atendimento&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Jovem Aprendiz Operações & Logística',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '4h a 6h/dia • Primeiro Emprego',
      benefits: 'Salário Aprendiz CLT + VT + VR/VA • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Jovem%20Aprendiz&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Jovem Aprendiz Auxiliar de Escritório',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '4h a 6h/dia • Primeiro Emprego',
      benefits: 'Salário Aprendiz CLT + VT + VR/VA • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Aprendiz%20Auxiliar&location=Brasil&f_TPR=r604800'
    },
    {
      title: 'Jovem Aprendiz Suporte Comercial',
      company: 'Vagas Abertas • Filtro Recente',
      modality: '4h a 6h/dia • Primeiro Emprego',
      benefits: 'Salário Aprendiz CLT + VT + VR/VA • Confira na página da vaga',
      link: 'https://www.linkedin.com/jobs/search?keywords=Jovem%20Aprendiz%20Comercial&location=Brasil&f_TPR=r604800'
    }
  ]
};

// Trava Obrigatória: Garante que 100% das vagas sejam do BRASIL e em Português (Bloqueia EUA / Exterior)
function isStrictBrazilJob(jobLoc, title) {
  const loc = String(jobLoc || '').trim();
  const t = String(title || '').trim();

  // 1. Bloqueio imediato de EUA e outros países na localização ou título
  const foreignRegex = /\b(United States|Estados Unidos|USA|U\.S\.|UK|United Kingdom|Canada|Canadá|India|Índia|Mexico|México|Colombia|Colômbia|Argentina|Chile|Peru|Portugal|Spain|Espanha|Germany|Alemanha|France|França|Italy|Itália|Poland|Philippines|Pakistan|Nigeria|Australia|New York|San Francisco|California|Texas|Florida|Illinois|Washington|Massachusetts|Georgia|North Carolina|Ohio|Pennsylvania|Virginia|Colorado|Arizona|Atlanta|Chicago|Austin|Boston|Seattle|Los Angeles|Miami|Dallas|Denver|London|Toronto|Madrid|Lisbon|Lisboa|LATAM|Latin America)\b/i;
  if (foreignRegex.test(loc) || foreignRegex.test(t)) return false;

  // 2. Bloqueia siglas de estados americanos no formato ", CA", ", NY", ", TX", ", US"
  if (/,\s*(US|CA|NY|TX|FL|IL|WA|MA|GA|NC|OH|PA|VA|CO|AZ|NJ|MI|TN|IN|MO|MD|WI|MN|OR|SC|AL|LA|KY|UT|IA|NV|AR|MS|KS|NM|NE|WV|ID|HI|NH|ME|RI|MT|DE|SD|ND|AK|VT|WY)\b/.test(loc)) {
    return false;
  }

  // 3. Bloqueia títulos de vagas internacionais em inglês ou espanhol
  if (/\b(English Required|Fluent English|Bilingual|Remote US|US Remote|Work from Home - US|Customer Service Representative|Sales Representative|Account Executive|Virtual Assistant|Software Engineer|atenci[oó]n al cliente|espa[ñn]ol|spanish|gallego|biling[üu]e|habla hispana)\b/i.test(t)) {
    return false;
  }

  // 4. Exige confirmação positiva de localização no Brasil (Estados brasileiros, capitais ou "Brasil"/"Brazil")
  const brazilRegex = /\b(Brasil|Brazil|São Paulo|Rio de Janeiro|Minas Gerais|Bahia|Paraná|Rio Grande do Sul|Pernambuco|Ceará|Santa Catarina|Goiás|Distrito Federal|Espírito Santo|Pará|Amazonas|Mato Grosso|Maranhão|Paraíba|Rio Grande do Norte|Alagoas|Piauí|Sergipe|Rondônia|Tocantins|Acre|Amapá|Roraima|Salvador|Curitiba|Belo Horizonte|Recife|Porto Alegre|Fortaleza|Brasília|Campinas|Goiânia|Manaus|Belém|Florianópolis|Vitória|Natal|João Pessoa|Maceió|Teresina|Aracaju|Sorocaba|Uberlândia|Ribeirão Preto|Joinville|Londrina|Niterói|Barueri|Osasco|Santo André|São Bernardo|Guarulhos)\b|(-\s*(SP|RJ|MG|BA|PR|RS|PE|CE|SC|DF|GO|ES|PA|AM|MT|MS|MA|PB|RN|AL|PI|SE|RO|TO|AC|AP|RR)\b)|(,\s*(SP|RJ|MG|BA|PR|RS|PE|CE|SC|DF|GO|ES)\b)/i;

  return brazilRegex.test(loc);
}

// Converte o nome da categoria do Quiz em termos de busca brasileiros certeiros
function buildBrazilianSearchTerms(rawRoleStr, profile) {
  const withoutBrackets = String(rawRoleStr || 'Administrativo').replace(/\[[^\]]*\]/g, '').trim();
  const parts = withoutBrackets.split(',').map(s => s.trim()).filter(Boolean);
  const terms = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower.includes('atendimento') || lower.includes('chat')) {
      terms.push('Atendimento ao Cliente');
    } else if (lower.includes('comercial') || lower.includes('sdr') || lower.includes('vendas')) {
      terms.push('Comercial Pré-Vendas SDR');
    } else if (lower.includes('administrativo') || lower.includes('finanças')) {
      terms.push('Assistente Administrativo');
    } else if (lower.includes('saúde') || lower.includes('psicologia') || lower.includes('educação')) {
      terms.push('Psicologia Recursos Humanos');
    } else if (lower.includes('marketing') || lower.includes('criativo')) {
      terms.push('Marketing Digital Social Media');
    } else if (lower.includes('tecnologia') || lower.includes('ti')) {
      terms.push('Suporte Técnico TI');
    } else {
      const cleaned = part.split('/')[0].replace(/&/g, '').replace(/\s+/g, ' ').trim();
      if (cleaned.length >= 3) terms.push(cleaned);
    }
  }

  const unique = [...new Set(terms)];
  if (unique.length === 0) unique.push('Assistente Administrativo');

  let prefix = '';
  if (profile === 'estagio') prefix = 'Estágio ';
  else if (profile === 'aprendiz') prefix = 'Jovem Aprendiz ';

  return unique.map(t => `${prefix}${t}`.trim());
}

// Varredura em Tempo Real de Vagas Abertas (100% Travada no Brasil com geoId=106057199)
async function scrapeLiveJobs({ profile = 'homeoffice', role = '', city = '', mode = '', excludeLinks = [] }) {
  try {
    const isHome = !city || city === 'Remoto Nacional' || city.includes('Home Office') || mode.includes('Home Office');
    const searchTerms = buildBrazilianSearchTerms(role, profile);
    const maxPerTerm = searchTerms.length >= 3 ? 1 : (searchTerms.length === 2 ? 3 : 5);

    const results = [];
    const seenLinks = new Set(excludeLinks || []);

    // Passada 1: Pega vagas distribuídas entre todas as áreas que a pessoa escolheu
    // Passada 2 (se faltar para completar 5): Pega vagas adicionais da 1ª área
    const passes = [maxPerTerm, 5];

    for (const limitPerQuery of passes) {
      if (results.length >= 5) break;

      for (const keywords of searchTerms) {
        if (results.length >= 5) break;

        // Trava oficial do LinkedIn no Brasil (mesmo rodando em servidor nos EUA como o Render): location=Brazil & geoId=106057199
        const locationParam = isHome ? 'Brazil' : `${city}, Brazil`;
        const geoParam = isHome ? '&geoId=106057199' : '';
        const wtParam = isHome ? '&f_WT=2' : '';

        const searchUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(locationParam)}${geoParam}${wtParam}&f_TPR=r604800&start=0`;

        const resp = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'pt-BR,pt;q=0.9'
          }
        });
        if (!resp.ok) continue;

        const html = await resp.text();
        const blocks = html.split('<li');
        let addedForThisQuery = 0;

        for (const block of blocks) {
          const linkMatch = block.match(/href="(https:\/\/[^"?]*linkedin\.com\/jobs\/view\/[^"?]+)/);
          const titleMatch = block.match(/<span class="sr-only">\s*([\s\S]*?)\s*<\/span>/) || block.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
          const companyMatch = block.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/);
          const locMatch = block.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/);

          if (titleMatch && linkMatch) {
            const title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            const company = companyMatch ? companyMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'Empresa Verificada';
            const jobLoc = locMatch ? locMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'Brasil';
            // Normaliza sempre para o domínio brasileiro br.linkedin.com
            const directLink = linkMatch[1].replace(/^https:\/\/[a-z]+\.linkedin\.com/, 'https://br.linkedin.com');

            // TRAVA OBRIGATÓRIA: Só passa se for comprovadamente vaga no Brasil!
            if (!isStrictBrazilJob(jobLoc, title)) continue;
            if (seenLinks.has(directLink)) continue;
            seenLinks.add(directLink);

            let benefitsText = 'Vaga no Brasil verificada hoje • Candidatura direta no link oficial';
            if (profile === 'estagio') {
              benefitsText = 'Modalidade Estágio no Brasil • Bolsa Auxílio e requisitos na página oficial';
            } else if (profile === 'aprendiz') {
              benefitsText = 'Modalidade Jovem Aprendiz no Brasil • Requisitos e benefícios na página oficial';
            }

            results.push({
              title,
              company,
              modality: isHome ? `${jobLoc} (100% Home Office - Brasil)` : `${jobLoc} (Brasil)`,
              benefits: benefitsText,
              link: directLink
            });

            addedForThisQuery++;
            if (addedForThisQuery >= limitPerQuery || results.length >= 5) break;
          }
        }
      }
    }

    return results;
  } catch (err) {
    console.error('[Live Scraper] Erro ao buscar vagas ao vivo:', err.message);
    return [];
  }
}

// Monta a mensagem com 5 vagas abertas e atualiza o histórico do assinante para não repetir vagas amanhã
async function buildWelcomeWhatsAppMessage(sub) {
  const profileNames = {
    homeoffice: 'Vagas CLT / PJ',
    estagio: 'Estágio Universitário/Técnico',
    aprendiz: 'Jovem Aprendiz / 1º Emprego'
  };

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

  const previousLinks = Array.isArray(sub.sentJobLinks) ? sub.sentJobLinks : [];

  let jobs = await scrapeLiveJobs({
    profile: sub.profile,
    role: rolePart,
    city: cityPart,
    mode: sub.area || '',
    excludeLinks: previousLinks
  });

  if (!jobs || jobs.length === 0) {
    jobs = (FALLBACK_ACTIVE_SEARCHES[sub.profile] || FALLBACK_ACTIVE_SEARCHES.homeoffice).slice(0, 5);
  } else {
    jobs = jobs.slice(0, 5);
  }

  // Salva os links enviados hoje no registro do assinante para não repetir amanhã
  if (sub.id) {
    const subs = readJson(SUBS_FILE, []);
    const idx = subs.findIndex(s => s.id === sub.id);
    if (idx !== -1) {
      const updatedHistory = [...previousLinks, ...jobs.map(j => j.link)].slice(-50);
      subs[idx].sentJobLinks = updatedHistory;
      writeJson(SUBS_FILE, subs);
    }
  }

  let msg = `⚡ *BEM-VINDO(A) AO VAGAZAP IA!* ⚡\n\n`;
  msg += `Olá, *${sub.name || 'Assinante'}*! Seu *${sub.planName || 'Teste Grátis de 3 Dias'}* está ativo.\n`;
  msg += `🎯 *Modalidade:* ${profileNames[sub.profile] || 'CLT / PJ'}\n`;
  if (sub.area) msg += `📌 *Filtro configurado:* ${sub.area}\n`;
  msg += `⏰ *Entrega diária:* 5 vagas por dia às *07:00 da manhã*.\n`;
  if (sub.expiresAt) msg += `📅 *Válido até:* ${sub.expiresAt}\n\n`;
  msg += `────────────────────\n`;
  msg += `🔥 *SUAS 5 VAGAS ABERTAS DE HOJE:*\n\n`;

  jobs.forEach((j, idx) => {
    msg += `*${idx + 1}. ${j.title}*\n`;
    msg += `🏢 *Empresa:* ${j.company}\n`;
    msg += `📍 *Local/Formato:* ${j.modality}\n`;
    msg += `📋 *Detalhes:* ${j.benefits}\n`;
    msg += `🔗 *Link da Vaga:* ${j.link}\n\n`;
  });

  msg += `────────────────────\n`;
  msg += `💡 *Comandos úteis aqui no WhatsApp:*\n`;
  msg += `• Envie seu *Currículo em PDF* aqui na conversa para receber sugestões de melhoria.\n`;
  msg += `• Digite *SCRIPTS* para receber modelos de mensagem para recrutadores.\n`;
  msg += `• Digite *SUPORTE* se precisar ajustar seu filtro ou tirar dúvidas.\n`;
  msg += `• Digite *PARAR* a qualquer momento se quiser cancelar o recebimento.`;

  return msg;
}

// ============================================================================
// FLUXO FECHADO DE COBRANÇA PIX (R$ 19,00/MÊS) NO WHATSAPP (PÁGINA 3 AUDITORIA)
// ============================================================================
async function buildTrialEndPixMessage(sub) {
  const amount = 19.00;
  const pixKeyFallback = process.env.PIX_KEY || 'vagazap@senamidias.com.br';
  let pixCode = '';

  const mpToken = (process.env.MP_ACCESS_TOKEN || '').trim();
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
          description: `VagaZap IA - Assinatura Mensal (30 Dias)`,
          payment_method_id: 'pix',
          payer: {
            email: 'assinante@vagazap.com.br',
            first_name: sub?.name || 'Assinante'
          }
        })
      });
      if (mpResp.ok) {
        const mpData = await mpResp.json();
        pixCode = mpData.point_of_interaction?.transaction_data?.qr_code || '';
        const payments = readJson(PAYMENTS_FILE, {});
        payments[String(mpData.id)] = {
          id: String(mpData.id),
          mode: 'mercadopago',
          status: 'pending',
          amount,
          name: sub?.name || 'Assinante VagaZap',
          whatsapp: sub?.whatsapp || '',
          profile: sub?.profile || 'homeoffice',
          area: sub?.area || 'Geral',
          plan: 'mensal',
          createdAt: new Date().toISOString()
        };
        writeJson(PAYMENTS_FILE, payments);
      }
    } catch {}
  }

  let msg = `⏰ *SEU TESTE GRÁTIS DE 3 DIAS ENCERRA HOJE* ⚡\n\n`;
  msg += `Olá, *${sub?.name || 'Candidato(a)'}*! Esperamos que você tenha gostado de receber as vagas filtradas às 07h00 no seu WhatsApp.\n\n`;
  msg += `Para continuar recebendo *5 vagas abertas todos os dias às 07h00* pelos próximos 30 dias:\n`;
  msg += `• *Valor:* R$ 19,00 por mês via Pix (sem fidelidade)\n`;
  msg += `• *O que está incluído:* 5 vagas diárias no seu filtro + análise de currículo PDF + suporte no WhatsApp.\n\n`;

  if (pixCode) {
    msg += `💠 *PIX COPIA E COLA (R$ 19,00):*\n`;
    msg += `${pixCode}\n\n`;
  } else {
    msg += `💠 *CHAVE PIX OFICIAL (R$ 19,00):*\n`;
    msg += `👉 *${pixKeyFallback}*\n`;
    msg += `_(Favorecido: Sena Mídias / Cristiano Sena da Costa)_\n\n`;
  }

  msg += `✅ *Como ativar sua assinatura:*\n`;
  msg += `Após realizar o Pix de R$ 19,00, envie o *comprovante* aqui mesmo nesta conversa. Confirmamos e liberamos seus 30 dias em até 15 minutos!\n\n`;
  msg += `_Se não quiser continuar, não precisa fazer nada: o envio será encerrado sem nenhum custo. Para sair agora, digite PARAR._`;

  return msg;
}

// Sincroniza novo assinante com a aba 'Assinantes' no Google Sheets (Incluindo UTMs da campanha)
function appendSubscriberToGoogleSheets(sub) {
  const spreadsheetId = process.env.SPREADSHEET_ID || '1CC_Lwd_6dH8BSYyKgavoYwagG_OHyr35uDbcwphg97Y';
  const gsheetsCmd = process.env.GSHEETS_CMD || 'C:\\Users\\t\\.gemini\\config\\plugins\\gsheets\\skills\\gsheets\\scripts\\gsheets.cmd';

  const tempBatchFile = path.join(DATA_DIR, `sheet_sub_${Date.now()}.json`);
  const utmSummary = sub.utms
    ? `${sub.utms.utm_source || 'direto'}${sub.utms.utm_campaign ? ' / ' + sub.utms.utm_campaign : ''}${sub.utms.utm_content ? ' / ' + sub.utms.utm_content : ''}`
    : 'direto';

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
          utmSummary,
          `R$ ${Number(sub.amount).toFixed(2).replace('.', ',')}`,
          sub.status === 'active' ? 'ATIVO' : sub.status,
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

async function activateSubscriberFromPayment(paymentId, customDays = null) {
  const payments = readJson(PAYMENTS_FILE, {});
  const payment = payments[paymentId];
  if (!payment || payment.activated) return payment;

  payment.status = 'approved';
  payment.activated = true;
  payment.approvedAt = new Date().toISOString();
  writeJson(PAYMENTS_FILE, payments);

  const isTrial = Number(customDays) > 0;
  const days = isTrial ? Number(customDays) : (payment.plan === 'trimestral' ? 90 : 30);
  const startDateStr = new Date().toLocaleDateString('pt-BR');
  const expDate = new Date(Date.now() + days * 86400000).toLocaleDateString('pt-BR');

  const newSub = {
    id: crypto.randomUUID(),
    paymentId,
    createdAt: new Date().toISOString(),
    paidAt: isTrial ? null : startDateStr,
    name: payment.name,
    whatsapp: payment.whatsapp,
    profile: payment.profile,
    area: payment.area,
    priority: payment.priority,
    plan: isTrial ? 'trial_3d' : payment.plan,
    planName: isTrial
      ? `Teste Grátis (${days} Dias)`
      : (payment.plan === 'trimestral' ? 'Plano Trimestral (90 Dias)' : 'Plano Mensal Pix (30 Dias)'),
    bump1: true,
    bump2: true,
    amount: isTrial ? 0 : (payment.amount || 19.00),
    status: 'active',
    expiresAt: expDate,
    sentJobLinks: []
  };

  const subs = readJson(SUBS_FILE, []);
  subs.unshift(newSub);
  writeJson(SUBS_FILE, subs);

  appendSubscriberToGoogleSheets(newSub);

  const welcomeText = await buildWelcomeWhatsAppMessage(newSub);
  const confirmHeader = !isTrial
    ? `✅ *PAGAMENTO CONFIRMADO — ASSINATURA ATIVA!* ✅\n` +
      `• *Início:* ${startDateStr}\n` +
      `• *Próximo vencimento:* ${expDate} (Avisaremos 2 dias antes. Tolerância de 2 dias após o vencimento).\n` +
      `• *Cancelamento:* Sem fidelidade (digite PARAR quando quiser).\n\n`
    : '';

  const wahaResult = await sendWhatsAppMessage(newSub.whatsapp, confirmHeader + welcomeText);
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

  // CRIAR COBRANÇA PIX (R$ 19,00/MÊS)
  if (pathname === '/api/pix/create' && req.method === 'POST') {
    const body = await parseBody(req);
    const plan = body.plan === 'trimestral' ? 'trimestral' : 'mensal';
    let amount = plan === 'trimestral' ? 49.00 : 19.00;
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
            description: `VagaZap IA - ${plan === 'trimestral' ? '90 Dias' : '30 Dias (R$ 19/mês)'}`,
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

  // SIMULAR APROVAÇÃO DO PIX OU LIBERAR TESTE DE 3 DIAS EM 1 CLIQUE
  if (pathname === '/api/pix/simulate-approve' && req.method === 'POST') {
    const body = await parseBody(req);
    const updated = await activateSubscriberFromPayment(body.paymentId, body.trialDays || null);
    if (!updated) return sendJson(res, 404, { error: 'Pagamento não encontrado' });
    return sendJson(res, 200, updated);
  }

  // PAINEL ADMIN: ATIVAR ASSINATURA PAGA DE R$ 19,00 (30 DIAS) PARA UM TESTADOR E NOTIFICAR NO WHATSAPP
  if (pathname === '/api/admin/activate-paid' && req.method === 'POST') {
    const body = await parseBody(req);
    const subs = readJson(SUBS_FILE, []);
    const sub = subs.find(s => s.id === body.subscriberId || s.whatsapp === body.whatsapp);
    if (!sub) return sendJson(res, 404, { error: 'Assinante não encontrado' });

    const startDateStr = new Date().toLocaleDateString('pt-BR');
    const expDateStr = new Date(Date.now() + 30 * 86400000).toLocaleDateString('pt-BR');
    sub.plan = 'mensal_19';
    sub.planName = 'Assinatura Mensal Pix (R$ 19/mês)';
    sub.amount = 19.00;
    sub.paidAt = startDateStr;
    sub.expiresAt = expDateStr;
    sub.status = 'active';
    writeJson(SUBS_FILE, subs);

    appendSubscriberToGoogleSheets(sub);

    const confirmMsg =
      `✅ *PAGAMENTO CONFIRMADO — ASSINATURA ATIVA!* ⚡\n\n` +
      `Olá, *${sub.name}*! Confirmamos seu pagamento de *R$ 19,00 via Pix*.\n\n` +
      `📋 *Dados da sua assinatura:*\n` +
      `• *Status:* Ativa (5 vagas por dia às 07h00)\n` +
      `• *Data de início:* ${startDateStr}\n` +
      `• *Próxima renovação:* ${expDateStr}\n` +
      `• *Regra de renovação:* Enviaremos um lembrete 2 dias antes do vencimento (tolerância de 2 dias após o vencimento).\n` +
      `• *Sem fidelidade:* Para cancelar a qualquer momento, basta responder *PARAR*.`;

    const waRes = await sendWhatsAppMessage(sub.whatsapp, confirmMsg);
    return sendJson(res, 200, { ok: true, subscriber: sub, waRes });
  }

  // PAINEL ADMIN: ENVIAR COBRANÇA DE FIM DE TESTE (R$ 19 PIX) NO WHATSAPP DE UM TESTADOR
  if (pathname === '/api/admin/send-pix-offer' && req.method === 'POST') {
    const body = await parseBody(req);
    const subs = readJson(SUBS_FILE, []);
    const sub = subs.find(s => s.id === body.subscriberId || s.whatsapp === body.whatsapp);
    if (!sub) return sendJson(res, 404, { error: 'Assinante não encontrado' });

    const pixMsg = await buildTrialEndPixMessage(sub);
    const waRes = await sendWhatsAppMessage(sub.whatsapp, pixMsg);
    return sendJson(res, 200, { ok: true, waRes });
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
    const paymentsObj = readJson(PAYMENTS_FILE, {});
    const pendingLeads = Object.values(paymentsObj)
      .filter(p => !p.activated && p.status !== 'approved')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return sendJson(res, 200, {
      config: {
        hasMpToken: !!(process.env.MP_ACCESS_TOKEN || '').trim(),
        wahaUrl: process.env.WAHA_URL || '',
        wahaSession: process.env.WAHA_SESSION || 'default',
        spreadsheetId: process.env.SPREADSHEET_ID || '1CC_Lwd_6dH8BSYyKgavoYwagG_OHyr35uDbcwphg97Y'
      },
      subscribers: subs,
      pendingLeads
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

  // CADASTRAR TESTE GRÁTIS DE 3 DIAS E DISPARAR NO WHATSAPP
  if (pathname === '/api/admin/test-waha' && req.method === 'POST') {
    const body = await parseBody(req);
    const trialDays = Number(body.trialDays) || 3;
    const expDate = new Date(Date.now() + trialDays * 86400000).toLocaleDateString('pt-BR');
    const areaCombined = body.area
      ? `${body.area}${body.city ? ` | Local: (${body.city})` : ''}`
      : 'Administrativo / Atendimento | Local: (Salvador - BA)';

    const sampleSub = {
      id: crypto.randomUUID(),
      paymentId: 'trial_' + Date.now(),
      createdAt: new Date().toISOString(),
      name: body.name || 'Convidado VIP',
      whatsapp: body.whatsapp || '71991971396',
      profile: body.profile || 'homeoffice',
      area: areaCombined,
      plan: 'trial_3d',
      planName: `Teste Grátis (${trialDays} Dias)`,
      bump1: true,
      bump2: true,
      amount: 0,
      consent: !!body.consent,
      utms: body.utms || { utm_source: 'direto' },
      status: 'active',
      expiresAt: expDate,
      sentJobLinks: []
    };

    if (body.saveTrial !== false) {
      const subs = readJson(SUBS_FILE, []);
      subs.unshift(sampleSub);
      writeJson(SUBS_FILE, subs);
      appendSubscriberToGoogleSheets(sampleSub);
    }

    const msg = await buildWelcomeWhatsAppMessage(sampleSub);
    const result = await sendWhatsAppMessage(sampleSub.whatsapp, msg);
    return sendJson(res, 200, { ...result, subscriber: sampleSub });
  }

  // PAINEL ADMIN: DISPARAR BOLETIM MATINAL PARA TODOS OS ATIVOS AGORA
  if (pathname === '/api/admin/broadcast-morning' && req.method === 'POST') {
    const summary = await runMorningBroadcast();
    return sendJson(res, 200, summary);
  }

  // SERVIR PÁGINAS E ARQUIVOS ESTÁTICOS (Incluindo /privacidade e /termos)
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (pathname === '/admin') filePath = path.join(__dirname, 'public', 'admin.html');
  if (pathname === '/privacidade') filePath = path.join(__dirname, 'public', 'privacidade.html');
  if (pathname === '/termos') filePath = path.join(__dirname, 'public', 'termos.html');

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.png': 'image/png'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Página não encontrada');
});

// Calcula quantos dias faltam para o vencimento (DD/MM/AAAA)
function daysUntilExpiration(expiresAtStr) {
  if (!expiresAtStr) return 999;
  const parts = String(expiresAtStr).split('/');
  if (parts.length !== 3) return 999;
  const expDate = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]), 23, 59, 59);
  const diffMs = expDate.getTime() - Date.now();
  return Math.floor(diffMs / 86400000);
}

// Disparo Matinal Automático das 07h00 + Automação de Fim de Teste e Renovação (Página 3 Auditoria)
let lastBroadcastDate = '';
async function runMorningBroadcast() {
  const subs = readJson(SUBS_FILE, []);
  let sentCount = 0;
  let expiredCount = 0;

  for (const sub of subs) {
    if (sub.status !== 'active') continue;

    const daysLeft = daysUntilExpiration(sub.expiresAt);

    // Se já passou da tolerância (vencido):
    // - Para teste grátis (trial_3d): encerra no dia seguinte ao vencimento e envia a oferta de R$ 19/mês via Pix
    // - Para assinante mensal (mensal_19): tolerância de 2 dias após o vencimento
    const toleranceDays = sub.plan === 'trial_3d' ? -1 : -3;
    if (daysLeft <= toleranceDays) {
      sub.status = 'expired';
      expiredCount++;
      const pixOfferMsg = await buildTrialEndPixMessage(sub);
      await sendWhatsAppMessage(sub.whatsapp, pixOfferMsg);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // Dispara o boletim matinal de 5 vagas abertas sem repetir as de ontem
    const msg = await buildWelcomeWhatsAppMessage(sub);
    let morningMsg = msg.replace(
      '⚡ *BEM-VINDO(A) AO VAGAZAP IA!* ⚡',
      `☀️ *BOM DIA, ${(sub.name || 'ASSINANTE').toUpperCase()}! SUAS 5 VAGAS DAS 07H00* ⚡`
    );

    // Se é o último dia do teste (daysLeft === 0) ou faltam 2 dias para renovar assinatura paga, adiciona aviso no final
    if (sub.plan === 'trial_3d' && daysLeft === 0) {
      const pixOffer = await buildTrialEndPixMessage(sub);
      morningMsg += `\n\n────────────────────\n${pixOffer}`;
    } else if (sub.plan !== 'trial_3d' && (daysLeft === 2 || daysLeft === 0)) {
      morningMsg += `\n\n🔔 *Aviso de Renovação:* Sua assinatura mensal vence em *${sub.expiresAt}*. Para renovar por mais 30 dias (R$ 19,00 via Pix), digite *PIX* aqui na conversa.`;
    }

    await sendWhatsAppMessage(sub.whatsapp, morningMsg);
    sentCount++;
    await new Promise(r => setTimeout(r, 2000));
  }

  writeJson(SUBS_FILE, subs);
  console.log(`[Disparo Matinal 07h00] Enviados: ${sentCount} | Encerrados/Cobrados: ${expiredCount}`);
  return { ok: true, sentCount, expiredCount };
}

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`⚡ VagaZap SaaS rodando em: http://localhost:${PORT}`);
  console.log(`📱 Painel Admin (WhatsApp QR + MP): http://localhost:${PORT}/admin`);
  console.log(`====================================================`);
  initNativeWhatsApp();

  // Keep-Alive automático a cada 10 minutos para manter o plano Free do Render acordado 24h
  const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://vagazap.onrender.com';
  setInterval(() => {
    fetch(`${renderUrl}/api/whatsapp/status`).catch(() => {});
  }, 10 * 60 * 1000);

  // Relógio Interno: Verifica a cada 60 segundos se são 07:00 da manhã (Horário de Brasília)
  setInterval(() => {
    try {
      const nowBr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const dateKey = nowBr.toISOString().slice(0, 10);
      if (nowBr.getHours() === 7 && nowBr.getMinutes() === 0 && lastBroadcastDate !== dateKey) {
        lastBroadcastDate = dateKey;
        runMorningBroadcast().catch(err => console.error('[Erro Cron 07h00]:', err.message));
      }
    } catch {}
  }, 60 * 1000);
});
