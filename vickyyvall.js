/**
 * VGen AI — Telegram Bot + Web Control Panel
 * Node.js 22+
 *
 * Security:
 * - Telegram/API secrets are read from environment variables.
 * - No provider API key is embedded in index.html.
 * - The web panel and API are served from the same origin, so deployed
 *   installations do not accidentally call the user's phone at 127.0.0.1.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const MAX_HISTORY = 15;
const MAX_TEXT_FILE_KB = Number(process.env.MAX_TEXT_FILE_KB || 5000);

const GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.5-flash'
];

const OPENAI_MODEL = 'gpt-5.4-mini';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN belum diisi di environment.');
  process.exit(1);
}

function safeError(err) {
  let msg = String(err?.message || err || 'Unknown error');
  try {
    for (const item of [
      ...(secretConfig?.geminiAccounts || []),
      ...(secretConfig?.openaiAccounts || [])
    ]) {
      if (item?.key) msg = msg.split(item.key).join('[REDACTED]');
    }
  } catch {}
  return msg.replace(/key=[^&\s]+/gi, 'key=[REDACTED]').slice(0, 700);
}

process.on('uncaughtException', (err) => console.error('[UNCAUGHT EXCEPTION]', safeError(err)));
process.on('unhandledRejection', (err) => console.error('[UNHANDLED REJECTION]', safeError(err)));

let vgenPrompt = 'Kamu adalah VGen AI, asisten yang cerdas, efisien, dan membantu.';
try {
  const loadedPrompt = require('./prompt.js');
  if (typeof loadedPrompt === 'string' && loadedPrompt.trim()) vgenPrompt = loadedPrompt.trim();
} catch {}

function loadAccounts(prefix) {
  const out = [];
  for (let i = 1; i <= 100; i++) {
    const email = String(process.env[`${prefix}_EMAIL_${i}`] || '').trim();
    const key = String(process.env[`${prefix}_KEY_${i}`] || '').trim();
    if (email && key) out.push({ email, key });
  }
  return out;
}

let secretConfig = {
  geminiAccounts: loadAccounts('GEMINI'),
  openaiAccounts: loadAccounts('OPENAI')
};

const dbFile = path.join(__dirname, 'database.json');
let db = { apiConfig: {} };
try {
  if (fs.existsSync(dbFile)) db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
} catch (err) {
  console.error('❌ Gagal membaca database.json:', safeError(err));
}

let activeProvider = String(db.apiConfig?.provider || '').toUpperCase() || null;
let geminiAccountIndex = Number.isInteger(db.apiConfig?.geminiAccountIndex) ? db.apiConfig.geminiAccountIndex : 0;
let geminiModelIndex = Number.isInteger(db.apiConfig?.geminiModelIndex) ? db.apiConfig.geminiModelIndex : 0;

function saveDb() {
  db.apiConfig = {
    provider: activeProvider,
    geminiAccountIndex,
    geminiModelIndex
  };
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

function clampPointers() {
  if (geminiAccountIndex < 0 || geminiAccountIndex >= secretConfig.geminiAccounts.length) geminiAccountIndex = 0;
  if (geminiModelIndex < 0 || geminiModelIndex >= GEMINI_MODELS.length) geminiModelIndex = 0;
  if (activeProvider === 'GEMINI' && !secretConfig.geminiAccounts.length) activeProvider = null;
  if (activeProvider === 'OPENAI' && !secretConfig.openaiAccounts.length) activeProvider = null;
}
clampPointers();

const userHistory = new Map();
const aiMutedChats = new Set();
const failoverInFlight = new Map();

function historyFor(chatId) {
  const id = String(chatId);
  if (!userHistory.has(id)) userHistory.set(id, []);
  return userHistory.get(id);
}

function pushHistory(chatId, role, content) {
  const history = historyFor(chatId);
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
}

function cleanText(value) {
  return String(value || '').trim();
}

function nowWIB() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

function escapeHTML(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function convertMarkdownToHTML(text) {
  if (!text) return '';
  let formatted = escapeHTML(String(text));
  formatted = formatted.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  formatted = formatted.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<b>$2</b>');
  return formatted;
}

function splitForTelegram(text, max = 4000) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < 500) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}

async function sendReply(chatId, text, extra = {}) {
  const htmlText = convertMarkdownToHTML(text);
  for (const chunk of splitForTelegram(htmlText)) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML', ...extra });
    } catch (err) {
      console.error('[SEND HTML ERROR]', safeError(err));
      try {
        await bot.sendMessage(chatId, chunk.replace(/<[^>]*>?/gm, ''), extra);
      } catch {}
    }
  }
}

function randomMs(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function currentGeminiTarget() {
  const accounts = secretConfig.geminiAccounts;
  if (!accounts.length) throw new Error('Gemini belum memiliki API key di environment.');
  clampPointers();
  const account = accounts[geminiAccountIndex];
  return {
    accountIndex: geminiAccountIndex,
    modelIndex: geminiModelIndex,
    email: account.email,
    key: account.key,
    model: GEMINI_MODELS[geminiModelIndex]
  };
}

function advanceGeminiTarget() {
  geminiModelIndex++;
  if (geminiModelIndex >= GEMINI_MODELS.length) {
    geminiModelIndex = 0;
    geminiAccountIndex++;
    if (geminiAccountIndex >= secretConfig.geminiAccounts.length) geminiAccountIndex = 0;
  }
  saveDb();
  return currentGeminiTarget();
}

function isQuotaOrRateLimitError(status, data) {
  const code = String(data?.error?.status || data?.error?.code || '').toUpperCase();
  const msg = String(data?.error?.message || '').toLowerCase();
  return status === 429 ||
    (status === 403 && /(quota|rate.?limit|resource.?exhausted|exceeded|permission)/i.test(msg)) ||
    code.includes('RESOURCE_EXHAUSTED') ||
    /(quota|rate.?limit|resource.?exhausted|too many requests|exceeded)/i.test(msg);
}

async function sendFailoverSequence(chatId, sourceMessageId) {
  const key = String(chatId);
  if (failoverInFlight.has(key)) return failoverInFlight.get(key);
  const job = (async () => {
    try {
      await sendReply(chatId, '⏳ Loading…', { reply_to_message_id: sourceMessageId });
      await new Promise(r => setTimeout(r, randomMs(900, 1800)));
      await sendReply(chatId, 'Server penuh, pindah jalur AI…');
      await new Promise(r => setTimeout(r, randomMs(600, 1200)));
      await sendReply(chatId, 'AI berevolusi kembali ✅');
    } catch (err) {
      console.error('[FAILOVER NOTICE]', safeError(err));
    } finally {
      failoverInFlight.delete(key);
    }
  })();
  failoverInFlight.set(key, job);
  return job;
}

function buildGeminiContents(chatId, finalPrompt, base64Media, mimeTypeMedia) {
  const history = historyFor(chatId)
    .slice(-10)
    .map(item => ({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: item.content }]
    }));

  const parts = [{ text: `${vgenPrompt}\n\n${finalPrompt}` }];
  if (base64Media && mimeTypeMedia) {
    parts.push({
      inline_data: { mime_type: mimeTypeMedia, data: base64Media }
    });
  }
  return [...history, { role: 'user', parts }];
}

async function askGemini(chatId, finalPrompt, base64Media, mimeTypeMedia, sourceMessageId) {
  if (!secretConfig.geminiAccounts.length) throw new Error('Gemini belum diaktifkan.');
  let attempts = 0;
  const maxAttempts = Math.max(3, secretConfig.geminiAccounts.length * GEMINI_MODELS.length * 2);

  while (attempts++ < maxAttempts) {
    const target = currentGeminiTarget();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(target.model)}:generateContent?key=${encodeURIComponent(target.key)}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: buildGeminiContents(chatId, finalPrompt, base64Media, mimeTypeMedia) })
      });
    } catch (err) {
      console.error('[GEMINI NETWORK ERROR]', safeError(err));
      advanceGeminiTarget();
      await new Promise(r => setTimeout(r, randomMs(500, 1000)));
      continue;
    }

    let data = null;
    try { data = await response.json(); } catch {}

    if (response.ok) {
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim();
      if (text) return text;
      console.warn('[GEMINI EMPTY RESPONSE]', target.model);
      advanceGeminiTarget();
      continue;
    }

    if (isQuotaOrRateLimitError(response.status, data)) {
      console.warn(`[GEMINI QUOTA] ${target.email} / ${target.model}`);
      advanceGeminiTarget();
      await sendFailoverSequence(chatId, sourceMessageId);
      continue;
    }

    if (response.status === 503) {
      advanceGeminiTarget();
      await new Promise(r => setTimeout(r, randomMs(500, 1000)));
      continue;
    }

    console.error(`[GEMINI ${response.status}]`, safeError(data));
    advanceGeminiTarget();
    await new Promise(r => setTimeout(r, randomMs(400, 900)));
  }

  throw new Error('Semua target Gemini gagal merespons.');
}

async function askOpenAI(chatId, finalPrompt, base64Media, mimeTypeMedia) {
  const account = secretConfig.openaiAccounts[0];
  if (!account?.key) throw new Error('OpenAI belum memiliki API key di environment.');

  const content = [{ type: 'input_text', text: `${vgenPrompt}\n\n${finalPrompt}` }];
  if (base64Media && mimeTypeMedia?.startsWith('image/')) {
    content.push({
      type: 'input_image',
      image_url: `data:${mimeTypeMedia};base64,${base64Media}`
    });
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.key}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [{ role: 'user', content }]
    })
  });

  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    console.error(`[OPENAI ${response.status}]`, safeError(data));
    throw new Error('OpenAI request failed.');
  }

  let outputText = cleanText(data?.output_text);
  if (!outputText && Array.isArray(data?.output)) {
    outputText = data.output.flatMap(x => Array.isArray(x?.content) ? x.content : [])
      .map(x => x?.text || '').join('').trim();
  }
  if (!outputText) throw new Error('OpenAI mengembalikan respons kosong.');
  return outputText;
}

async function askAI(chatId, finalPrompt, base64Media, mimeTypeMedia, sourceMessageId) {
  if (activeProvider === 'GEMINI') return askGemini(chatId, finalPrompt, base64Media, mimeTypeMedia, sourceMessageId);
  if (activeProvider === 'OPENAI') return askOpenAI(chatId, finalPrompt, base64Media, mimeTypeMedia);
  throw new Error('Provider AI belum diaktifkan.');
}

function getMediaFromMessage(msg) {
  if (msg?.photo?.length) return { type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, mimeType: 'image/jpeg' };
  if (msg?.document) return { type: 'document', fileId: msg.document.file_id, mimeType: msg.document.mime_type || 'application/octet-stream', fileName: msg.document.file_name || 'file' };
  if (msg?.video) return { type: 'video', fileId: msg.video.file_id, mimeType: msg.video.mime_type || 'video/mp4' };
  if (msg?.audio) return { type: 'audio', fileId: msg.audio.file_id, mimeType: msg.audio.mime_type || 'audio/mpeg' };
  return null;
}

async function downloadTelegramFile(fileId) {
  const file = await bot.getFile(fileId);
  if (!file?.file_path) throw new Error('Telegram file path tidak ditemukan.');
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  return { buffer: Buffer.from(await response.arrayBuffer()), filePath: file.file_path };
}

async function buildMediaPrompt(msg, text) {
  const media = getMediaFromMessage(msg);
  if (!media) return { finalPrompt: text, base64Media: null, mimeTypeMedia: null };

  try {
    const downloaded = await downloadTelegramFile(media.fileId);
    if (downloaded.buffer.length > MAX_TEXT_FILE_KB * 1024) {
      return {
        finalPrompt: `${text}\n\n[Sistem: ${media.type} terlalu besar untuk diproses penuh.]`,
        base64Media: null,
        mimeTypeMedia: null
      };
    }
    return {
      finalPrompt: `${text}\n\n[Sistem: Pengguna mengirim ${media.type}.]`,
      base64Media: downloaded.buffer.toString('base64'),
      mimeTypeMedia: media.mimeType
    };
  } catch (err) {
    console.error('[MEDIA DOWNLOAD ERROR]', safeError(err));
    return {
      finalPrompt: `${text}\n\n[Sistem: Media pengguna gagal diambil. Gunakan teks/caption jika tersedia.]`,
      base64Media: null,
      mimeTypeMedia: null
    };
  }
}

async function processAIMessage(msg, finalPrompt, base64Media, mimeTypeMedia) {
  const chatId = String(msg.chat.id);
  if (!activeProvider) {
    await sendReply(chatId, '⚠️ Provider AI belum aktif. Buka panel VGen lalu aktifkan Gemini atau GPT.');
    return;
  }

  let stopped = false;
  const presence = (async () => {
    while (!stopped) {
      try { await bot.sendChatAction(chatId, 'typing'); } catch {}
      await new Promise(r => setTimeout(r, 4500));
    }
  })();

  try {
    const response = await askAI(chatId, finalPrompt, base64Media, mimeTypeMedia, msg.message_id);
    const raw = cleanText(response) || 'AI tidak menghasilkan jawaban kali ini.';
    pushHistory(chatId, 'user', finalPrompt);
    pushHistory(chatId, 'assistant', raw);
    await sendReply(chatId, raw, { reply_to_message_id: msg.message_id });
  } catch (err) {
    console.error('[AI CORE ERROR]', safeError(err));
    await sendReply(chatId, '😵 AI gagal merespons setelah mencoba jalur yang tersedia. Cek status provider di panel.');
  } finally {
    stopped = true;
    await presence.catch(() => {});
  }
}

/* ---------------- TELEGRAM ---------------- */

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

