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

// ============================================================
// 👑 USER ACCESS / VIP / AI LIMIT SYSTEM
// ============================================================

// Owner utama bot.
// Username dipakai untuk identitas tampilan.
// Nanti kita tambahkan verifikasi Telegram user ID juga.
const OWNER_USERNAME = 'vickyyvall';

// Limit AI.
const NON_VIP_LIMIT = 10;
const VIP_BASE_LIMIT = 50;
const VIP_BONUS_LIMIT = 25;
const VIP_TOTAL_LIMIT = VIP_BASE_LIMIT + VIP_BONUS_LIMIT;

// Harga VIP.
const VIP_PRICE = 25900;
const VIP_NORMAL_PRICE = 39900;

// Pastikan database user tersedia tanpa merusak data API lama.
if (!db.users || typeof db.users !== 'object' || Array.isArray(db.users)) {
    db.users = {};
}

function normalizeUsername(username) {
    return String(username || '')
        .trim()
        .replace(/^@+/, '')
        .toLowerCase();
}

function getUserKey(userId) {
    return String(userId || '').trim();
}

function isOwner(msgOrUser) {
    const user = msgOrUser?.from || msgOrUser || {};
    const username = normalizeUsername(user.username);

    return username === OWNER_USERNAME;
}

function getUserRecord(msg) {
    const user = msg?.from || {};
    const userId = getUserKey(user.id);

    if (!userId) return null;

    if (!db.users[userId]) {
        db.users[userId] = {
            userId,
            username: normalizeUsername(user.username),
            firstName: String(user.first_name || ''),
            lastName: String(user.last_name || ''),
            status: isOwner(msg) ? 'OWNER' : 'NONVIP',
            vip: isOwner(msg),
            aiLimit: isOwner(msg) ? null : NON_VIP_LIMIT,
            aiUsed: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        saveDb();
    } else {
        // Update data Telegram yang memang boleh berubah.
        const record = db.users[userId];

        record.username = normalizeUsername(user.username);
        record.firstName = String(user.first_name || '');
        record.lastName = String(user.last_name || '');
        record.updatedAt = new Date().toISOString();

        // Owner selalu mendapatkan akses Unlimited.
        if (isOwner(msg)) {
            record.status = 'OWNER';
            record.vip = true;
            record.aiLimit = null;
        }

        saveDb();
    }

    return db.users[userId];
}

function getUserLimitInfo(msg) {
    const user = getUserRecord(msg);

    if (!user) {
        return {
            status: 'NONVIP',
            total: NON_VIP_LIMIT,
            used: 0,
            remaining: NON_VIP_LIMIT,
            unlimited: false
        };
    }

    if (user.status === 'OWNER') {
        return {
            status: 'OWNER',
            total: null,
            used: Number(user.aiUsed || 0),
            remaining: null,
            unlimited: true
        };
    }

    if (user.status === 'VIP' || user.vip === true) {
        return {
            status: 'VIP',
            total: VIP_TOTAL_LIMIT,
            used: Number(user.aiUsed || 0),
            remaining: Math.max(0, VIP_TOTAL_LIMIT - Number(user.aiUsed || 0)),
            unlimited: false
        };
    }

    return {
        status: 'NONVIP',
        total: NON_VIP_LIMIT,
        used: Number(user.aiUsed || 0),
        remaining: Math.max(0, NON_VIP_LIMIT - Number(user.aiUsed || 0)),
        unlimited: false
    };
}

function formatRupiah(number) {
    return new Intl.NumberFormat('id-ID').format(Number(number || 0));
}

function getStatusLabel(status) {
    if (status === 'OWNER') return '👑 OWNER';
    if (status === 'VIP') return '🏆 VIP';
    return '👤 NON-VIP';
}

function getLimitLabel(info) {
    if (info.unlimited) return 'Unlimited ∞';

    return `${info.remaining} / ${info.total}`;
}

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
    return /^(?:\/(?:start|help|mute|unmute|status|reset)(?:@\w+)?|\.addvip(?:\s|$)|\.ceklimit(?:\s|$))/i.test(
        String(text || '').trim()
    );
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
    { text: '🎵 Rekomendasi musik', callback_data: 'ask|rekomendasikan musik terkenal berdasarkan mood' },
    { text: '🧑🏻‍🏫 Trik hp', callback_data: 'ask|kasih trik hp android yang berguna' },
    { text: '💻 Tips coding', callback_data: 'ask|kasih tips coding yang praktis' },
    { text: '🗣️ Ngobrol ai', callback_data: 'ask|jelasin sesuatu yang menarik tentang ai' }
];

