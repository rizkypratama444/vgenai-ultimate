/**
 * VGEN AI - TELEGRAM BOT EDITION
 * Server-side provider selector + Gemini automatic quota failover.
 * Node.js 22+.
 *
 * IMPORTANT:
 * - API keys are loaded from ./vgen-secrets.json, never sent to the browser.
 * - TELEGRAM_BOT_TOKEN stays in environment variables.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', safeError(err));
});
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', safeError(reason));
});

function safeError(err) {
    let msg = String(err?.message || err || 'Unknown error');
    try {
        const all = [...(secretConfig?.geminiAccounts || []), ...(secretConfig?.openaiAccounts || [])];
        for (const item of all) {
            if (item?.key) msg = msg.split(item.key).join('[REDACTED]');
        }
    } catch {}
    return msg.replace(/key=[^&\s]+/gi, 'key=[REDACTED]').slice(0, 700);
}

let vgenPrompt = '';
try {
    vgenPrompt = require('./prompt.js');
} catch {
    vgenPrompt = 'Kamu adalah VGen AI, asisten yang cerdas dan efisien.';
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'PASTE_BOT_TOKEN_DI_SINI';
const PORT = process.env.PORT || 8080;
const MAX_HISTORY = 15;
const MAX_TEXT_FILE = 5000;

if (TELEGRAM_BOT_TOKEN === 'PASTE_BOT_TOKEN_DI_SINI') {
    console.error('❌ TELEGRAM_BOT_TOKEN belum diisi. Set environment variable TELEGRAM_BOT_TOKEN.');
    process.exit(1);
}

const secretFile = path.join(__dirname, 'vgen-secrets.json');
let secretConfig = { geminiAccounts: [], openaiAccounts: [] };

try {
    secretConfig = JSON.parse(fs.readFileSync(secretFile, 'utf8'));
} catch (e) {
    console.error('❌ vgen-secrets.json tidak ditemukan/tidak valid:', safeError(e));
    process.exit(1);
}

const GEMINI_MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.5-flash'
];

const OPENAI_MODEL = 'gpt-5.4-mini';

if (!Array.isArray(secretConfig.geminiAccounts) || secretConfig.geminiAccounts.length === 0) {
    console.error('❌ Tidak ada Gemini API account di vgen-secrets.json.');
    process.exit(1);
}

const dbFile = path.join(__dirname, 'database.json');
let db = { apiConfig: {} };

if (fs.existsSync(dbFile)) {
    try {
        db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (e) {
        console.error('❌ Gagal membaca database.json:', safeError(e));
    }
}

function saveDb() {
    // Hanya simpan state non-secret.
    db.apiConfig = {
        provider: activeProvider,
        geminiAccountIndex: geminiAccountIndex,
        geminiModelIndex: geminiModelIndex
    };
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

let activeProvider = String(db.apiConfig?.provider || '').toUpperCase() || null;
let geminiAccountIndex = Number.isInteger(db.apiConfig?.geminiAccountIndex) ? db.apiConfig.geminiAccountIndex : 0;
let geminiModelIndex = Number.isInteger(db.apiConfig?.geminiModelIndex) ? db.apiConfig.geminiModelIndex : 0;

if (geminiAccountIndex < 0 || geminiAccountIndex >= secretConfig.geminiAccounts.length) geminiAccountIndex = 0;
if (geminiModelIndex < 0 || geminiModelIndex >= GEMINI_MODELS.length) geminiModelIndex = 0;

const userHistory = new Map();
const aiMutedChats = new Set();
const failoverInFlight = new Map();

function historyFor(chatId) {
    const key = String(chatId);
    if (!userHistory.has(key)) userHistory.set(key, []);
    return userHistory.get(key);
}

function pushHistory(chatId, role, content) {
    const history = historyFor(chatId);
    history.push({ role, content });
    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }
}

function cleanText(value) {
    return String(value || '').trim();
}

function nowWIB() {
    return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

function isCommand(text) {
    return /^\/(?:start|help|mute|unmute|status|reset)(?:@\w+)?(?:\s|$)/i.test(text);
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
    let formatted = String(text);

    formatted = formatted.replace(/```([\s\S]*?)```/g, (match, codeBlock) => {
        let cleanCode = codeBlock.replace(/^[a-z]+\n/i, '');
        let safeCode = escapeHTML(cleanCode);
        return `<pre><code>${safeCode}</code></pre>`;
    });

    formatted = formatted.replace(/`([^`]+)`/g, (match, code) => {
        return `<code>${escapeHTML(code)}</code>`;
    });

    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    formatted = formatted.replace(/\*([^*]+)\*/g, '<b>$1</b>');
    formatted = formatted.replace(/[\uFFFD]/g, '•');

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