bot.on('polling_error', err => console.error('[TELEGRAM POLLING ERROR]', safeError(err)));
bot.on('webhook_error', err => console.error('[TELEGRAM WEBHOOK ERROR]', safeError(err)));

async function handleCommand(msg, command) {
  const chatId = msg.chat.id;
  const cmd = command.toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await sendReply(chatId,
      `🤖 <b>VGen AI Online</b>\n\n` +
      `Provider: <b>${activeProvider || 'BELUM AKTIF'}</b>\n` +
      `Model: <b>${activeProvider === 'GEMINI' ? currentGeminiTarget().model : activeProvider === 'OPENAI' ? OPENAI_MODEL : '-'}</b>\n\n` +
      `Kirim pesan biasa untuk ngobrol.\n` +
      `Gunakan /status untuk cek koneksi, /reset untuk reset percakapan, /mute atau /unmute untuk kontrol balasan.`
    );
    return true;
  }

  if (cmd === '/status') {
    let model = '-';
    if (activeProvider === 'GEMINI' && secretConfig.geminiAccounts.length) model = currentGeminiTarget().model;
    if (activeProvider === 'OPENAI') model = OPENAI_MODEL;
    await sendReply(chatId,
      `🟢 <b>Telegram TERHUBUNG</b>\n` +
      `Provider: <b>${activeProvider || 'BELUM AKTIF'}</b>\n` +
      `Model: <b>${model}</b>\n` +
      `Gemini account: <b>${secretConfig.geminiAccounts.length}</b>\n` +
      `OpenAI account: <b>${secretConfig.openaiAccounts.length}</b>\n` +
      `Waktu: <b>${nowWIB()} WIB</b>`
    );
    return true;
  }

  if (cmd === '/reset') {
    userHistory.delete(String(chatId));
    await sendReply(chatId, '♻️ Riwayat percakapan di-reset.');
    return true;
  }

  if (cmd === '/mute') {
    aiMutedChats.add(String(chatId));
    await sendReply(chatId, '🔕 Bot dimute untuk chat ini. Gunakan /unmute untuk menyalakan lagi.');
    return true;
  }

  if (cmd === '/unmute') {
    aiMutedChats.delete(String(chatId));
    await sendReply(chatId, '🔔 Bot aktif kembali.');
    return true;
  }

  return false;
}