function randomStartButtons() {
    return [...START_BUTTON_POOL].sort(() => Math.random() - 0.5).slice(0, 2);
}

bot.onText(/^\/(start|help)(?:@\w+)?$/i, async (msg) => {
    const user = getUserRecord(msg);
    const info = getUserLimitInfo(msg);

    const username = user?.username
        ? `@${user.username}`
        : 'Tidak ada username';

    const statusText = getStatusLabel(info.status);

    const limitText = info.unlimited
        ? 'Unlimited ∞'
        : `${info.remaining} / ${info.total}`;

    const usedText = info.unlimited
        ? `${info.used} penggunaan`
        : `${info.used} penggunaan`;

    const text =
        `<b>✦ VICKYYVALL - AI ✦</b>\n` +
        `<i>YOUR AI • YOUR SPACE • YOUR VIBE</i>\n\n` +

        `<blockquote>` +
        `<b>👤 USER PROFILE</b>\n` +
        `├ Username : <b>${username}</b>\n` +
        `├ Status   : <b>${statusText}</b>\n` +
        `├ AI Limit : <b>${limitText}</b>\n` +
        `└ Terpakai : <b>${usedText}</b>` +
        `</blockquote>\n\n` +

        `<blockquote>` +
        `<b>💎 VIP ACCESS</b>\n` +
        `├ Harga normal : <s>3̶9̶.̶9̶0̶0̶</s>\n` +
        `├ Harga VIP    : <b>Rp25.900</b>\n` +
        `├ Limit utama  : <b>50</b>\n` +
        `├ Bonus        : <b>+25</b>\n` +
        `└ Total        : <b>75 AI Limit</b>` +
        `</blockquote>\n\n` +

        `<b>VGen AI Multifungsi</b> 🏴‍☠️\n\n` +
        `Teman AI yang siap nemenin lu kapan aja. 😎\n\n` +
        `Mau ngobrol, cari ide, belajar, coding, bahas bola, ` +
        `atau sekadar random juga gw gas😹🔥\n\n` +

        `<b>✨ PILIHAN MENU</b>\n` +
        `Pilih tombol di bawah atau langsung ketik apa yang mau lu obrolin.\n\n` +

        `<b>Temukan juga vickyyvall - AI di sini 👇</b>`;

const keyboard = [
    [
        { text: '💎 AM Prem 1th', url: 'https://t.me/vickyyvall' },
        { text: '🛒 Upgrade AI', callback_data: 'ui|vip' }
    ],
    [
        { text: '📊 Cek Limit', callback_data: 'ui|limit' },
        { text: '🏆 Info VIP', callback_data: 'ui|vip' }
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

// ============================================================
// 👑 VIP COMMAND SYSTEM
// ============================================================

function findUserByUsername(username) {
    const target = normalizeUsername(username);

    if (!target) return null;

    for (const userId of Object.keys(db.users || {})) {
        const user = db.users[userId];

        if (normalizeUsername(user.username) === target) {
            return user;
        }
    }

    return null;
}

function getPrettyUserName(user) {
    if (!user) return 'User';

    if (user.username) {
        return `@${user.username}`;
    }

    return user.firstName || 'User';
}



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

// ============================================================
// 💎 VIP MANAGEMENT COMMANDS
// ============================================================

// Escape HTML agar username tidak bisa merusak format Telegram.
function escapeHTML(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Cari user berdasarkan username yang sudah pernah berinteraksi
// dengan bot dan tersimpan di database.json.
function findUserByUsername(username) {
    const target = normalizeUsername(username);

    if (!target) return null;

    for (const userId of Object.keys(db.users || {})) {
        const user = db.users[userId];

        if (normalizeUsername(user.username) === target) {
            return user;
        }
    }

    return null;
}


// ============================================================
// .ADDVIP @USERNAME
// OWNER ONLY
// ============================================================

bot.onText(/^\.addvip(?:\s+(.+))?$/i, async (msg, match) => {

    if (!isOwner(msg)) {
        await sendReply(
            bot,
            msg.chat.id,
            `<blockquote>` +
            `<b>⛔ AKSES DITOLAK</b>\n\n` +
            `Perintah <code>.addvip</code> hanya bisa digunakan oleh owner bot.` +
            `</blockquote>`
        );
        return;
    }

    const argument = String(match?.[1] || '').trim();

    // WAJIB @username
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(argument)) {
        await sendReply(
            bot,
            msg.chat.id,
            `<blockquote>` +
            `<b>⚠️ FORMAT SALAH</b>\n\n` +
            `Gunakan format:\n\n` +
            `<code>.addvip @username</code>\n\n` +
            `Contoh:\n` +
            `<code>.addvip @contohuser</code>\n\n` +
            `Jangan lupa tanda <b>@</b>.` +
            `</blockquote>`
        );
        return;
    }

    const username = normalizeUsername(argument);
    const target = findUserByUsername(username);

    if (!target) {
        await sendReply(
            bot,
            msg.chat.id,
            `<blockquote>` +
            `<b>🔎 USER BELUM DITEMUKAN</b>\n\n` +
            `Username <b>@${escapeHTML(username)}</b> belum ditemukan di database bot.\n\n` +
            `Minta user tersebut chat bot minimal sekali terlebih dahulu.` +
            `</blockquote>`
        );
        return;
    }

    target.status = 'VIP';
    target.vip = true;
    target.aiLimit = VIP_TOTAL_LIMIT;

    // Reset limit menjadi 75 ketika diberikan VIP.
    target.aiUsed = 0;
    target.vipGrantedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();

    saveDb();

    await sendReply(
        bot,
        msg.chat.id,
        `<blockquote>` +
        `<b>🏆 VIP BERHASIL DIAKTIFKAN</b>\n\n` +
        `👤 User : <b>@${escapeHTML(username)}</b>\n` +
        `🏷️ Status : <b>VIP</b>\n` +
        `📊 Limit : <b>75</b>\n` +
        `├ Limit utama : 50\n` +
        `└ Bonus : +25\n\n` +
        `💎 Harga : <b>Rp25.900</b>` +
        `</blockquote>`
    );
});

// ============================================================
// 📊 .CEKLIMIT
// SUPPORT:
// .ceklimit
// .ceklimit @username
// ============================================================

bot.onText(/^\.ceklimit(?:\s+(.+))?$/i, async (msg, match) => {

    const argument = String(match?.[1] || '').trim();

    // ========================================================
    // CEK DIRI SENDIRI
    // ========================================================

    if (!argument) {

        const info = getUserLimitInfo(msg);
        const username = normalizeUsername(msg.from?.username);

        const status = getStatusLabel(info.status);
        const limit = getLimitLabel(info);

        const explanation = info.unlimited
            ? `👑 Karena akun lu adalah <b>OWNER</b>, akses AI lu tidak dibatasi jumlah chat.`
            : info.status === 'VIP'
                ? `💎 Status <b>VIP</b> memberikan paket limit AI khusus. Setiap kali lu benar-benar ngobrol dengan AI, pemakaian akan dihitung dari limit tersebut.`
                : `ℹ️ Limit ini hanya berkurang ketika lu memakai fitur <b>AI chat</b>. Command bot, /start, cek limit, dan menu biasa tidak mengurangi limit AI.`;

        await sendReply(
            bot,
            msg.chat.id,
            `<b>📊 STATUS LIMIT AI</b>\n\n` +

            `<blockquote>` +
            `👤 Username : <b>@${escapeHTML(username || 'tidak tersedia')}</b>\n` +
            `🏷️ Status : <b>${status}</b>\n` +
            `💬 Limit : <b>${limit}</b>\n` +
            `📈 Terpakai : <b>${info.used}</b>` +
            `</blockquote>\n\n` +

            `${explanation}\n\n` +

            `<blockquote>` +
            `<b>💡 Gampangnya:</b>\n` +
            `${info.unlimited
                ? `lu bebas ngobrol dengan AI tanpa potongan limit.`
                : `yang dihitung cuma percakapan AI, bukan semua aktivitas lu di bot.`}` +
            `</blockquote>`,

            {
                reply_to_message_id: msg.message_id
            }
        );

        return;
    }


    // ========================================================
    // USERNAME HARUS @USERNAME
    // ========================================================

    if (!argument.startsWith('@')) {

        await sendReply(
            bot,
            msg.chat.id,

            `<blockquote>` +
            `<b>⚠️ FORMAT SALAH</b>\n\n` +
            `Gunakan:\n` +
            `<code>.ceklimit @username</code>\n\n` +
            `Contoh:\n` +
            `<code>.ceklimit @vickyyvall</code>` +
            `</blockquote>`,

            {
                reply_to_message_id: msg.message_id
            }
        );

        return;
    }


    // ========================================================
    // CARI USER
    // ========================================================

    const username = normalizeUsername(argument);
    const target = findUserByUsername(username);

    if (!target) {

        await sendReply(
            bot,
            msg.chat.id,

            `<blockquote>` +
            `<b>🔎 USER TIDAK DITEMUKAN</b>\n\n` +
            `@${escapeHTML(username)} belum tercatat di database bot.\n\n` +
            `Minta user tersebut chat bot minimal sekali terlebih dahulu.` +
            `</blockquote>`,

            {
                reply_to_message_id: msg.message_id
            }
        );

        return;
    }


    // ========================================================
    // HITUNG LIMIT USER
    // ========================================================

    const isTargetOwner = target.status === 'OWNER';

    const total = isTargetOwner
        ? 'Unlimited ∞'
        : target.status === 'VIP'
            ? VIP_TOTAL_LIMIT
            : NON_VIP_LIMIT;

    const used = Number(target.aiUsed || 0);

    const remaining = isTargetOwner
        ? 'Unlimited ∞'
        : Math.max(0, Number(total) - used);

    const status =
        target.status === 'OWNER'
            ? '👑 OWNER'
            : target.status === 'VIP'
                ? '🏆 VIP'
                : '👤 NON-VIP';


    // ========================================================
    // HASIL
    // ========================================================

    await sendReply(
        bot,
        msg.chat.id,

        `<b>📊 CEK LIMIT USER</b>\n\n` +

        `<blockquote>` +
        `👤 Username : <b>@${escapeHTML(username)}</b>\n` +
        `🏷️ Status : <b>${status}</b>\n` +
        `📦 Total : <b>${total}</b>\n` +
        `📉 Terpakai : <b>${used}</b>\n` +
        `⚡ Sisa : <b>${remaining}</b>` +
        `</blockquote>\n\n` +

        `<blockquote>` +
        `<b>💡 Keterangan:</b>\n` +
        `${
            isTargetOwner
                ? `Akun ini memiliki akses AI <b>Unlimited</b>.`
                : target.status === 'VIP'
                    ? `Akun VIP memiliki paket limit AI khusus. Limit berkurang hanya saat fitur AI digunakan.`
                    : `Akun NON-VIP menggunakan limit AI standar.`
        }` +
        `</blockquote>`,

        {
            reply_to_message_id: msg.message_id
        }
    );
});

// ============================================================
// 🔐 AI LIMIT GATE
// ============================================================

function consumeAiLimit(msg) {
    const info = getUserLimitInfo(msg);

    // OWNER = Unlimited
    if (info.unlimited) {
        return {
            allowed: true,
            info
        };
    }

    // Limit habis
    if (info.remaining <= 0) {
        return {
            allowed: false,
            info
        };
    }

    const user = getUserRecord(msg);

    if (!user) {
        return {
            allowed: false,
            info
        };
    }

    // HANYA di sini AI usage bertambah.
    user.aiUsed = Number(user.aiUsed || 0) + 1;
    user.updatedAt = new Date().toISOString();

    saveDb();

    return {
        allowed: true,
        info: getUserLimitInfo(msg)
    };
}


function buildLimitExpiredMessage(info) {
    return {
        text:
            `<blockquote>` +
            `<b>🚫 AI LIMIT HABIS</b>\n\n` +

            `Limit AI akun lu sudah mencapai batas.\n\n` +

            `👤 Status : <b>${info.status === 'VIP' ? '🏆 VIP' : '👤 NON-VIP'}</b>\n` +
            `📊 Limit  : <b>${info.total}</b>\n` +
            `📉 Sisa   : <b>0</b>\n\n` +

            `💎 Mau lanjut ngobrol lebih banyak?\n` +
            `Upgrade ke VIP dan dapat:\n` +
            `├ 50 Limit utama\n` +
            `├ +25 Bonus Limit\n` +
            `└ Total <b>75 AI Limit</b>\n\n` +

            `<s>Rp3̶9̶.̶9̶0̶0̶</s> → <b>Rp25.900</b>` +
            `</blockquote>`,

        keyboard: [
            [
                {
                    text: '💎 Upgrade VIP',
                    url: 'https://t.me/vickyyvall'
                }
            ],
            [
                {
                    text: '🛒 Order AM Prem',
                    callback_data: 'order_am_prem'
                }
            ]
        ]
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

    // HAPUS SPAM INFO SISTEM & BOCORAN [THOUGHT] AI YANG NGELANTUR
    text = text.replace(/\[INFO SISTEM:.*?\]/gi, '').trim();
    
    // Pembersih brutal buat ngehapus logika AI sebelum dia beneran ngebales
    text = text.replace(/\[THOUGHT\][\s\S]*?(?=(?:<<<|\n\n|Nah|Gas|Yaudah|Wkwk|Jadi|Oke|Iya|Gw|Lu))/gi, '').trim();
    text = text.replace(/^(Reinforce|Instructions|Image|Pronouns|Thought):.*$/gim, '').trim();

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
                    if (validButtons.length >= 3) break;
                }
            }
        if (validButtons.length > 0) {
            inline_keyboard = [validButtons.slice(0, 3)];
        }
    } catch (error) {
        console.error('[BUTTON PARSER ERROR]', error.message);
    }
    text = text.replace(buttonRegex, '').trim();
}

// ============================================================
// FIX BUTTON AM PREM + AI-GENERATED BUTTONS
// ============================================================

// AM PREM tetap punya tombol khusus karena ini memang fitur bisnis.
if (imageToSent === 'https://ibb.co.com/Tx5ND8rF' && inline_keyboard.length === 0) {
    inline_keyboard = [[
        {
            text: "🛒 Chat vickyyvall Now!",
            url: "https://t.me/vickyyvall"
        }
    ]];
}

// JANGAN paksa tombol rekomendasi generik.
// Jika AI membuat tombol sendiri, gunakan tombol AI tersebut.
// Jika AI tidak membuat tombol, biarkan tidak ada tombol.
//
// Tujuannya:
// AI SENDIRI yang menentukan apakah tombol diperlukan,
// berapa jumlahnya, apa topiknya, dan apakah memakai emoji.
//
// Tidak ada lagi:
// - randomStartButtons()
// - START_BUTTON_POOL sebagai fallback
// - tombol "Trik hp"
// - tombol "Fakta random"
// - tombol "Rekomendasi musik"
// - tombol generik lain yang tidak berkaitan dengan percakapan.

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

// ============================================================
// 🛒 ORDER AM PREM
// NON-AI / TIDAK MEMOTONG LIMIT
// ============================================================

if (data === 'order_am_prem') {

    await bot.answerCallbackQuery(query.id);

    await sendReply(
        bot,
        chatId,
        `<blockquote>` +
        `<b>🛒 ORDER ALIGHT MOTION PREMIUM</b>\n\n` +
        `Lu tertarik order AM Prem 1 Tahun?\n\n` +
        `💎 Harga: <b>Rp5.000</b>\n` +
        `⏱️ Durasi: <b>1 Tahun</b>\n\n` +
        `Mau lanjut order sekarang?` +
        `</blockquote>`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '✅ Ya, mau order',
                            url: 'https://t.me/vickyyvall'
                        }
                    ],
                    [
                        {
                            text: '⏳ Lain kali',
                            callback_data: 'order_am_later'
                        }
                    ]
                ]
            }
        }
    );

    return;
}