async function sendReply(bot, chatId, text, extra = {}) {
    const htmlText = convertMarkdownToHTML(text);
    for (const chunk of splitForTelegram(htmlText)) {
        try {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML', ...extra });
        } catch (e) {
            console.error('[SEND HTML ERROR]', safeError(e));
            try {
                await bot.sendMessage(chatId, chunk.replace(/<[^>]*>?/gm, ''), {
                    ...extra,
                    parse_mode: undefined
                });
            } catch {}
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomMs(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
}

function currentGeminiTarget() {
    const account = secretConfig.geminiAccounts[geminiAccountIndex];
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

        if (geminiAccountIndex >= secretConfig.geminiAccounts.length) {
            geminiAccountIndex = 0;
        }
    }

    saveDb();
    return currentGeminiTarget();
}

function isQuotaOrRateLimitError(status, data) {
    const code = String(data?.error?.status || data?.error?.code || '').toUpperCase();
    const msg = String(data?.error?.message || '').toLowerCase();

    if (status === 429) return true;
    if (status === 403 && /(quota|rate.?limit|resource.?exhausted|exceeded|permission)/i.test(msg)) return true;
    if (code.includes('RESOURCE_EXHAUSTED')) return true;
    return /(quota|rate.?limit|resource.?exhausted|too many requests|exceeded)/i.test(msg);
}

async function sendFailoverSequence(chatId, sourceMessageId) {
    const key = String(chatId);

    if (failoverInFlight.has(key)) {
        return failoverInFlight.get(key);
    }

    const job = (async () => {
        try {
            // Pesan pertama MUTLAK reply/quote ke pesan lawan bicara.
            await sendReply(bot, chatId, '⏳Loading', {
                reply_to_message_id: sourceMessageId
            });

            // Random 1/2/3 detik.
            await sleep(randomMs(1000, 3000));

            await sendReply(bot, chatId, 'Server penuh, tunggu sebentar...');

            // Thinking terakhir singkat dan random, tidak dibuat lama.
            await sleep(randomMs(700, 1800));

            await sendReply(bot, chatId, 'AI Berevolusi kembali✅');
        } catch (e) {
            // Status failover tidak boleh mengganggu jawaban utama.
            console.error('[FAILOVER NOTICE]', safeError(e));
        } finally {
            failoverInFlight.delete(key);
        }
    })();

    failoverInFlight.set(key, job);
    return job;
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (err) => console.error('[TELEGRAM POLLING ERROR]', safeError(err)));
bot.on('webhook_error', (err) => console.error('[TELEGRAM WEBHOOK ERROR]', safeError(err)));

function startRecordingPresence(chatId) {
    let stopped = false;

    const sendPresence = async () => {
        if (stopped) return;
        try {
            await bot.sendChatAction(chatId, 'record_voice');
        } catch {}
    };

    sendPresence();
    const timer = setInterval(sendPresence, 4000);

    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

const START_BUTTON_POOL = [
    { text: '🧠 Jelasin sesuatu', callback_data: 'ask|jelasin satu hal menarik hari ini' },
    { text: '😂 Bikin aku ketawa', callback_data: 'ask|bikin aku ketawa dengan jokes singkat' },
    { text: '💡 Fakta random', callback_data: 'ask|kasih satu fakta random yang menarik' },
    { text: '⚽ Bahas bola', callback_data: 'ask|bahas sepak bola yang menarik' },
    { text: '🎵 Rekomendasi musik', callback_data: 'ask|rekomendasikan musik berdasarkan mood' },
    { text: '📱 Trik hp', callback_data: 'ask|kasih trik hp android yang berguna' },
    { text: '💻 Tips coding', callback_data: 'ask|kasih tips coding yang praktis' },
    { text: '🤖 Ngobrol ai', callback_data: 'ask|jelasin sesuatu yang menarik tentang ai' }
];

function randomStartButtons() {
    return [...START_BUTTON_POOL].sort(() => Math.random() - 0.5).slice(0, 2);
}

bot.onText(/^\/(start|help)(?:@\w+)?$/i, async (msg) => {
    const text =
        `<b>VGen AI Multifungsi</b> 😎\n\n` +
        `Teman AI yang siap nemenin lu kapan aja.\n\n` +
        `Provider aktif: <b>${escapeHTML(activeProvider || 'BELUM DIAKTIFKAN')}</b>\n` +
        `Gemini punya failover otomatis antar model + akun.\n\n` +
        `<b>Gas ngobrol 👇</b>`;

    const keyboard = [
        [
            { text: '💎 AM Prem 1th', url: 'https://t.me/vickyyvall' },
            { text: '🛒 Upgrade AI', callback_data: 'ask|info upgrade ai dan limit' }
        ],
        [
            { text: '🎵 Tiktok @vickyyvall', url: 'https://www.tiktok.com/@vickyyvall' }
        ],
        [
            { text: '📸 Instagram @vickyhx013_', url: 'https://www.instagram.com/vickyhx013_' }
        ],
        randomStartButtons()
    ];

    // 🟢 TARO LINK MEDIA LU DI SINI 🟢
    // Ganti URL di bawah sama link gambar/GIF lu! (Contoh: https://link-gambar.com/foto.jpg)
    const mediaUrl = 'https://ibb.co.com/6JW0kpT9';

    try {
        // Pake sendPhoto biar gambar dan teks gabung jadi satu (caption)
        await bot.sendPhoto(msg.chat.id, mediaUrl, {
            caption: text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (error) {
        // Fallback: Kalau link error/ngadat, bot gak bakal mati dan balik ngirim teks biasa
        await sendReply(bot, msg.chat.id, text, {
            reply_markup: { inline_keyboard: keyboard }
        });
    }
});
bot.onText(/^\/mute(?:@\w+)?$/i, async (msg) => {
    aiMutedChats.add(String(msg.chat.id));
    userHistory.delete(String(msg.chat.id));
    await sendReply(bot, msg.chat.id, 'Respon AI dimatikan untuk chat ini. Pakai /unmute kalau mau mengaktifkannya lagi.');
});

bot.onText(/^\/unmute(?:@\w+)?$/i, async (msg) => {
    aiMutedChats.delete(String(msg.chat.id));
    await sendReply(bot, msg.chat.id, 'Respon AI diaktifkan lagi.');
});

bot.onText(/^\/reset(?:@\w+)?$/i, async (msg) => {
    userHistory.delete(String(msg.chat.id));
    await sendReply(bot, msg.chat.id, 'Memori percakapan chat ini sudah direset.');
});

bot.onText(/^\/status(?:@\w+)?$/i, async (msg) => {
    const target = activeProvider === 'GEMINI' ? currentGeminiTarget() : null;

    await sendReply(bot, msg.chat.id,
        `Status VGen AI\n` +
        `Provider: ${activeProvider || 'BELUM DISET'}\n` +
        `Model: ${target?.model || (activeProvider === 'OPENAI' ? OPENAI_MODEL : 'BELUM DISET')}\n` +
        `Akun: ${target?.email || (activeProvider === 'OPENAI' ? (secretConfig.openaiAccounts[0]?.email || '-') : '-')}\n` +
        `Waktu WIB: ${nowWIB()}`
    );
});

async function downloadTelegramFile(fileId) {
    try {
        const file = await bot.getFile(fileId);
        if (!file.file_path) return null;

        const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const res = await fetch(url);

        if (!res.ok) throw new Error(`Download Telegram gagal (${res.status})`);

        const buffer = Buffer.from(await res.arrayBuffer());
        return { buffer, filePath: file.file_path };
    } catch (e) {
        console.error('[MEDIA DOWNLOAD]', safeError(e));
        return null;
    }
}

function getMediaFromMessage(msg) {
    if (msg.photo?.length) {
        return {
            fileId: msg.photo[msg.photo.length - 1].file_id,
            mediaType: 'image',
            mimeType: 'image/jpeg',
            fileName: 'telegram-photo.jpg'
        };
    }

    if (msg.document) {
        return {
            fileId: msg.document.file_id,
            mediaType: 'document',
            mimeType: msg.document.mime_type || 'application/octet-stream',
            fileName: msg.document.file_name || 'document'
        };
    }

    return null;
}

async function buildMediaPrompt(msg, basePrompt) {
    const media = getMediaFromMessage(msg);

    if (!media) {
        return { finalPrompt: basePrompt, base64Media: null, mimeTypeMedia: null };
    }

    const downloaded = await downloadTelegramFile(media.fileId);

    if (!downloaded) {
        return {
            finalPrompt: `[Sistem: Lampiran Telegram tidak berhasil diunduh.]\n\n${basePrompt}`,
            base64Media: null,
            mimeTypeMedia: null
        };
    }

    if (media.mediaType === 'document') {
        const lower = media.fileName.toLowerCase();
        const readable =
            media.mimeType.includes('text') ||
            media.mimeType.includes('json') ||
            media.mimeType.includes('javascript') ||
            /\.(js|json|txt|csv|html|css|py|md)$/i.test(lower);

        if (readable) {
            const text = downloaded.buffer.toString('utf8').slice(0, MAX_TEXT_FILE);

            return {
                finalPrompt:
                    `[Sistem: Pengguna mengirim dokumen "${media.fileName}"]\n` +
                    `Isi Dokumen:\n\`\`\`\n${text}\n\`\`\`\n\n` +
                    `Pesan: ${basePrompt}`,
                base64Media: null,
                mimeTypeMedia: null
            };
        }

        return {
            finalPrompt: `[Sistem: Pengguna mengirim lampiran dokumen "${media.fileName}".]\n\n${basePrompt}`,
            base64Media: null,
            mimeTypeMedia: media.mimeType
        };
    }

    return {
        finalPrompt: `[Sistem: Pengguna mengirim gambar. Analisa gambar tersebut.]\n\n${basePrompt}`,
        base64Media: downloaded.buffer.toString('base64'),
        mimeTypeMedia: 'image/jpeg'
    };
}

async function askOpenAI(chatId, finalPrompt, base64Media, mimeTypeMedia) {
    const account = secretConfig.openaiAccounts?.[0];

    if (!account?.key) {
        throw new Error('OpenAI belum memiliki API key server-side.');
    }

    let userContent = finalPrompt;

    if (base64Media) {
        userContent = [
            { type: 'text', text: finalPrompt },
            {
                type: 'image_url',
                image_url: {
                    url: `data:${mimeTypeMedia || 'image/jpeg'};base64,${base64Media}`
                }
            }
        ];
    }

    const history = historyFor(chatId);
    const messages = [
        {
            role: 'system',
            content: typeof vgenPrompt === 'string' ? vgenPrompt : JSON.stringify(vgenPrompt)
        },
        ...history,
        { role: 'user', content: userContent }
    ];

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${account.key}`
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages
        })
    });

    const data = await res.json();

    if (!res.ok || data.error) {
        throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
    }

    return data.choices?.[0]?.message?.content || 'Model tidak mengembalikan jawaban.';
}

async function askGemini(chatId, finalPrompt, base64Media, mimeTypeMedia, sourceMessageId) {
    const history = historyFor(chatId);
    const systemInstructionText =
        typeof vgenPrompt === 'string' ? vgenPrompt : JSON.stringify(vgenPrompt);

    // Maksimal satu putaran penuh: Lite -> Flash -> 3.5 -> akun berikutnya.
    // Jika seluruh putaran habis, ulangi lagi setelah jeda pendek.
    const maxRounds = 3;
    const totalTargets = secretConfig.geminiAccounts.length * GEMINI_MODELS.length;

    for (let round = 0; round < maxRounds; round++) {
        for (let attempt = 0; attempt < totalTargets; attempt++) {
            const target = currentGeminiTarget();

            const contents = history.map(h => ({
                role: h.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: h.content }]
            }));

            const parts = [{ text: finalPrompt }];

            if (base64Media) {
                parts.push({
                    inline_data: {
                        mime_type: mimeTypeMedia || 'image/jpeg',
                        data: base64Media
                    }
                });
            }

            contents.push({ role: 'user', parts });

            const endpoint =
                `https://generativelanguage.googleapis.com/v1beta/models/` +
                `${encodeURIComponent(target.model)}:generateContent?key=${encodeURIComponent(target.key)}`;

            let res;
            let data;

            try {
                res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        system_instruction: {
                            parts: [{ text: systemInstructionText }]
                        },
                        contents
                    })
                });

                data = await res.json();
            } catch (networkError) {
                // Gangguan jaringan bukan limit; coba target yang sama sekali lagi lewat
                // perpindahan target agar bot tidak menggantung.
                console.error('[GEMINI NETWORK]', safeError(networkError));
                advanceGeminiTarget();
                continue;
            }

            if (res.ok && !data.error) {
                return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ||
                    'Model tidak mengembalikan jawaban.';
            }

            if (isQuotaOrRateLimitError(res.status, data)) {
                // Jangan kirim detail API/429 ke Telegram.
                advanceGeminiTarget();

                // Hanya tampilkan tiga pesan failover ketika benar-benar pindah
                // karena kuota/rate-limit.
                await sendFailoverSequence(chatId, sourceMessageId);
                continue;
            }

            // 503: jangan bocorkan error mentah; pindah target setelah jeda singkat.
            if (res.status === 503) {
                await sleep(randomMs(500, 1200));
                advanceGeminiTarget();
                continue;
            }

            // Error konfigurasi/model tidak boleh masuk ke Telegram sebagai raw API error.
            console.error(`[GEMINI ${res.status}]`, safeError(data));
            throw new Error('Gemini sedang mengalami gangguan sementara.');
        }

        await sleep(randomMs(1000, 2500));
    }

    throw new Error('Semua jalur Gemini sedang sibuk. Silakan kirim ulang sebentar lagi.');
}

