/**
 * VGEN AI - TELEGRAM BOT EDITION
 * Menggantikan engine WhatsApp/Baileys dengan Telegram Bot API.
 * Node.js 22+.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================
// FIX RAILWAY CRASH (ANTI LOG SPAM)
// Mencegah Node.js memuntahkan object TCP/Tunnel raksasa ke console
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
} catch {
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
    for (const chunk of splitForTelegram(text)) {
        await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML', ...extra });
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

// (Cari ide keren & bahas game udah diapus dari sini karena ditaruh fix di atas)
const START_BUTTON_POOL = [
    { text: '🧠 Jelasin sesuatu', callback_data: 'ask|jelasin satu hal menarik hari ini' },
    { text: '😂 Bikin aku ketawa', callback_data: 'ask|bikin aku ketawa dengan jokes singkat' },
    { text: '💡 Fakta random', callback_data: 'ask|kasih satu fakta random yang menarik' },
    { text: '⚽ Bahas bola', callback_data: 'ask|bahas sepak bola yang menarik' },
    { text: '🎵 Rekomendasi musik', callback_data: 'ask|rekomendasikan musik berdasarkan mood' },
    { text: '📱 Trik hp', callback_data: 'ask|kasih trik hp android yang berguna' },
    { text: '💻 Tips coding', callback_data: 'ask|kasih tips coding yang praktis' },
    { text: '🤖 Ngobrol ai', callback_data: 'ask|jelasin sesuatu yang menarik tentang ai' },
    { text: '🌍 Fakta dunia', callback_data: 'ask|kasih fakta unik tentang dunia' },
    { text: '🧪 Sains simpel', callback_data: 'ask|jelasin satu fakta sains dengan bahasa gampang' },
    { text: '🧩 Teka-teki', callback_data: 'ask|kasih aku teka-teki singkat' },
    { text: '📝 Bantu nulis', callback_data: 'ask|kasih ide tulisan yang menarik' },
    { text: '💰 Tips hemat', callback_data: 'ask|kasih tips hemat yang realistis' },
    { text: '🎯 Jadi produktif', callback_data: 'ask|kasih cara simpel supaya lebih produktif' },
    { text: '📚 Belajar cepat', callback_data: 'ask|ajarin aku satu hal berguna' },
    { text: '🌌 Fakta luar angkasa', callback_data: 'ask|kasih fakta luar angkasa yang bikin wow' },
    { text: '🍜 Ide makanan', callback_data: 'ask|rekomendasikan makanan simpel yang enak' },
    { text: '🎲 Pilihkan aku', callback_data: 'ask|pilihkan topik random yang seru' }
];

function randomStartButtons() {
    return [...START_BUTTON_POOL].sort(() => Math.random() - 0.5).slice(0, 2);
}

bot.onText(/^\/(start|help)(?:@\w+)?$/i, async (msg) => {
    const text =
        `<b>Vgen ai</b> ✨\n\n` +
        `Teman ai yang siap nemenin lu kapan aja. 😎\n\n` +
        `Mau ngobrol, cari ide, belajar, coding, bahas bola, ` +
        `atau sekadar random juga gas.\n\n` +
        `<b>Temukan juga vgen ai di sini 👇</b>`;

    const keyboard = [
        // FIX BUTTON LANGSUNG MUNCUL DI ATAS UNTUK BOCAH
        [
            { text: '💎AM Prem 1th', url: 'https://t.me/vickyyvall' },
            { text: '🛒 Upgrade AI', callback_data: 'ask|Keanggotaan: Saya mau Upgrade AI biar limit harian jadi 50/hari. Tolong jelaskan manfaatnya, sistem limit, dan harganya (25K).' }
        ],
        [
            { text: '🎵 Tiktok @vickyyvall', url: 'https://www.tiktok.com/@vickyyvall' }
        ],
        [
            { text: '🎮 Roblox @aa_vickyyy', url: 'https://www.roblox.com/id/users/8881321052/profile' }
        ],
        [
            { text: '📸 Instagram @vickyhx013_', url: 'https://www.instagram.com/vickyhx013_' }
        ],
        randomStartButtons()
    ];

    // CARA GAMPANG PAKE GAMBAR TANPA FOLDER ASSET:
    // Taro link gambar online lu di dalem tanda kutip di bawah ini!
    // Contoh: 'https://i.imgur.com/xxxxx.png' 
    const START_IMAGE_URL = ''; 

    if (START_IMAGE_URL) {
        try {
            await bot.sendPhoto(msg.chat.id, START_IMAGE_URL, {
                caption: text,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        } catch (e) {
            console.error('[GAMBAR START ERROR]', e.message);
            // Kalau gambarnya gagal (link rusak/kosong), otomatis kirim teks aja
        }
    }

    // Fallback teks doang
    await sendReply(bot, msg.chat.id, text, {
        reply_markup: { inline_keyboard: keyboard }
    });
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

    const folder = path.join(__dirname, 'riwayat_media');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const safeName = media.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const archiveName = `${Date.now()}_${safeName}`;
    try {
        fs.writeFileSync(path.join(folder, archiveName), downloaded.buffer);
    } catch (e) {}

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

        if (media.mimeType === 'application/octet-stream' || /\.(apk|bin|dat|exe|7z|rar|zip)$/i.test(lower)) {
            return {
                finalPrompt: `[Sistem: Pengguna mengirim file "${media.fileName}". Jelaskan dengan jujur bahwa format biner ini tidak dibaca sebagai isi dokumen oleh bot.]\n\n${basePrompt}`,
                base64Media: null,
                mimeTypeMedia: null
            };
        }

        return {
            finalPrompt: `[Sistem: Pengguna mengirim lampiran dokumen "${media.fileName}". Analisa jika formatnya dapat dipahami oleh model.]\n\n${basePrompt}`,
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
            { role: 'system', content: vgenPrompt },
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

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent?key=${encodeURIComponent(activeApiKey)}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_instruction: { parts: [{ text: vgenPrompt }] }, contents })
        });

        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error?.message || `Gemini HTTP ${res.status}`);
        return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || 'Model tidak mengembalikan jawaban.';
    }

    throw new Error(`Provider tidak dikenal: ${activeProvider}`);
}

// ============================================================
// CALLBACK BUTTON ENGINE
// ============================================================
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

        // FIX "your selected"
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

        let rawResponse = cleanText(response);

        // FIX BUG GAMBAR: NANGKAP TAG GAMBAR DARI AI BIAR GA JADI TEXT HTTPS
        let imageToSent = null;
        const imageRegex = /\[IMAGE:\s*(https?:\/\/[^\s\]]+)\s*\]/is;
        const imgMatch = rawResponse.match(imageRegex);
        if (imgMatch) {
            imageToSent = imgMatch[1];
            rawResponse = rawResponse.replace(imageRegex, '').trim();
        }

        // HAPUS BUTTONS DARI CALLBACK (Gak boleh bikin button di dalem callback)
        const buttonRegex = /\[BUTTONS:\s*(\[.*?\])\s*\]/is;
        rawResponse = rawResponse.replace(buttonRegex, '').trim();

        if (!rawResponse) rawResponse = '😭 AI nggak menghasilkan jawaban kali ini.';

        pushHistory(chatId, 'user', finalPrompt);
        pushHistory(chatId, 'assistant', rawResponse);

        // KIRIM FOTO DULU KALAU ADA, BARU TEXT
        let extraOptions = { reply_to_message_id: query.message?.message_id };
        if (imageToSent) {
            try {
                await bot.sendPhoto(chatId, imageToSent);
            } catch (e) {
                console.error('[GAMBAR CALLBACK GAGAL]', e.message);
            }
        }
        await sendReply(bot, chatId, rawResponse, extraOptions);

    } catch (error) {
        if (chatId) {
            try { await sendReply(bot, chatId, '😭 Waduh tombolnya kepencet tapi AI lagi ngadat. Coba pencet lagi atau kirim pertanyaannya langsung.'); } catch {}
        }
    }
});

bot.on('message', async (msg) => {
    const text = cleanText(msg.text || msg.caption || '');
    if (!text && !getMediaFromMessage(msg)) return;
    if (isCommand(text)) return;

    const chatId = String(msg.chat.id);
    const sender = displayName(msg);
    const type = msg.photo ? 'photo' : msg.document ? 'document' : 'text';

    if (aiMutedChats.has(chatId)) return;
    if (msg.date && Math.floor(Date.now() / 1000) - msg.date > 120) return;

    try {
        const stopRecordingPresence = startRecordingPresence(chatId);

        let response;
        try {
            const mediaResult = await buildMediaPrompt(msg, text || '[Sistem: Pengguna mengirim media tanpa caption.]');
            const currentTimeInstruction = `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB. Jika pengguna bertanya waktu saat ini, gunakan waktu ini.]`;
            const finalPrompt = `${currentTimeInstruction}\n\n${mediaResult.finalPrompt}`;
            response = await askAI(chatId, finalPrompt, mediaResult.base64Media, mediaResult.mimeTypeMedia);
        } finally {
            stopRecordingPresence();
        }

        let rawResponse = cleanText(response);
        if (aiMutedChats.has(chatId)) return;

        // FIX BUG GAMBAR: NANGKAP TAG GAMBAR DARI AI BIAR GA JADI TEXT HTTPS
        let imageToSent = null;
        const imageRegex = /\[IMAGE:\s*(https?:\/\/[^\s\]]+)\s*\]/is;
        const imgMatch = rawResponse.match(imageRegex);
        if (imgMatch) {
            imageToSent = imgMatch[1];
            rawResponse = rawResponse.replace(imageRegex, '').trim();
        }

        // ==========================================================
        // 🔥 VGEN CORE: DYNAMIC AI BUTTON PARSER 🔥
        // ==========================================================
        let inline_keyboard = [];
        const buttonRegex = /\[BUTTONS:\s*(\[.*?\])\s*\]/is;
        const match = rawResponse.match(buttonRegex);

        if (match) {
            try {
                const aiButtons = JSON.parse(match[1]);
                const validButtons = [];
                if (Array.isArray(aiButtons)) {
                    for (const original of aiButtons) {
                        if (!original || typeof original !== 'object') continue;
                        const text = String(original.text || '').trim();
                        const url = String(original.url || '').trim();
                        const callbackData = String(original.callback_data || '').trim();

                        if (!text) continue;
                        if (callbackData && callbackData.startsWith('ask|') && Buffer.byteLength(callbackData, 'utf8') <= 64) {
                            validButtons.push({ text, callback_data: callbackData });
                            continue;
                        }
                        if (url && /^https?:\/\/\S+$/i.test(url)) {
                            let finalUrl = url;
                            if (finalUrl.includes('t.me/vickyyvall')) {
                                finalUrl = finalUrl.replace(/(text=)([^&]+)/i, (full, prefix, value) => {
                                    let decoded = value;
                                    try { decoded = decodeURIComponent(value); } catch {}
                                    return (prefix + encodeURIComponent(decoded.toLowerCase()));
                                });
                            }
                            validButtons.push({ text, url: finalUrl });
                        }
                        if (validButtons.length >= 2) break;
                    }
                }

                if (validButtons.length > 0) {
                    const roll = Math.random();
                    if (roll < 0.10) {
                        inline_keyboard = [];
                    } else if (roll < 0.55) {
                        const randomButton = validButtons[Math.floor(Math.random() * validButtons.length)];
                        inline_keyboard = [[randomButton]];
                    } else {
                        inline_keyboard = [validButtons.sort(() => Math.random() - 0.5).slice(0, 2)];
                    }
                }
                rawResponse = rawResponse.replace(buttonRegex, '').trim();
            } catch (error) {
                console.error('[BUTTON PARSER ERROR]', error.message);
                rawResponse = rawResponse.replace(buttonRegex, '').trim();
                inline_keyboard = [];
            }
        }

        pushHistory(chatId, 'user', text || '[Media]');
        pushHistory(chatId, 'assistant', rawResponse);

        let extraOptions = { reply_to_message_id: msg.message_id };
        if (inline_keyboard.length > 0) {
            extraOptions.reply_markup = { inline_keyboard };
        }

        // KIRIM FOTO DULU KALAU ADA TAG GAMBAR
        if (imageToSent) {
            try {
                await bot.sendPhoto(chatId, imageToSent);
            } catch (e) {
                console.error('[GAMBAR CHAT GAGAL]', e.message);
            }
        }

        // BARU KIRIM BALASAN TEKS / TOMBOL
        await sendReply(bot, msg.chat.id, rawResponse, extraOptions);

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
