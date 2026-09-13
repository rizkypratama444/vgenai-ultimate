/**
 * VGEN AI - TELEGRAM BOT EDITION
 * Engine Telegram Bot API + Fix HTML Parser & Formatting Security
 * Node.js 22+.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================
// FIX RAILWAY CRASH (ANTI LOG SPAM)
// ============================================================
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err ? (err.message || err) : 'Unknown Error');
});

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason ? (reason.message || reason) : 'Unknown Rejection');
});

let vgenPrompt = '';
try {
    vgenPrompt = require('./prompt.js');
} catch (e) {
    vgenPrompt = 'Kamu adalah VGen AI, asisten yang cerdas dan efisien.';
}

// ============================================================
// KONFIGURASI
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'PASTE_BOT_TOKEN_DI_SINI';
const PORT = process.env.PORT || 8080;
const MAX_HISTORY = 15;
const MAX_TEXT_FILE = 5000;

if (TELEGRAM_BOT_TOKEN === 'PASTE_BOT_TOKEN_DI_SINI') {
    console.error('❌ TELEGRAM_BOT_TOKEN belum diisi. Set environment variable TELEGRAM_BOT_TOKEN.');
    process.exit(1);
}

// ============================================================
// DATABASE API CONFIG
// ============================================================
const dbFile = path.join(__dirname, 'database.json');
let db = { apiConfig: {} };

if (fs.existsSync(dbFile)) {
    try {
        db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (e) {
        console.error('❌ Gagal membaca database.json:', e.message);
    }
}

function saveDb() {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

let activeProvider = db.apiConfig?.provider || null;
let activeApiKey = db.apiConfig?.apiKey || null;
let activeModel = db.apiConfig?.model || null;
let activeBaseUrl = db.apiConfig?.baseUrl || null;

// Memori per chat Telegram.
const userHistory = new Map();
const aiMutedChats = new Set();

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

function displayName(msg) {
    const u = msg.from || {};
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Telegram User';
}

function isCommand(text) {
    return /^\/(?:start|help|mute|unmute|status|reset)(?:@\w+)?(?:\s|$)/i.test(text);
}

// ============================================================
// AUTO CONVERT MARKDOWN TO TELEGRAM HTML & SANITIZER
// ============================================================
function convertMarkdownToHTML(text) {
    if (!text) return '';
    let formatted = String(text);

    // Ubah *teks* menjadi <b>teks</b> jika AI lupa pake HTML
    formatted = formatted.replace(/\*([^*]+)\*/g, '<b>$1</b>');

    // Ubah ```kode``` menjadi <pre><code>kode</code></pre>
    formatted = formatted.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Ubah `kode` menjadi <code>kode</code>
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Rapikan bullet point liar
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
    if (!text) return; // Kalo kosong jangan dikirim
    const htmlText = convertMarkdownToHTML(text);
    for (const chunk of splitForTelegram(htmlText)) {
        try {
            await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML', ...extra });
        } catch (e) {
            // Fallback otomatis ke Text Biasa jika HTML parsing crash
            console.error('[SEND REPLY HTML ERROR, FALLBACK TO PLAIN TEXT]', e.message);
            const plainText = chunk.replace(/<[^>]*>?/gm, '');
            await bot.sendMessage(chatId, plainText, { ...extra, parse_mode: undefined });
        }
    }
}

// ============================================================
// LONG-RUNNING TELEGRAM "RECORDING" PRESENCE
// ============================================================
function startRecordingPresence(chatId) {
    let stopped = false;
    const sendPresence = async () => {
        if (stopped) return;
        try {
            await bot.sendChatAction(chatId, 'record_voice');
        } catch (e) {}
    };
    sendPresence();
    const timer = setInterval(sendPresence, 4000);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

// ============================================================
// TELEGRAM BOT
// ============================================================
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (err) => console.error('[TELEGRAM POLLING ERROR]', err ? (err.message || err.code || 'Unknown Error') : 'Unknown'));
bot.on('webhook_error', (err) => console.error('[TELEGRAM WEBHOOK ERROR]', err ? (err.message || err.code || 'Unknown Error') : 'Unknown'));