if (data === 'order_am_later') {

    await bot.answerCallbackQuery(query.id);

    await sendReply(
        bot,
        chatId,
        `<blockquote>` +
        `<b>⏳ OKE, SANTAI.</b>\n\n` +
        `Kalau belum mau order sekarang, gapapa.\n\n` +
        `Tapi kalau lu mau akses AI lebih banyak,\n` +
        `lu tetap bisa upgrade ke VIP kapan aja. 😝\n\n` +
        `💎 <b>VIP AI</b>\n` +
        `├ 50 Limit utama\n` +
        `├ +25 Bonus\n` +
        `└ Total 75 Limit\n\n` +
        `<s>Rp3̶9̶.̶9̶0̶0̶</s> → <b>Rp25.900</b>` +
        `</blockquote>`,
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '💎 Upgrade VIP',
                            url: 'https://t.me/vickyyvall'
                        }
                    ]
                ]
            }
        }
    );

    return;
}
    try {
        if (!chatId) {
    await bot.answerCallbackQuery(query.id);
    return;
}

// ============================================================
// UI BUTTONS
// ============================================================

if (data === 'ui|limit') {

    await bot.answerCallbackQuery(query.id);

    const fakeMsg = {
        from: query.from || {}
    };

    const info = getUserLimitInfo(fakeMsg);

    await sendReply(
        bot,
        chatId,
        `<b>📊 LIMIT AI KAMU</b>\n\n` +
        `╭━━━━━━━━━━━━━━━━━━╮\n` +
        `┃ 👤 Status : <b>${getStatusLabel(info.status)}</b>\n` +
        `┃ 💬 Limit  : <b>${getLimitLabel(info)}</b>\n` +
        `┃ 📈 Terpakai : <b>${info.used}</b>\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
        (info.unlimited
            ? `👑 Owner mode aktif.\n<b>Unlimited ∞</b>`
            : `ℹ️ Limit ini hanya digunakan untuk <b>obrolan AI</b>.\n` +
              `Chat bot non-AI tidak mengurangi limit.`)
    );

    return;
}


if (data === 'ui|vip') {

    await bot.answerCallbackQuery(query.id);

    await sendReply(
        bot,
        chatId,
        `<b>🏆 VIP vickyyvall - AI.</b>\n\n` +
        `╭━━━━━━━━━━━━━━━━━━╮\n` +
        `┃ 💎 Harga VIP : <b>Rp25.900</b>\n` +
        `┃ 🗨️ Limit utama : <b>50</b>\n` +
        `┃ 🎁 Bonus : <b>+25</b>\n` +
        `┃ 💬 Total : <b>75 chat AI</b>\n` +
        `╰━━━━━━━━━━━━━━━━━━╯\n\n` +
        `💸 Harga normal: <s>Rp39.900</s>\n` +
        `🔥 Harga sekarang: <b>Rp25.900</b>\n\n` +
        `VIP memberikan tambahan akses AI.` +
        `\n\n` +
        `🛒 Kalau mau upgrade, hubungi <b>@vickyyvall</b>.`
    );

    return;
}


// ============================================================
// AI CALLBACK
// ============================================================

if (!data.startsWith('ask|')) {
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

        // ============================================================
// 🔐 LIMIT CHECK UNTUK BUTTON AI
// ============================================================

const callbackUser = query.from || {};
const callbackMsg = {
    from: callbackUser,
    chat: query.message?.chat || {},
    message_id: query.message?.message_id
};

const limitCheck = consumeAiLimit(callbackMsg);

if (!limitCheck.allowed) {
    const expired = buildLimitExpiredMessage(limitCheck.info);

    await bot.answerCallbackQuery(query.id, {
        text: 'AI limit lu sudah habis 😭',
        show_alert: false
    });

    await sendReply(
        bot,
        chatId,
        expired.text,
        {
            reply_markup: {
                inline_keyboard: expired.keyboard
            }
        }
    );

    return;
}

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
    
if (/^\.addvip(?:\s|$)/i.test(text)) return;
if (/^\.ceklimit(?:\s|$)/i.test(text)) return;
const chatId = String(msg.chat.id);

if (aiMutedChats.has(chatId)) return;
if (msg.date && Math.floor(Date.now() / 1000) - msg.date > 120) return;

// ============================================================
// 🔐 LIMIT HANYA UNTUK AI CHAT
// ============================================================

const limitCheck = consumeAiLimit(msg);

if (!limitCheck.allowed) {
    const expired = buildLimitExpiredMessage(limitCheck.info);

    await sendReply(
        bot,
        chatId,
        expired.text,
        {
            reply_markup: {
                inline_keyboard: expired.keyboard
            }
        }
    );

    return;
}

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