async function askAI(chatId, finalPrompt, base64Media, mimeTypeMedia, sourceMessageId) {
    if (!activeProvider) {
        throw new Error('Provider AI belum diaktifkan.');
    }

    if (activeProvider === 'GEMINI') {
        return askGemini(chatId, finalPrompt, base64Media, mimeTypeMedia, sourceMessageId);
    }

    if (activeProvider === 'OPENAI') {
        return askOpenAI(chatId, finalPrompt, base64Media, mimeTypeMedia);
    }

    throw new Error('Provider AI tidak dikenal.');
}

async function processAIMessage(msg, finalPrompt, base64Media, mimeTypeMedia) {
    const chatId = String(msg.chat.id);

    if (!activeProvider) {
        await sendReply(
            bot,
            msg.chat.id,
            '⚙️ Otak AI belum dipilih. Aktifkan Gemini atau GPT dari panel kontrol dulu.'
        );
        return;
    }

    const stopRecordingPresence = startRecordingPresence(chatId);

    try {
        const response = await askAI(
            chatId,
            finalPrompt,
            base64Media,
            mimeTypeMedia,
            msg.message_id
        );

        const rawResponse = cleanText(response) || '😭 AI nggak menghasilkan jawaban kali ini.';

        pushHistory(chatId, 'user', finalPrompt);
        pushHistory(chatId, 'assistant', rawResponse);

        await sendReply(bot, msg.chat.id, rawResponse, {
            reply_to_message_id: msg.message_id
        });
    } catch (error) {
        console.error('[AI CORE ERROR]', safeError(error));

        // Tidak pernah mengirim detail error API/token/limit ke Telegram.
        await sendReply(
            bot,
            msg.chat.id,
            '😵 Server AI lagi penuh sebentar. Coba kirim lagi ya.',
            { reply_to_message_id: msg.message_id }
        );
    } finally {
        stopRecordingPresence();
    }
}