bot.on('callback_query', async query => {
  const data = String(query.data || '');
  try { await bot.answerCallbackQuery(query.id); } catch {}
  if (!data.startsWith('ask|') || !query.message) return;
  const action = data.slice(4).trim();
  if (!action) return;
  await processAIMessage(query.message,
    `[INFO SISTEM: Pengguna menekan tombol interaktif.]\n${action}`,
    null, null
  );
});

bot.on('message', async msg => {
  const text = cleanText(msg.text || msg.caption || '');
  const commandMatch = text.match(/^\/(start|help|status|reset|mute|unmute)(?:@\w+)?/i);

  try {
    if (commandMatch) {
      await handleCommand(msg, `/${commandMatch[1]}`);
      return;
    }

    if (!text && !getMediaFromMessage(msg)) return;
    if (aiMutedChats.has(String(msg.chat.id))) return;

    if (msg.date && Math.floor(Date.now() / 1000) - msg.date > 120) return;

    const media = await buildMediaPrompt(msg, text || '[Sistem: Pengguna mengirim media tanpa caption.]');
    const finalPrompt = `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB.]\n\n${media.finalPrompt}`;
    await processAIMessage(msg, finalPrompt, media.base64Media, media.mimeTypeMedia);
  } catch (err) {
    console.error('[MESSAGE ERROR]', safeError(err));
    try { await sendReply(msg.chat.id, '😵 Terjadi gangguan internal. Coba lagi.'); } catch {}
  }
});

