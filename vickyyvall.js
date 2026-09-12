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
const MAX_GENERATED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GENERATED_ZIP_BYTES = 20 * 1024 * 1024;

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
    return normalizeChatOutput(String(value || ''));
}

function normalizeChatOutput(value) {
    let text = String(value || '');

    // Sapu bersih artefak tag & kurung siku bocor
    text = text.replace(/\[\/?BUTTONS\]/gi, '');
    text = text.replace(/^\s*\]\s*$/gm, '');
    text = text.replace(/(^|\n)\s*\]\s*(?=\n|$)/g, '$1');
    text = text.replace(/\]\s*$/g, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    const paragraphs = text.split(/\n\n+/);
    const protectedList = ['Alight Motion Premium', 'AM Prem', 'TikTok', 'Instagram', 'Telegram', 'Persija', 'VGen AI', 'vickyyvall', 'JavaScript', 'Node.js', 'HTML', 'CSS', 'JSON', 'Python', 'Roblox', 'YouTube'];

    const fixParagraph = (paragraph) => {
        let out = paragraph.trim();
        if (!out) return '';

        const saved = [];
        out = out.replace(new RegExp(protectedList.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), (match) => {
            const token = `__VGENPROTECT${saved.length}__`;
            saved.push(match);
            return token;
        });

        out = out.replace(/([.!?])([ \t]+)([A-ZÀ-Ý])(?=[a-zà-ÿ])/g, (m, punct, space, ch) => punct + space + ch.toLowerCase());
        out = out.replace(/^([a-zà-ÿ])/, (_, ch) => ch.toUpperCase());

        saved.forEach((word, index) => {
            out = out.replace(`__VGENPROTECT${index}__`, word);
        });
        return out;
    };

    text = paragraphs.map(fixParagraph).filter(Boolean).join('\n\n');
    return text.trim();
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

    // 🟢 TARO LINK MEDIA LU DI SINI 🟢
    // Ganti URL di bawah sama link gambar/GIF lu! (Contoh: https://link-gambar.com/foto.jpg)
    const mediaUrl = 'https://ibb.co.com/s9tq563Y';

    try {
        await bot.sendPhoto(msg.chat.id, mediaUrl, {
            caption: text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard },
            reply_to_message_id: msg.message_id
        });
    } catch (error) {
        await sendReply(bot, msg.chat.id, text, {
            reply_markup: { inline_keyboard: keyboard },
            reply_to_message_id: msg.message_id
        });
    }

});

bot.onText(/^\/mute(?:@\w+)?$/i, async (msg) => {
    aiMutedChats.add(String(msg.chat.id));
    userHistory.delete(String(msg.chat.id));
    await sendReply(bot, msg.chat.id, 'Respon AI dimatikan untuk chat ini. Pakai /unmute kalau mau mengaktifkannya lagi.', { reply_to_message_id: msg.message_id });
});

bot.onText(/^\/unmute(?:@\w+)?$/i, async (msg) => {
    aiMutedChats.delete(String(msg.chat.id));
    await sendReply(bot, msg.chat.id, 'Respon AI diaktifkan lagi.', { reply_to_message_id: msg.message_id });
});

bot.onText(/^\/reset(?:@\w+)?$/i, async (msg) => {
    userHistory.delete(String(msg.chat.id));
    await sendReply(bot, msg.chat.id, 'Memori percakapan chat ini sudah direset.', { reply_to_message_id: msg.message_id });
});