bot.on('callback_query', async (query) => {
    const data = String(query.data || '');
    const chatId = String(query.message?.chat?.id || '');

    try {
        await bot.answerCallbackQuery(query.id);

        if (!chatId || !data.startsWith('ask|')) return;

        const action = data.slice(4).trim();
        if (!action) return;

        const finalPrompt =
            `[INFO SISTEM: Pengguna menekan tombol interaktif.]\n` +
            `[INFO SISTEM: Tombol tersebut berisi instruksi yang harus diproses sebagai pesan pengguna.]\n` +
            `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB.]\n\n` +
            `Permintaan pengguna dari tombol:\n${action}`;

        await processAIMessage(
            query.message,
            finalPrompt,
            null,
            null
        );
    } catch (error) {
        console.error('[CALLBACK ERROR]', safeError(error));
        if (chatId) {
            try {
                await sendReply(bot, chatId, '😵 Server AI lagi penuh sebentar. Coba lagi.');
            } catch {}
        }
    }
});

bot.on('message', async (msg) => {
    const text = cleanText(msg.text || msg.caption || '');

    if (!text && !getMediaFromMessage(msg)) return;
    if (isCommand(text)) return;

    const chatId = String(msg.chat.id);

    if (aiMutedChats.has(chatId)) return;
    if (msg.date && Math.floor(Date.now() / 1000) - msg.date > 120) return;

    try {
        const mediaResult = await buildMediaPrompt(
            msg,
            text || '[Sistem: Pengguna mengirim media tanpa caption.]'
        );

        const currentTimeInstruction = `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB.]`;
        const finalPrompt =
            `${currentTimeInstruction}\n\n${mediaResult.finalPrompt}`;

        await processAIMessage(
            msg,
            finalPrompt,
            mediaResult.base64Media,
            mediaResult.mimeTypeMedia
        );
    } catch (error) {
        console.error('[MESSAGE ERROR]', safeError(error));
        try {
            await sendReply(bot, msg.chat.id, '😵 Server AI lagi penuh sebentar. Coba kirim lagi ya.', {
                reply_to_message_id: msg.message_id
            });
        } catch {}
    }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Public config hanya berisi email + model. API key TIDAK PERNAH dikirim ke browser.
app.get('/public-config', (req, res) => {
    res.json({
        ok: true,
        provider: activeProvider,
        gemini: {
            accounts: secretConfig.geminiAccounts.map(a => ({ email: a.email })),
            models: [...GEMINI_MODELS],
            currentAccountIndex: geminiAccountIndex,
            currentModelIndex: geminiModelIndex
        },
        openai: {
            accounts: (secretConfig.openaiAccounts || []).map(a => ({ email: a.email })),
            model: OPENAI_MODEL
        }
    });
});

// Aktivasi provider dari panel HTML.
// Setelah sekali dipilih, state tersimpan dan otomatis aktif lagi setelah restart.
app.post('/activate-provider', (req, res) => {
    const provider = String(req.body?.provider || '').toUpperCase();

    if (!['GEMINI', 'OPENAI'].includes(provider)) {
        return res.status(400).json({ ok: false, error: 'Provider tidak valid.' });
    }

    if (provider === 'GEMINI' && !secretConfig.geminiAccounts?.length) {
        return res.status(500).json({ ok: false, error: 'Gemini server-side config kosong.' });
    }

    if (provider === 'OPENAI' && !secretConfig.openaiAccounts?.[0]?.key) {
        return res.status(500).json({ ok: false, error: 'OpenAI server-side config kosong.' });
    }

    activeProvider = provider;
    saveDb();

    res.json({
        ok: true,
        provider: activeProvider,
        model: provider === 'GEMINI'
            ? GEMINI_MODELS[geminiModelIndex]
            : OPENAI_MODEL
    });
});

// Kompatibilitas dengan panel lama: API key dari browser sengaja diabaikan.
app.post('/deploy-key', (req, res) => {
    const provider = String(req.body?.provider || '').toUpperCase();

    if (!['GEMINI', 'OPENAI'].includes(provider)) {
        return res.status(400).json({ ok: false, error: 'Provider tidak valid.' });
    }

    activeProvider = provider;
    saveDb();

    res.json({
        success: true,
        provider: activeProvider,
        message: 'Provider aktif. API key tetap disimpan server-side.'
    });
});

app.get('/', (req, res) => {
    const target = activeProvider === 'GEMINI' ? currentGeminiTarget() : null;

    res.json({
        ok: true,
        service: 'VGen AI Telegram Bot',
        provider: activeProvider,
        model: target?.model || (activeProvider === 'OPENAI' ? OPENAI_MODEL : null),
        timeWIB: nowWIB()
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ VGEN AI TELEGRAM ONLINE di port ${PORT}`);
    console.log(`🤖 Provider saat startup: ${activeProvider || 'BELUM DIAKTIFKAN'}`);
    if (activeProvider === 'GEMINI') {
        const t = currentGeminiTarget();
        console.log(`🔄 Gemini failover: ${t.email} / ${t.model}`);
    }
});