/* ---------------- WEB CONTROL PANEL ---------------- */

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  return `••••••${s.slice(-6)}`;
}

function publicConfig() {
  return {
    ok: true,
    provider: activeProvider,
    telegram: {
      polling: true,
      tokenConfigured: Boolean(TELEGRAM_BOT_TOKEN)
    },
    gemini: {
      accounts: secretConfig.geminiAccounts.map((a, index) => ({
        index,
        email: a.email,
        maskedKey: maskKey(a.key)
      })),
      models: GEMINI_MODELS,
      currentAccountIndex: geminiAccountIndex,
      currentModelIndex: geminiModelIndex
    },
    openai: {
      accounts: secretConfig.openaiAccounts.map((a, index) => ({
        index,
        email: a.email,
        maskedKey: maskKey(a.key)
      })),
      model: OPENAI_MODEL
    },
    timeWIB: nowWIB()
  };
}

app.get('/api/status', async (req, res) => {
  let telegram = { ok: false, username: null, id: null };
  try {
    const me = await bot.getMe();
    telegram = { ok: true, username: me.username || null, id: me.id || null };
  } catch (err) {
    telegram = { ok: false, error: safeError(err) };
  }

  res.json({
    ok: true,
    provider: activeProvider,
    model: activeProvider === 'GEMINI' && secretConfig.geminiAccounts.length ? currentGeminiTarget().model :
      activeProvider === 'OPENAI' ? OPENAI_MODEL : null,
    telegram,
    geminiAccounts: secretConfig.geminiAccounts.length,
    openaiAccounts: secretConfig.openaiAccounts.length,
    timeWIB: nowWIB()
  });
});