// ============================================================
// PREMIUM START MENU
// ============================================================
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
        `<b>VGen AI Multifungsi</b> 🏴󠁧󠁢󠁥󠁮󠁧󠁿\n\n` +
        `Teman AI yang siap nemenin lu kapan aja. 😎\n\n` +
        `Mau ngobrol, cari ide, belajar, coding, bahas bola, ` +
        `atau sekadar random juga gas.\n\n` +
        `<b>Temukan juga VGen AI di sini 👇</b>`;

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

    const mediaUrl = 'https://ibb.co.com/s9tq563Y';

    try {
        await bot.sendPhoto(msg.chat.id, mediaUrl, {
            caption: text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (error) {
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
    await sendReply(bot, msg.chat.id,
        `Status VGen AI\n` +
        `Provider: ${activeProvider || 'BELUM DISET'}\n` +
        `Model: ${activeModel || 'BELUM DISET'}\n` +
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
        console.error('[MEDIA DOWNLOAD]', e.message);
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
    if (!media) return { finalPrompt: basePrompt, base64Media: null, mimeTypeMedia: null };

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
        const readable = media.mimeType.includes('text') ||
            media.mimeType.includes('json') ||
            media.mimeType.includes('javascript') ||
            /\.(js|json|txt|csv|html|css|py|md)$/i.test(lower);

        if (readable) {
            const text = downloaded.buffer.toString('utf8').slice(0, MAX_TEXT_FILE);
            return {
                finalPrompt: `[Sistem: Pengguna mengirim dokumen "${media.fileName}"]\nIsi Dokumen:\n\`\`\`\n${text}\n\`\`\`\n\nPesan: ${basePrompt}`,
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

async function askAI(chatId, finalPrompt, base64Media, mimeTypeMedia) {
    if (!activeApiKey || !activeModel || !activeProvider) {
        throw new Error('Provider/API key/model belum dikonfigurasi.');
    }

    const history = historyFor(chatId);

    if (activeProvider === 'OPENAI') {
        let userContent = finalPrompt;
        if (base64Media) {
            userContent = [
                { type: 'text', text: finalPrompt },
                { type: 'image_url', image_url: { url: `data:${mimeTypeMedia || 'image/jpeg'};base64,${base64Media}` } }
            ];
        }

        const messages = [
            { role: 'system', content: typeof vgenPrompt === 'string' ? vgenPrompt : JSON.stringify(vgenPrompt) },
            ...history,
            { role: 'user', content: userContent }
        ];

        const endpoint = activeBaseUrl || 'https://api.openai.com/v1/chat/completions';
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${activeApiKey}` },
            body: JSON.stringify({ model: activeModel, messages })
        });

        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
        return data.choices?.[0]?.message?.content || 'Model tidak mengembalikan jawaban.';
    }

    if (activeProvider === 'GEMINI') {
        const contents = history.map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
        }));

        const parts = [{ text: finalPrompt }];
        if (base64Media) {
            parts.push({ inline_data: { mime_type: mimeTypeMedia || 'image/jpeg', data: base64Media } });
        }
        contents.push({ role: 'user', parts });

        const systemInstructionText = typeof vgenPrompt === 'string' ? vgenPrompt : JSON.stringify(vgenPrompt);
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent?key=${encodeURIComponent(activeApiKey)}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_instruction: { parts: [{ text: systemInstructionText }] }, contents })
        });

        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error?.message || `Gemini HTTP ${res.status}`);
        return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || 'Model tidak mengembalikan jawaban.';
    }

    throw new Error(`Provider tidak dikenal: ${activeProvider}`);
}

// ============================================================
// CORE MESSAGE & CALLBACK PARSER
// ============================================================
async function processAIResponse(chatId, rawResponse, replyToId) {
    let text = String(rawResponse || '').trim();

    // HAPUS SPAM INFO SISTEM KALO AI NYA BOCOR
    text = text.replace(/\[INFO SISTEM:.*?\]/gi, '').trim();

    // 1. EXTRACT IMAGE (NEW SAFE SYNTAX <<<IMAGE: ...>>>)
    let imageToSent = null;
    const imageRegex = /<<<IMAGE:\s*(https?:\/\/[^\s>]+)\s*>>>/is;
    const imgMatch = text.match(imageRegex);
    if (imgMatch) {
        imageToSent = imgMatch[1];
        text = text.replace(imageRegex, '').trim();
    }

    // 2. EXTRACT FILE (NEW SAFE SYNTAX <<<FILE: filename.ext|content>>>)
    let fileToSend = null;
    const fileRegex = /<<<FILE:\s*([^|]+)\|([\s\S]*?)>>>/is;
    const fileMatch = text.match(fileRegex);
    if (fileMatch) {
        fileToSend = {
            name: fileMatch[1].trim(),
            content: fileMatch[2].trim()
        };
        text = text.replace(fileRegex, '').trim();
    }

    // 3. EXTRACT BUTTONS (NEW SAFE SYNTAX <<<BUTTONS: [...]>>>)
    let inline_keyboard = [];
    const buttonRegex = /<<<BUTTONS:\s*(\[.*?\])\s*>>>/is;
    const btnMatch = text.match(buttonRegex);
    if (btnMatch) {
        try {
            const aiButtons = JSON.parse(btnMatch[1]);
            const validButtons = [];
            if (Array.isArray(aiButtons)) {
                for (const original of aiButtons) {
                    if (!original || typeof original !== 'object') continue;
                    const btnText = String(original.text || '').trim();
                    const url = String(original.url || '').trim();
                    const callbackData = String(original.callback_data || '').trim();

                    if (!btnText) continue;
                    if (callbackData && callbackData.startsWith('ask|')) {
                        let safeCallback = callbackData;
                        if (Buffer.byteLength(safeCallback, 'utf8') > 64) {
                            safeCallback = Buffer.from(safeCallback, 'utf8').subarray(0, 64).toString('utf8');
                        }
                        validButtons.push({ text: btnText, callback_data: safeCallback });
                        continue;
                    }
                    if (url && /^https?:\/\/\S+$/i.test(url)) {
                        validButtons.push({ text: btnText, url });
                    }
                    if (validButtons.length >= 2) break;
                }
            }
            if (validButtons.length > 0) {
                inline_keyboard = [validButtons.slice(0, 2)];
            }
        } catch (error) {
            console.error('[BUTTON PARSER ERROR]', error.message);
        }
        text = text.replace(buttonRegex, '').trim();
    }

    if (!text && !imageToSent && !fileToSend) {
        text = '😭 AI nggak menghasilkan jawaban kali ini.';
    }

    // Kirim Media
    if (imageToSent) {
        try {
            await bot.sendPhoto(chatId, imageToSent);
        } catch (e) {
            console.error('[GAMBAR CHAT GAGAL]', e.message);
        }
    }

    if (fileToSend) {
        try {
            const fileBuffer = Buffer.from(fileToSend.content, 'utf8');
            await bot.sendDocument(chatId, fileBuffer, {}, { filename: fileToSend.name, contentType: 'text/plain' });
        } catch (e) {
            console.error('[FILE SEND ERROR]', e.message);
        }
    }

    // Kirim Teks + Tombol
    let extraOptions = { reply_to_message_id: replyToId };
    if (inline_keyboard.length > 0) {
        extraOptions.reply_markup = { inline_keyboard };
    }

    await sendReply(bot, chatId, text, extraOptions);
    return text;
}

// ============================================================
// CALLBACK BUTTON ENGINE
// ============================================================
bot.on('callback_query', async (query) => {
    const data = String(query.data || '');
    const chatId = String(query.message?.chat?.id || '');

    try {
        if (!chatId || !data.startsWith('ask|')) {
            await bot.answerCallbackQuery(query.id);
            return;
        }

        const action = data.slice(4).trim();
        if (!action) {
            await bot.answerCallbackQuery(query.id);
            return;
        }
        
        // MUNCULIN NOTIFIKASI BORDER DI ATAS PAS BUTTON DIKLIK (TOAST)
        await bot.answerCallbackQuery(query.id, { 
            text: `Lagi diproses bentar ngab: ${action}...`, 
            show_alert: false // false = muncul border toast di atas, true = popup di tengah layar
        });
        
        const finalPrompt =
            `[INFO SISTEM: Pengguna menekan tombol interaktif.]\n` +
            `[INFO SISTEM: Tombol tersebut berisi instruksi yang harus diproses sebagai pesan pengguna.]\n` +
            `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB.]\n\n` +
            `Permintaan pengguna dari tombol:\n${action}`;

        await sendReply(
            bot,
            chatId,
            `<i>your selected:</i> ${action.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`,
            { reply_to_message_id: query.message?.message_id }
        );

        const stopRecordingPresence = startRecordingPresence(chatId);
        let response;
        try {
            response = await askAI(chatId, finalPrompt, null, null);
        } finally {
            stopRecordingPresence();
        }

        const finalSavedText = await processAIResponse(chatId, response, query.message?.message_id);
        
        pushHistory(chatId, 'user', finalPrompt);
        pushHistory(chatId, 'assistant', finalSavedText);

    } catch (error) {
        if (chatId) {
            try { await sendReply(bot, chatId, '😭 Waduh tombolnya kepencet tapi AI lagi ngadat. Coba pencet lagi atau kirim pertanyaannya langsung.'); } catch {}
        }
    }
});

// ============================================================
// CHAT LISTENER
// ============================================================
bot.on('message', async (msg) => {
    const text = cleanText(msg.text || msg.caption || '');
    if (!text && !getMediaFromMessage(msg)) return;
    if (isCommand(text)) return;

    const chatId = String(msg.chat.id);
    if (aiMutedChats.has(chatId)) return;
    if (msg.date && Math.floor(Date.now() / 1000) - msg.date > 120) return;

    try {
        const stopRecordingPresence = startRecordingPresence(chatId);

        let response;
        try {
            const mediaResult = await buildMediaPrompt(msg, text || '[Sistem: Pengguna mengirim media tanpa caption.]');
            const currentTimeInstruction = `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB.]`;
            const finalPrompt = `${currentTimeInstruction}\n\n${mediaResult.finalPrompt}`;
            response = await askAI(chatId, finalPrompt, mediaResult.base64Media, mediaResult.mimeTypeMedia);
        } finally {
            stopRecordingPresence();
        }

        if (aiMutedChats.has(chatId)) return;

        const finalSavedText = await processAIResponse(chatId, response, msg.message_id);

        pushHistory(chatId, 'user', text || '[Media]');
        pushHistory(chatId, 'assistant', finalSavedText);

    } catch (error) {
        const realError = String(error.message || error).replace(/\n/g, ' ').slice(0, 500);
        console.error('[AI CORE ERROR]', realError);
        await sendReply(bot, msg.chat.id, `VGen Engine terkendala.\n\nDetail: ${realError}`);
    }
});

// ============================================================
// EXPRESS DEPLOYMENT API
// ============================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
    res.json({ ok: true, service: 'VGen AI Telegram Bot', provider: activeProvider, model: activeModel, timeWIB: nowWIB() });
});

app.post('/deploy-key', (req, res) => {
    const { apiKey, provider, model, baseUrl } = req.body || {};
    if (!apiKey || !model) {
        return res.status(400).json({ error: 'API Key atau Model tidak boleh kosong!' });
    }
    activeApiKey = apiKey;
    activeProvider = String(provider || 'OPENAI').toUpperCase();
    activeModel = model;
    activeBaseUrl = baseUrl || null;

    db.apiConfig = { apiKey: activeApiKey, provider: activeProvider, model: activeModel, ...(activeBaseUrl ? { baseUrl: activeBaseUrl } : {}) };
    saveDb();
    res.json({ success: true, message: `Sukses terhubung ke model: ${activeModel}` });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ VGEN AI TELEGRAM ONLINE di port ${PORT}`);
});