bot.onText(/^\/status(?:@\w+)?$/i, async (msg) => {
    await sendReply(bot, msg.chat.id,
        `Status VGen AI\n` +
        `Provider: ${activeProvider || 'BELUM DISET'}\n` +
        `Model: ${activeModel || 'BELUM DISET'}\n` +
        `Waktu WIB: ${nowWIB()}`,
        { reply_to_message_id: msg.message_id }
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
// DYNAMIC OUTPUT ENGINE: BUTTONS + IMAGE + FILE + ZIP
// ============================================================
function extractTagBlock(text, tagName) {
    const source = String(text || '');
    const open = new RegExp(`\\[${tagName}\\s*:` , 'i');
    const match = source.match(open);
    if (!match) return null;

    const start = match.index;
    const openEnd = start + match[0].length;
    const closeTag = `[/${tagName}]`;
    const closeIndex = source.toLowerCase().indexOf(closeTag.toLowerCase(), openEnd);
    if (closeIndex === -1) return null;

    const header = source.slice(start, openEnd);
    const body = source.slice(openEnd, closeIndex).trim();
    const end = closeIndex + closeTag.length;
    return { start, end, header, body, full: source.slice(start, end) };
}

function sanitizeGeneratedFilename(name, fallback = 'vgen-file.txt') {
    let safe = String(name || fallback).trim();
    safe = safe.replace(/[\\/\0<>:"|?*\x00-\x1F]/g, '_');
    safe = safe.replace(/^\.+/, '').trim();
    if (!safe) safe = fallback;
    if (safe.length > 120) safe = safe.slice(0, 120);
    return safe;
}

function extractQuotedAttribute(header, key) {
    const re = new RegExp(`${key}\\s*=\\s*(["'])(.*?)\\1`, 'i');
    const match = String(header || '').match(re);
    return match ? match[2] : '';
}

function safeCallbackData(data) {
    let text = String(data || '').trim();
    if (!text.startsWith('ask|')) text = 'ask|' + text;
    let buf = Buffer.from(text, 'utf8');
    if (buf.length <= 64) return text;
    // Potong aman di bawah 64 byte tanpa merusak karakter UTF-8
    return buf.subarray(0, 60).toString('utf8').replace(/\uFFFD/g, '');
}

function parseDynamicButtons(rawText) {
    const text = String(rawText || '');
    const start = text.search(/\[BUTTONS\s*:/i);
    if (start === -1) return { text, buttons: [] };

    const opener = text.slice(start).match(/\[BUTTONS\s*:/i)[0];
    let i = start + opener.length;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }

    if (end === -1) {
        return { text: text.replace(/\[BUTTONS\s*:[\s\S]*$/i, '').replace(/\]\s*$/, '').trim(), buttons: [] };
    }

    const payload = text.slice(start + opener.length, end - 1).trim();
    let parsed = [];
    try { parsed = JSON.parse(payload); }
    catch (e) { console.error('[BUTTON PARSER ERROR]', e.message); }

    const validButtons = [];
    if (Array.isArray(parsed)) {
        for (const original of parsed) {
            if (!original || typeof original !== 'object') continue;
            const buttonText = String(original.text || '').trim().replace(/\s+/g, ' ').slice(0, 48);
            const url = String(original.url || '').trim();
            const callbackData = String(original.callback_data || '').trim();
            if (!buttonText || /^💬?\s*lanjut\s*chat!?$/i.test(buttonText)) continue;

            if (callbackData) {
                validButtons.push({ text: buttonText, callback_data: safeCallbackData(callbackData) });
            } else if (url && /^https?:\/\/\S+$/i.test(url)) {
                validButtons.push({ text: buttonText, url });
            }
            if (validButtons.length >= 4) break;
        }
    }

    const cleanedText = (text.slice(0, start) + text.slice(end)).replace(/\]\s*$/, '').trim();
    return { text: cleanedText, buttons: validButtons.slice(0, 4) };
}

function buildFallbackButtons(userText, aiText, { amTopic = false } = {}) {
    const source = `${userText || ''} ${aiText || ''}`.toLowerCase();
    const pool = [];

    if (amTopic) {
        pool.push(
            { text: '💎 Order AM Prem', url: 'https://t.me/vickyyvall' },
            { text: '✨ Fitur AM Prem', callback_data: safeCallbackData('ask|fitur am prem') },
            { text: '🔥 Spill detail', callback_data: safeCallbackData('ask|detail am prem') }
        );
    } else if (/persija|persib|bola|sepak bola|liga/i.test(source)) {
        pool.push(
            { text: '🏆 Bahas bola', callback_data: safeCallbackData('ask|bahas bola lagi') },
            { text: '🔥 Spill detail', callback_data: safeCallbackData('ask|detail bola') },
            { text: '😂 Versi ngakak', callback_data: safeCallbackData('ask|versi meme bola') }
        );
    } else if (/html|css|javascript|node\.js|script|coding|kode|program/i.test(source)) {
        pool.push(
            { text: '🛠️ Revisi kode', callback_data: safeCallbackData('ask|revisi kode') },
            { text: '📦 Bikin ZIP', callback_data: safeCallbackData('ask|buatkan zip project') },
            { text: '💡 Jelasin kode', callback_data: safeCallbackData('ask|penjelasan kode singkat') }
        );
    } else {
        pool.push(
            { text: '👀 Lanjut bahas', callback_data: safeCallbackData('ask|lanjutkan topik') },
            { text: '😂 Bikin ngakak', callback_data: safeCallbackData('ask|respon lucu singkat') },
            { text: '🔥 Versi lain', callback_data: safeCallbackData('ask|sudut pandang lain') }
        );
    }

    const count = Math.min(randomButtonCount(), pool.length);
    return pool.sort(() => Math.random() - 0.5).slice(0, count);
}


async function ensureAIButtons(chatId, userText, aiText, existingButtons, amTopic = false) {
    if (existingButtons.length) return existingButtons.slice(0, 4);

    // Minta model membuat tombol saja. Ini tetap AI-generated, bukan label statis.
    try {
        const buttonPrompt =
            `[SISTEM INTERNAL: Buat rekomendasi tombol Telegram berdasarkan pesan pengguna dan jawaban AI di bawah. ` +
            `Keluarkan HANYA satu tag [BUTTONS: ...], JSON valid, 1-4 tombol, jumlah dibuat natural dan tidak selalu 4. ` +
            `Teks tombol pendek, lucu/santai bila cocok, emoji dipilih sendiri. ` +
            `Gunakan callback_data ask|... untuk respons AI dan url hanya jika URL memang diberikan. ` +
            `JANGAN gunakan label "Lanjut chat". Jangan keluarkan teks lain.]

` +
            `Pesan pengguna: ${userText || '-'}
` +
            `Jawaban AI: ${aiText || '-'}
` +
            (amTopic ? `Topik AM Prem: jika relevan, salah satu tombol harus bisa order ke https://t.me/vickyyvall.
` : '');
        const generated = await askAI(chatId, buttonPrompt, null, null);
        const parsed = parseDynamicButtons(generated);
        if (parsed.buttons.length) return parsed.buttons.slice(0, 4);
    } catch (e) {
        console.error('[AI BUTTON REPAIR]', e.message || e);
    }

    return buildFallbackButtons(userText, aiText, { amTopic });
}

function parseGeneratedFiles(rawText) {
    let text = String(rawText || '');
    const generated = [];

    // ZIP projects first, so their nested [ZIP_FILE] blocks are consumed together.
    let zipMatch;
    while ((zipMatch = extractTagBlock(text, 'ZIP'))) {
        const zipName = sanitizeGeneratedFilename(extractQuotedAttribute(zipMatch.header, 'filename'), 'vgen-project.zip');
        const files = [];
        const inner = zipMatch.body;
        const fileRe = /\[ZIP_FILE\s*:\s*filename\s*=\s*(["'])(.*?)\1\]([\s\S]*?)\[\/ZIP_FILE\]/gi;
        let m;
        while ((m = fileRe.exec(inner)) !== null) {
            const filename = sanitizeGeneratedFilename(m[2], 'file.txt');
            const content = m[3].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
            const buffer = Buffer.from(content, 'utf8');
            if (buffer.length > MAX_GENERATED_FILE_BYTES) continue;
            files.push({ filename, buffer });
        }
        if (files.length > 0) {
            const zipBuffer = createStoredZip(files);
            if (zipBuffer.length <= MAX_GENERATED_ZIP_BYTES) {
                generated.push({ type: 'zip', filename: zipName.endsWith('.zip') ? zipName : `${zipName}.zip`, buffer: zipBuffer });
            }
        }
        text = (text.slice(0, zipMatch.start) + text.slice(zipMatch.end)).trim();
    }

    let fileMatch;
    while ((fileMatch = extractTagBlock(text, 'FILE'))) {
        const filename = sanitizeGeneratedFilename(extractQuotedAttribute(fileMatch.header, 'filename'), 'vgen-file.txt');
        const content = fileMatch.body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        const buffer = Buffer.from(content, 'utf8');
        if (buffer.length <= MAX_GENERATED_FILE_BYTES) {
            generated.push({ type: 'file', filename, buffer });
        }
        text = (text.slice(0, fileMatch.start) + text.slice(fileMatch.end)).trim();
    }

    return { text, files: generated };
}

// CRC-32 untuk ZIP sederhana tanpa dependency tambahan.
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createStoredZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(file.filename.replace(/\\/g, '/'), 'utf8');
        const data = file.buffer;
        const crc = crc32(data);
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        name.copy(local, 30);
        localParts.push(local, data);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);
        centralParts.push(central);

        offset += local.length + data.length;
    }

    const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
    const centralOffset = offset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, ...centralParts, end]);
}

function shouldAutoZipGeneratedFiles(files) {
    if (!Array.isArray(files) || files.length < 2) return false;
    const projectExts = new Set(['.html','.htm','.css','.js','.mjs','.cjs','.ts','.tsx','.jsx','.json','.py','.php','.java','.xml','.yml','.yaml','.md','.txt','.env']);
    return files.every(file => {
        const name = String(file.filename || '').toLowerCase();
        if (name === 'readme' || name.startsWith('readme.')) return true;
        const dot = name.lastIndexOf('.');
        return dot >= 0 && projectExts.has(name.slice(dot));
    });
}

function mimeForFilename(filename) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    const map = {
        html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
        mjs: 'application/javascript', cjs: 'application/javascript', ts: 'text/typescript',
        json: 'application/json', md: 'text/markdown', txt: 'text/plain', py: 'text/x-python',
        xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml', php: 'text/plain',
        java: 'text/plain', env: 'text/plain'
    };
    return map[ext] || 'application/octet-stream';
}

async function sendGeneratedDocuments(chatId, files, extra = {}) {
    if (!Array.isArray(files) || files.length === 0) return;

    let outgoing = files;
    if (shouldAutoZipGeneratedFiles(files)) {
        const zipBuffer = createStoredZip(files);
        if (zipBuffer.length <= MAX_GENERATED_ZIP_BYTES) {
            outgoing = [{
                type: 'zip',
                filename: `vgen-project-${Date.now()}.zip`,
                buffer: zipBuffer,
                bundledFiles: files.map(f => f.filename)
            }];
        }
    }

    for (const file of outgoing) {
        try {
            const caption = String(extra.caption || (file.type === 'zip'
                ? `📦 <b>${file.filename}</b>\nProject ZIP siap. Semua file yang saling berhubungan sudah disatukan di sini.`
                : `📄 <b>${file.filename}</b>\nFile lengkap sudah siap.`));
            const options = { ...extra, caption, parse_mode: 'HTML' };
            await bot.sendDocument(chatId, file.buffer, options, {
                filename: file.filename,
                contentType: file.type === 'zip' ? 'application/zip' : mimeForFilename(file.filename)
            });
        } catch (e) {
            console.error('[SEND GENERATED FILE ERROR]', e.message);
            await sendReply(bot, chatId, `😭 File <b>${file.filename}</b> gagal dikirim. Coba minta ulang file-nya.`, extra);
        }
    }
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

        // Tekan tombol = langsung dianggap sebagai pesan pengguna ke AI.
        await bot.answerCallbackQuery(query.id, { text: '⏳ AI lagi jawab...' });
        await bot.sendChatAction(chatId, 'typing').catch(() => {});

        const finalPrompt =
            `[INFO SISTEM: Pengguna menekan tombol interaktif.]
` +
            `[INFO SISTEM: Isi tombol adalah permintaan pengguna dan HARUS dijawab langsung seperti pesan biasa.]
` +
            `[INFO SISTEM: Jangan menjelaskan bahwa ini berasal dari callback/tombol.]
` +
            `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB.]

` +
            `${action}`;

        const stopRecordingPresence = startRecordingPresence(chatId);
        let response;
        try {
            response = await askAI(chatId, finalPrompt, null, null);
        } finally {
            stopRecordingPresence();
        }

        let rawResponse = cleanText(response);
        let imageToSent = null;
        const imageRegex = /\[IMAGE:\s*(https?:\/\/[^\s\]]+)\s*\]/is;
        const imgMatch = rawResponse.match(imageRegex);
        if (imgMatch) {
            imageToSent = imgMatch[1];
            rawResponse = rawResponse.replace(imageRegex, '').trim();
        }

        const generatedResult = parseGeneratedFiles(rawResponse);
        rawResponse = generatedResult.text;
        const buttonResult = parseDynamicButtons(rawResponse);
        rawResponse = buttonResult.text;
        const ensuredButtons = await ensureAIButtons(chatId, action, rawResponse, buttonResult.buttons, /alight\s*motion|am\s*prem|am\s*premium/i.test(action));
        const inline_keyboard = ensuredButtons.length ? [ensuredButtons] : [];

        if (!rawResponse) rawResponse = generatedResult.files.length
            ? '📦 File-nya sudah siap.'
            : '😭 AI nggak menghasilkan jawaban kali ini.';

        pushHistory(chatId, 'user', action);
        pushHistory(chatId, 'assistant', rawResponse);

        const markup = inline_keyboard.length ? { reply_markup: { inline_keyboard } } : {};
        const extraOptions = { reply_to_message_id: query.message?.message_id, ...markup };

        // Foto + caption + tombol = SATU bubble.
        if (imageToSent) {
            try {
                await bot.sendPhoto(chatId, imageToSent, {
                    caption: convertMarkdownToHTML(rawResponse).slice(0, 1024),
                    parse_mode: 'HTML',
                    ...markup,
                    reply_to_message_id: query.message?.message_id
                });
                if (generatedResult.files.length > 0) {
                    await sendGeneratedDocuments(chatId, generatedResult.files, markup);
                }
            } catch (e) {
                console.error('[GAMBAR CALLBACK GAGAL]', e.message);
                if (generatedResult.files.length > 0) await sendGeneratedDocuments(chatId, generatedResult.files, { ...markup, caption: rawResponse });
                else await sendReply(bot, chatId, rawResponse, extraOptions);
            }
            return;
        }

        // Dokumen/ZIP + caption + tombol = SATU bubble. Caption berada di bawah file.
        if (generatedResult.files.length > 0) {
            await sendGeneratedDocuments(chatId, generatedResult.files, { ...markup, caption: rawResponse });
            return;
        }

        await sendReply(bot, chatId, rawResponse, extraOptions);

    } catch (error) {
        if (chatId) {
            try { await sendReply(bot, chatId, '😭 Tombolnya kepencet dan request-nya masuk, tapi AI lagi ngadat. Coba pencet lagi.'); } catch {}
        }
        console.error('[BUTTON CALLBACK ERROR]', error.message || error);
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
        const stopRecordingPresence = startRecordingPresence(chatId);
        let response;
        try {
            const mediaResult = await buildMediaPrompt(msg, text || '[Sistem: Pengguna mengirim media tanpa caption.]');
            const currentTimeInstruction = `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB.]`;
            const buttonReminder = `[INFO SISTEM MUTLAK: SETIAP BALASAN NORMAL WAJIB memiliki 1-4 tombol rekomendasi AI DINAMIS. Jumlah harus bervariasi; 4 hanya sesekali, jangan terus 4. AI sendiri WAJIB mengarang teks pendek, emoji, topik, dan maksud tombol berdasarkan percakapan. DILARANG memakai "Lanjut chat" atau label generik. Untuk tombol yang memicu jawaban AI gunakan {"text":"...","callback_data":"ask|..."}; untuk membuka halaman gunakan {"text":"...","url":"https://..."}. Tombol maksimal 48 karakter dan harus singkat. Jika ada URL yang diberikan user atau memang diketahui dari konteks, boleh buat tombol URL. Jika topik Alight Motion Premium/AM Prem muncul, WAJIB sertakan [IMAGE: https://ibb.co.com/Tx5ND8rF] dan buat tombol order URL https://t.me/vickyyvall ATAUPUN WhatsApp +62 895-4109-75149. Jika membuat satu file, gunakan [FILE: filename="..."]...[/FILE]. Jika membuat beberapa file yang saling berhubungan, gunakan [ZIP: filename="...zip"] dengan [ZIP_FILE] lengkap. Jangan taruh tag mesin di paragraf chat. Jangan pernah keluarkan kurung ] sendirian.]`;
            const finalPrompt = `${currentTimeInstruction}\n${buttonReminder}\n\n${mediaResult.finalPrompt}`;
            response = await askAI(chatId, finalPrompt, mediaResult.base64Media, mediaResult.mimeTypeMedia);
        } finally {
            stopRecordingPresence();
        }

        if (aiMutedChats.has(chatId)) return;

        let rawResponse = cleanText(response);
        let imageToSent = null;
        const amTopic = /(?:alight\s*motion|am\s*prem|am\s*premium|alight\s*motion\s*premium)/i.test(text || '') || /ibb\.co\/xQvP6qy/i.test(text || '');
        const amPremiumImage = 'https://i.ibb.co/JPL0HjN/file-00000000c2088211b38f3ad07fe993da.png';
        const imageRegex = /\[IMAGE:\s*(https?:\/\/[^\s\]]+)\s*\]/is;
        const imgMatch = rawResponse.match(imageRegex);
        if (imgMatch) {
            imageToSent = imgMatch[1];
            rawResponse = rawResponse.replace(imageRegex, '').trim();
        }
        if (!imageToSent && amTopic) imageToSent = amPremiumImage;

        const generatedResult = parseGeneratedFiles(rawResponse);
        rawResponse = generatedResult.text;
        const buttonResult = parseDynamicButtons(rawResponse);
        rawResponse = buttonResult.text;
        const ensuredButtons = await ensureAIButtons(chatId, text, rawResponse, buttonResult.buttons, amTopic);
        const inline_keyboard = ensuredButtons.length ? [ensuredButtons] : [];

        pushHistory(chatId, 'user', text || '[Media]');
        pushHistory(chatId, 'assistant', rawResponse);

        const markup = inline_keyboard.length ? { reply_markup: { inline_keyboard } } : {};
        const extraOptions = { reply_to_message_id: msg.message_id, ...markup };

        // AM Premium: gambar + chat + tombol dalam SATU bubble foto.
        if (imageToSent) {
            try {
                await bot.sendPhoto(msg.chat.id, imageToSent, {
                    caption: convertMarkdownToHTML(rawResponse).slice(0, 1024),
                    parse_mode: 'HTML',
                    ...markup,
                    reply_to_message_id: msg.message_id
                });
            } catch (e) {
                console.error('[GAMBAR CHAT GAGAL]', e.message);
                if (generatedResult.files.length === 0) {
                    await sendReply(bot, msg.chat.id, rawResponse, extraOptions);
                }
            }
        } else if (generatedResult.files.length > 0) {
            // ZIP/dokumen + caption chat + tombol = SATU bubble dokumen.
            await sendGeneratedDocuments(msg.chat.id, generatedResult.files, { ...markup, caption: rawResponse });
        } else {
            await sendReply(bot, msg.chat.id, rawResponse, extraOptions);
        }

        // Kalau AM/image sekaligus punya file, file tetap dikirim sebagai dokumen terpisah.
        // Kalau tidak ada image, dokumen sudah dikirim di cabang di atas.
        if (imageToSent && generatedResult.files.length > 0) {
            await sendGeneratedDocuments(msg.chat.id, generatedResult.files, { ...markup, caption: rawResponse });
        }

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