app.get('/public-config', (req, res) => res.json(publicConfig()));

app.post('/activate-provider', (req, res) => {
  const provider = String(req.body?.provider || '').toUpperCase();
  if (!['GEMINI', 'OPENAI'].includes(provider)) {
    return res.status(400).json({ ok: false, error: 'Provider tidak valid.' });
  }

  const accounts = provider === 'GEMINI' ? secretConfig.geminiAccounts : secretConfig.openaiAccounts;
  if (!accounts.length) {
    return res.status(400).json({
      ok: false,
      error: provider === 'GEMINI'
        ? 'Belum ada GEMINI_KEY/GEMINI_EMAIL di environment.'
        : 'Belum ada OPENAI_KEY/OPENAI_EMAIL di environment.'
    });
  }

  activeProvider = provider;
  clampPointers();
  saveDb();

  const model = provider === 'GEMINI' ? currentGeminiTarget().model : OPENAI_MODEL;
  res.json({
    ok: true,
    provider,
    model,
    account: provider === 'GEMINI' ? currentGeminiTarget().email : accounts[0].email
  });
});

app.post('/api/test-provider', async (req, res) => {
  const provider = String(req.body?.provider || '').toUpperCase();
  const accountIndex = Number.isInteger(req.body?.accountIndex) ? req.body.accountIndex : 0;
  const requestedModel = cleanText(req.body?.model);
  const prompt = cleanText(req.body?.prompt) || 'Ping VGen AI. Balas singkat: koneksi API aktif.';

  try {
    if (provider === 'GEMINI') {
      const account = secretConfig.geminiAccounts[accountIndex];
      if (!account) return res.status(404).json({ ok: false, error: 'Akun Gemini tidak ditemukan.' });
      const model = GEMINI_MODELS.includes(requestedModel) ? requestedModel : GEMINI_MODELS[0];
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(account.key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return res.status(response.status).json({
          ok: false,
          provider,
          model,
          account: account.email,
          error: data?.error?.message || `Gemini HTTP ${response.status}`
        });
      }
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim();
      if (!text) return res.status(502).json({ ok: false, error: 'Gemini memberi respons kosong.' });
      return res.json({ ok: true, provider, model, account: account.email, text });
    }

    if (provider === 'OPENAI') {
      const account = secretConfig.openaiAccounts[accountIndex] || secretConfig.openaiAccounts[0];
      if (!account) return res.status(404).json({ ok: false, error: 'Akun OpenAI tidak ditemukan.' });

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${account.key}`
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
        })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return res.status(response.status).json({
          ok: false,
          provider,
          model: OPENAI_MODEL,
          account: account.email,
          error: data?.error?.message || `OpenAI HTTP ${response.status}`
        });
      }
      const text = cleanText(data?.output_text) ||
        (Array.isArray(data?.output) ? data.output.flatMap(x => Array.isArray(x?.content) ? x.content : []).map(x => x?.text || '').join('').trim() : '');
      if (!text) return res.status(502).json({ ok: false, error: 'OpenAI memberi respons kosong.' });
      return res.json({ ok: true, provider, model: OPENAI_MODEL, account: account.email, text });
    }

    return res.status(400).json({ ok: false, error: 'Provider tidak valid.' });
  } catch (err) {
    console.error('[TEST PROVIDER]', safeError(err));
    return res.status(502).json({ ok: false, error: 'Gagal menghubungi provider AI.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'VGen AI Telegram Bot',
    provider: activeProvider,
    telegramPolling: bot.isPolling?.() ?? false,
    timeWIB: nowWIB()
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

async function start() {
  try {
    await bot.deleteWebHook({ drop_pending_updates: false });
  } catch (err) {
    console.warn('[TELEGRAM] deleteWebhook gagal:', safeError(err));
  }

  try {
    const me = await bot.getMe();
    console.log(`✅ Telegram bot valid: @${me.username || 'unknown'}`);
  } catch (err) {
    console.error('❌ Token Telegram tidak valid / Telegram tidak bisa dijangkau:', safeError(err));
    process.exit(1);
  }

  await bot.startPolling({
    restart: true,
    polling: { interval: 300, autoStart: true, params: { timeout: 30 } }
  });

  app.listen(PORT, HOST, () => {
    console.log(`🌐 VGen Control Panel: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
    console.log(`🤖 Provider: ${activeProvider || 'BELUM AKTIF'}`);
    console.log(`🔐 Gemini accounts: ${secretConfig.geminiAccounts.length}`);
    console.log(`🔐 OpenAI accounts: ${secretConfig.openaiAccounts.length}`);
  });
}

start().catch(err => {
  console.error('[STARTUP FATAL]', safeError(err));
  process.exit(1);
});
