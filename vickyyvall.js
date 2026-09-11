/**
 * VGEN AI - TELEGRAM BOT EDITION
 * Server-side provider selector + Gemini automatic quota failover.
 * Node.js 22+.
 *
 * IMPORTANT:
 * - API keys are supplied by the local HTML activation panel.
 * - API keys are NOT hard-coded in this JS file.
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
        const all = [
            ...(secretConfig?.geminiAccounts || []),
            ...(secretConfig?.openaiAccounts || [])
        ];

        for (const item of all) {
            if (item?.key) {
                msg = msg.split(item.key).join('[REDACTED]');
            }
        }
    } catch {}

    return msg
        .replace(/key=[^&\s]+/gi, 'key=[REDACTED]')
        .slice(0, 700);
}

/* ============================================================
   PROMPT
   ============================================================ */

let vgenPrompt = '';

try {
    vgenPrompt = require('./prompt.js');
} catch {
    vgenPrompt = 'Kamu adalah VGen AI, asisten yang cerdas dan efisien.';
}

/* ============================================================
   TELEGRAM CONFIG
   ============================================================ */

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN || 'PASTE_BOT_TOKEN_DI_SINI';

const PORT = process.env.PORT || 8080;

const MAX_HISTORY = 15;
const MAX_TEXT_FILE = 5000;

if (TELEGRAM_BOT_TOKEN === 'PASTE_BOT_TOKEN_DI_SINI') {
    console.error(
        '❌ TELEGRAM_BOT_TOKEN belum diisi. Set environment variable TELEGRAM_BOT_TOKEN.'
    );

    process.exit(1);
}

/* ============================================================
   AI CONFIG
   API KEY DIAMBIL DARI HTML LOCAL ACTIVATION PANEL.
   TIDAK ADA API KEY YANG DITULIS DI FILE JS INI.
   ============================================================ */

let secretConfig = {
    geminiAccounts: [],
    openaiAccounts: []
};

/* ============================================================
   JANGAN UBAH MODEL GEMINI INI
   URUTAN WAJIB:

   1. gemini-2.5-flash-lite
   2. gemini-2.5-flash
   3. gemini-3.5-flash

   Setelah model terakhir habis:
   -> akun/email berikutnya
   -> kembali ke model Lite
   ============================================================ */

const GEMINI_MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.5-flash'
];

/* ============================================================
   OPENAI MODEL
   ============================================================ */

const OPENAI_MODEL = 'gpt-5.4-mini';

/* ============================================================
   DATABASE
   HANYA MENYIMPAN STATE NON-SECRET.
   API KEY TIDAK DISIMPAN KE DATABASE.
   ============================================================ */

const dbFile = path.join(__dirname, 'database.json');

let db = {
    apiConfig: {}
};

if (fs.existsSync(dbFile)) {
    try {
        db = JSON.parse(
            fs.readFileSync(dbFile, 'utf8')
        );
    } catch (e) {
        console.error(
            '❌ Gagal membaca database.json:',
            safeError(e)
        );
    }
}

function saveDb() {
    db.apiConfig = {
        provider: activeProvider,
        geminiAccountIndex: geminiAccountIndex,
        geminiModelIndex: geminiModelIndex
    };

    fs.writeFileSync(
        dbFile,
        JSON.stringify(db, null, 2)
    );
}

/* ============================================================
   ACTIVE PROVIDER / GEMINI POINTER
   ============================================================ */

let activeProvider =
    String(db.apiConfig?.provider || '').toUpperCase() || null;

let geminiAccountIndex =
    Number.isInteger(db.apiConfig?.geminiAccountIndex)
        ? db.apiConfig.geminiAccountIndex
        : 0;

let geminiModelIndex =
    Number.isInteger(db.apiConfig?.geminiModelIndex)
        ? db.apiConfig.geminiModelIndex
        : 0;

if (geminiAccountIndex < 0) {
    geminiAccountIndex = 0;
}

if (
    geminiModelIndex < 0 ||
    geminiModelIndex >= GEMINI_MODELS.length
) {
    geminiModelIndex = 0;
}

/*
 * database.json bisa saja mengatakan provider aktif.
 * Tetapi API key memang tidak disimpan di database.
 *
 * Jadi setelah Node restart:
 * HTML harus mengirim ulang konfigurasi.
 */

if (
    activeProvider === 'GEMINI' &&
    !secretConfig.geminiAccounts.length
) {
    activeProvider = null;
}

if (
    activeProvider === 'OPENAI' &&
    !secretConfig.openaiAccounts.length
) {
    activeProvider = null;
}

/* ============================================================
   MEMORY
   ============================================================ */

const userHistory = new Map();

const aiMutedChats = new Set();

const failoverInFlight = new Map();

/* ============================================================
   HISTORY
   ============================================================ */

function historyFor(chatId) {
    const key = String(chatId);

    if (!userHistory.has(key)) {
        userHistory.set(key, []);
    }

    return userHistory.get(key);
}

function pushHistory(chatId, role, content) {
    const history = historyFor(chatId);

    history.push({
        role,
        content
    });

    if (history.length > MAX_HISTORY) {
        history.splice(
            0,
            history.length - MAX_HISTORY
        );
    }
}

/* ============================================================
   TEXT HELPERS
   ============================================================ */

function cleanText(value) {
    return String(value || '').trim();
}

function nowWIB() {
    return new Date().toLocaleString(
        'id-ID',
        {
            timeZone: 'Asia/Jakarta'
        }
    );
}

function isCommand(text) {
    return /^\/(?:start|help|mute|unmute|status|reset)(?:@\w+)?(?:\s|$)/i.test(
        text
    );
}

function escapeHTML(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/* ============================================================
   MARKDOWN -> TELEGRAM HTML
   ============================================================ */

function convertMarkdownToHTML(text) {
    if (!text) {
        return '';
    }

    let formatted = String(text);

    formatted = formatted.replace(
        /```([\s\S]*?)```/g,
        (match, codeBlock) => {
            let cleanCode = codeBlock.replace(
                /^[a-z]+\n/i,
                ''
            );

            let safeCode = escapeHTML(cleanCode);

            return `<pre><code>${safeCode}</code></pre>`;
        }
    );

    formatted = formatted.replace(
        /`([^`]+)`/g,
        (match, code) => {
            return `<code>${escapeHTML(code)}</code>`;
        }
    );

    formatted = formatted.replace(
        /\*\*([^*]+)\*\*/g,
        '<b>$1</b>'
    );

    formatted = formatted.replace(
        /\*([^*]+)\*/g,
        '<b>$1</b>'
    );

    formatted = formatted.replace(
        /[\uFFFD]/g,
        '•'
    );

    return formatted;
}

/* ============================================================
   TELEGRAM MESSAGE SPLITTER
   ============================================================ */

function splitForTelegram(text, max = 4000) {
    const out = [];

    let rest = String(text || '');

    while (rest.length > max) {
        let cut = rest.lastIndexOf(
            '\n',
            max
        );

        if (cut < 500) {
            cut = max;
        }

        out.push(
            rest.slice(0, cut)
        );

        rest = rest
            .slice(cut)
            .trimStart();
    }

    if (rest) {
        out.push(rest);
    }

    return out.length
        ? out
        : [''];
}

/* ============================================================
   TELEGRAM SEND
   ============================================================ */

async function sendReply(
    bot,
    chatId,
    text,
    extra = {}
) {
    const htmlText =
        convertMarkdownToHTML(text);

    for (
        const chunk of splitForTelegram(htmlText)
    ) {
        try {
            await bot.sendMessage(
                chatId,
                chunk,
                {
                    parse_mode: 'HTML',
                    ...extra
                }
            );
        } catch (e) {
            console.error(
                '[SEND HTML ERROR]',
                safeError(e)
            );

            try {
                await bot.sendMessage(
                    chatId,
                    chunk.replace(
                        /<[^>]*>?/gm,
                        ''
                    ),
                    {
                        ...extra,
                        parse_mode: undefined
                    }
                );
            } catch {}
        }
    }
}

/* ============================================================
   DELAY HELPERS
   ============================================================ */

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}

function randomMs(min, max) {
    return Math.floor(
        min +
        Math.random() *
        (max - min + 1)
    );
}

/* ============================================================
   GEMINI TARGET
   ============================================================ */

function currentGeminiTarget() {
    const accounts =
        Array.isArray(
            secretConfig.geminiAccounts
        )
            ? secretConfig.geminiAccounts
            : [];

    if (!accounts.length) {
        throw new Error(
            'Gemini belum diaktifkan dari HTML.'
        );
    }

    if (
        geminiAccountIndex >=
        accounts.length
    ) {
        geminiAccountIndex = 0;
    }

    const account =
        accounts[geminiAccountIndex];

    return {
        accountIndex:
            geminiAccountIndex,

        modelIndex:
            geminiModelIndex,

        email:
            account.email,

        key:
            account.key,

        model:
            GEMINI_MODELS[
                geminiModelIndex
            ]
    };
}

/* ============================================================
   GEMINI FAILOVER POINTER
   ============================================================ */

function advanceGeminiTarget() {
    /*
     * Model berikutnya.
     *
     * Lite
     *   ↓
     * Flash
     *   ↓
     * 3.5 Flash
     *   ↓
     * Email berikutnya + Lite
     */

    geminiModelIndex++;

    if (
        geminiModelIndex >=
        GEMINI_MODELS.length
    ) {
        geminiModelIndex = 0;

        geminiAccountIndex++;

        if (
            geminiAccountIndex >=
            secretConfig.geminiAccounts.length
        ) {
            geminiAccountIndex = 0;
        }
    }

    saveDb();

    return currentGeminiTarget();
}

/* ============================================================
   QUOTA / RATE LIMIT DETECTION
   ============================================================ */

function isQuotaOrRateLimitError(
    status,
    data
) {
    const code =
        String(
            data?.error?.status ||
            data?.error?.code ||
            ''
        ).toUpperCase();

    const msg =
        String(
            data?.error?.message ||
            ''
        ).toLowerCase();

    if (status === 429) {
        return true;
    }

    if (
        status === 403 &&
        /(quota|rate.?limit|resource.?exhausted|exceeded|permission)/i.test(
            msg
        )
    ) {
        return true;
    }

    if (
        code.includes(
            'RESOURCE_EXHAUSTED'
        )
    ) {
        return true;
    }

    return /(
        quota|
        rate.?limit|
        resource.?exhausted|
        too many requests|
        exceeded
    )/i.test(msg);
}

/* ============================================================
   FAILOVER MESSAGE SEQUENCE
   ============================================================

   1. ⏳Loading
      -> REPLY / QUOTE pesan user

   2. Server penuh, tunggu sebentar...
      -> TANPA quote

   3. AI Berevolusi kembali✅
      -> TANPA quote

   Setelah itu askGemini lanjut ke target berikutnya
   dan pesan user tetap diproses.
   ============================================================ */

async function sendFailoverSequence(
    chatId,
    sourceMessageId
) {
    const key = String(chatId);

    /*
     * Jangan membuat banyak sequence failover
     * secara bersamaan untuk chat yang sama.
     */

    if (failoverInFlight.has(key)) {
        return failoverInFlight.get(key);
    }

    const job = (async () => {
        try {
            /* ================================================
               1. LOADING
               ================================================ */

            await sendReply(
                bot,
                chatId,
                '⏳Loading',
                {
                    reply_to_message_id:
                        sourceMessageId
                }
            );

            /*
             * Random 1–3 detik.
             */

            await sleep(
                randomMs(
                    1000,
                    3000
                )
            );

            /* ================================================
               2. SERVER PENUH
               ================================================ */

            await sendReply(
                bot,
                chatId,
                'Server penuh, tunggu sebentar...'
            );

            /*
             * Thinking delay.
             */

            await sleep(
                randomMs(
                    700,
                    1800
                )
            );

            /* ================================================
               3. AI BEREVOLUSI
               ================================================ */

            await sendReply(
                bot,
                chatId,
                'AI Berevolusi kembali✅'
            );
        } catch (error) {
            /*
             * Error API tidak pernah dikirim
             * mentah ke Telegram.
             */

            console.error(
                '[FAILOVER NOTICE]',
                safeError(error)
            );
        } finally {
            failoverInFlight.delete(key);
        }
    })();

    failoverInFlight.set(
        key,
        job
    );

    return job;
}

/* ============================================================
   TELEGRAM BOT
   ============================================================ */

const bot =
    new TelegramBot(
        TELEGRAM_BOT_TOKEN,
        {
            polling: true
        }
    );

bot.on(
    'polling_error',
    (err) => {
        console.error(
            '[TELEGRAM POLLING ERROR]',
            safeError(err)
        );
    }
);

bot.on(
    'webhook_error',
    (err) => {
        console.error(
            '[TELEGRAM WEBHOOK ERROR]',
            safeError(err)
        );
    }
);

/* ============================================================
   TYPING / PRESENCE
   ============================================================ */

function startRecordingPresence(chatId) {
    let stopped = false;

    const loop = async () => {
        while (!stopped) {
            try {
                await bot.sendChatAction(
                    chatId,
                    'typing'
                );
            } catch {}

            await sleep(4500);
        }
    };

    loop();

    return () => {
        stopped = true;
    };
}

/* ============================================================
   MEDIA
   ============================================================ */

function getMediaFromMessage(msg) {
    if (!msg) {
        return null;
    }

    if (msg.photo?.length) {
        const photo =
            msg.photo[
                msg.photo.length - 1
            ];

        return {
            type: 'photo',
            fileId: photo.file_id
        };
    }

    if (msg.document) {
        return {
            type: 'document',
            fileId:
                msg.document.file_id,

            mimeType:
                msg.document.mime_type ||
                'application/octet-stream',

            fileName:
                msg.document.file_name ||
                'file'
        };
    }

    if (msg.video) {
        return {
            type: 'video',
            fileId:
                msg.video.file_id,

            mimeType:
                msg.video.mime_type ||
                'video/mp4'
        };
    }

    if (msg.audio) {
        return {
            type: 'audio',
            fileId:
                msg.audio.file_id,

            mimeType:
                msg.audio.mime_type ||
                'audio/mpeg'
        };
    }

    return null;
}

/* ============================================================
   TELEGRAM FILE -> BASE64
   ============================================================ */

async function downloadTelegramFile(
    fileId
) {
    const file =
        await bot.getFile(fileId);

    if (!file?.file_path) {
        throw new Error(
            'Telegram file path tidak ditemukan.'
        );
    }

    const url =
        `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const response =
        await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Telegram file download failed: ${response.status}`
        );
    }

    const buffer =
        Buffer.from(
            await response.arrayBuffer()
        );

    return {
        buffer,
        filePath:
            file.file_path
    };
}

/* ============================================================
   MEDIA PROMPT BUILDER
   ============================================================ */

async function buildMediaPrompt(
    msg,
    text
) {
    const media =
        getMediaFromMessage(msg);

    if (!media) {
        return {
            finalPrompt:
                `${vgenPrompt}\n\n${text}`,

            base64Media: null,

            mimeTypeMedia: null
        };
    }

    try {
        const downloaded =
            await downloadTelegramFile(
                media.fileId
            );

        /*
         * Batasi file teks / media yang terlalu besar.
         */

        if (
            downloaded.buffer.length >
            MAX_TEXT_FILE * 1024
        ) {
            console.warn(
                '[MEDIA]',
                'File terlalu besar, hanya metadata yang dipakai.'
            );

            return {
                finalPrompt:
                    `${vgenPrompt}\n\n` +
                    `[Sistem: Pengguna mengirim ${media.type}. File terlalu besar untuk diproses penuh.]\n` +
                    `${text}`,

                base64Media: null,

                mimeTypeMedia: null
            };
        }

        const base64 =
            downloaded.buffer.toString(
                'base64'
            );

        let mime =
            media.mimeType ||
            'application/octet-stream';

        if (
            !media.mimeType &&
            media.type === 'photo'
        ) {
            mime = 'image/jpeg';
        }

        return {
            finalPrompt:
                `${vgenPrompt}\n\n` +
                `[Sistem: Pengguna mengirim ${media.type}.]\n` +
                `${text}`,

            base64Media:
                base64,

            mimeTypeMedia:
                mime
        };
    } catch (error) {
        console.error(
            '[MEDIA DOWNLOAD ERROR]',
            safeError(error)
        );

        return {
            finalPrompt:
                `${vgenPrompt}\n\n` +
                `[Sistem: Media pengguna tidak berhasil diambil. Jawab berdasarkan caption/teks jika tersedia.]\n` +
                `${text}`,

            base64Media: null,

            mimeTypeMedia: null
        };
    }
}

/* ============================================================
   GEMINI API
   ============================================================ */

async function askGemini(
    chatId,
    finalPrompt,
    base64Media,
    mimeTypeMedia,
    sourceMessageId
) {
    /*
     * LOOP SELAMANYA.
     *
     * Kalau:
     *
     * Lite habis
     * -> Flash
     *
     * Flash habis
     * -> 3.5 Flash
     *
     * 3.5 Flash habis
     * -> email berikutnya + Lite
     *
     * email terakhir habis
     * -> email pertama + Lite
     */

    while (true) {
        const target =
            currentGeminiTarget();

        console.log(
            `[GEMINI] ${target.email} / ${target.model}`
        );

        const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
                target.model
            )}:generateContent?key=${encodeURIComponent(
                target.key
            )}`;

        const contents = [
            {
                role: 'user',
                parts: [
                    {
                        text:
                            finalPrompt
                    }
                ]
            }
        ];

        /*
         * Tambahkan media jika ada.
         */

        if (
            base64Media &&
            mimeTypeMedia
        ) {
            contents[0].parts.push({
                inline_data: {
                    mime_type:
                        mimeTypeMedia,

                    data:
                        base64Media
                }
            });
        }

        let response;

        try {
            response =
                await fetch(
                    url,
                    {
                        method: 'POST',

                        headers: {
                            'Content-Type':
                                'application/json'
                        },

                        body:
                            JSON.stringify({
                                contents
                            })
                    }
                );
        } catch (error) {
            /*
             * Network error:
             * jangan kirim error mentah.
             */

            console.error(
                '[GEMINI NETWORK ERROR]',
                safeError(error)
            );

            advanceGeminiTarget();

            await sleep(
                randomMs(
                    700,
                    1500
                )
            );

            continue;
        }

        let data = null;

        try {
            data =
                await response.json();
        } catch {
            data = null;
        }

        /* ====================================================
           SUCCESS
           ==================================================== */

        if (response.ok) {
            const text =
                data?.candidates?.[0]
                    ?.content
                    ?.parts
                    ?.map(
                        part =>
                            part?.text || ''
                    )
                    .join('')
                    .trim();

            if (text) {
                return text;
            }

            /*
             * Response kosong:
             * pindah target daripada membuat user
             * menerima error API.
             */

            console.warn(
                '[GEMINI EMPTY RESPONSE]',
                target.model
            );

            advanceGeminiTarget();

            await sleep(
                randomMs(
                    500,
                    1200
                )
            );

            continue;
        }

        /* ====================================================
           QUOTA / RATE LIMIT
           ==================================================== */

        if (
            isQuotaOrRateLimitError(
                response.status,
                data
            )
        ) {
            console.warn(
                `[GEMINI QUOTA] ${target.email} / ${target.model}`
            );

            /*
             * Pindah model / akun TERLEBIH DAHULU.
             */

            advanceGeminiTarget();

            /*
             * Kirim sequence ke Telegram.
             *
             * Sequence hanya berisi:
             *
             * ⏳Loading
             * Server penuh, tunggu sebentar...
             * AI Berevolusi kembali✅
             */

            await sendFailoverSequence(
                chatId,
                sourceMessageId
            );

            /*
             * PENTING:
             * continue membuat pesan user yang sama
             * dicoba kembali ke target baru.
             */

            continue;
        }

        /* ====================================================
           SERVER OVERLOAD
           ==================================================== */

        if (
            response.status === 503
        ) {
            console.warn(
                `[GEMINI 503] ${target.model}`
            );

            advanceGeminiTarget();

            await sleep(
                randomMs(
                    500,
                    1200
                )
            );

            continue;
        }

        /* ====================================================
           ERROR LAIN
           ==================================================== */

        console.error(
            `[GEMINI ${response.status}]`,
            safeError(data)
        );

        /*
         * Error mentah TIDAK PERNAH dikirim ke Telegram.
         *
         * Tetap pindah target supaya bot tidak berhenti.
         */

        advanceGeminiTarget();

        await sleep(
            randomMs(
                500,
                1200
            )
        );
    }
}

/* ============================================================
   OPENAI
   ============================================================ */

async function askOpenAI(
    chatId,
    finalPrompt,
    base64Media,
    mimeTypeMedia
) {
    const accounts =
        Array.isArray(
            secretConfig.openaiAccounts
        )
            ? secretConfig.openaiAccounts
            : [];

    if (!accounts.length) {
        throw new Error(
            'OpenAI belum diaktifkan dari HTML.'
        );
    }

    /*
     * OpenAI menggunakan akun pertama yang tersedia.
     * Gemini memiliki failover model/account seperti
     * yang diminta.
     */

    const account =
        accounts[0];

    const content = [];

    content.push({
        type: 'text',
        text: finalPrompt
    });

    if (
        base64Media &&
        mimeTypeMedia &&
        mimeTypeMedia.startsWith(
            'image/'
        )
    ) {
        content.push({
            type: 'image_url',

            image_url: {
                url:
                    `data:${mimeTypeMedia};base64,${base64Media}`
            }
        });
    }

    const response =
        await fetch(
            'https://api.openai.com/v1/responses',
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json',

                    Authorization:
                        `Bearer ${account.key}`
                },

                body:
                    JSON.stringify({
                        model:
                            OPENAI_MODEL,

                        input: [
                            {
                                role:
                                    'user',

                                content
                            }
                        ]
                    })
            }
        );

    let data = null;

    try {
        data =
            await response.json();
    } catch {
        data = null;
    }

    if (!response.ok) {
        console.error(
            `[OPENAI ${response.status}]`,
            safeError(data)
        );

        throw new Error(
            'OpenAI request failed.'
        );
    }

    /*
     * Responses API output.
     */

    let outputText =
        data?.output_text;

    if (
        !outputText &&
        Array.isArray(data?.output)
    ) {
        outputText =
            data.output
                .flatMap(
                    item =>
                        Array.isArray(
                            item?.content
                        )
                            ? item.content
                            : []
                )
                .map(
                    part =>
                        part?.text || ''
                )
                .join('');
    }

    return cleanText(
        outputText
    );
}

/* ============================================================
   AI ROUTER
   ============================================================ */

async function askAI(
    chatId,
    finalPrompt,
    base64Media,
    mimeTypeMedia,
    sourceMessageId
) {
    if (!activeProvider) {
        throw new Error(
            'Provider AI belum diaktifkan.'
        );
    }

    if (
        activeProvider ===
        'GEMINI'
    ) {
        return askGemini(
            chatId,
            finalPrompt,
            base64Media,
            mimeTypeMedia,
            sourceMessageId
        );
    }

    if (
        activeProvider ===
        'OPENAI'
    ) {
        return askOpenAI(
            chatId,
            finalPrompt,
            base64Media,
            mimeTypeMedia
        );
    }

    throw new Error(
        'Provider AI tidak dikenal.'
    );
}

/* ============================================================
   PROCESS AI MESSAGE
   ============================================================ */

async function processAIMessage(
    msg,
    finalPrompt,
    base64Media,
    mimeTypeMedia
) {
    const chatId =
        String(msg.chat.id);

    /*
     * Kalau belum ada provider:
     * jangan kirim pesan konfigurasi ke Telegram.
     */

    if (!activeProvider) {
        return;
    }

    const stopRecordingPresence =
        startRecordingPresence(
            chatId
        );

    try {
        const response =
            await askAI(
                chatId,
                finalPrompt,
                base64Media,
                mimeTypeMedia,
                msg.message_id
            );

        const rawResponse =
            cleanText(response) ||
            '😭 AI nggak menghasilkan jawaban kali ini.';

        pushHistory(
            chatId,
            'user',
            finalPrompt
        );

        pushHistory(
            chatId,
            'assistant',
            rawResponse
        );

        /*
         * Jawaban final tetap reply ke pesan user.
         */

        await sendReply(
            bot,
            msg.chat.id,
            rawResponse,
            {
                reply_to_message_id:
                    msg.message_id
            }
        );
    } catch (error) {
        console.error(
            '[AI CORE ERROR]',
            safeError(error)
        );

        /*
         * Detail error API / token / quota
         * TIDAK PERNAH dikirim ke Telegram.
         */

        await sendReply(
            bot,
            msg.chat.id,
            '😵 Server AI lagi penuh sebentar. Coba kirim lagi ya.',
            {
                reply_to_message_id:
                    msg.message_id
            }
        );
    } finally {
        stopRecordingPresence();
    }
}

/* ============================================================
   CALLBACK BUTTON
   ============================================================ */

bot.on(
    'callback_query',
    async (query) => {
        const data =
            String(
                query.data || ''
            );

        const chatId =
            String(
                query.message
                    ?.chat
                    ?.id || ''
            );

        try {
            await bot.answerCallbackQuery(
                query.id
            );

            if (
                !chatId ||
                !data.startsWith(
                    'ask|'
                )
            ) {
                return;
            }

            const action =
                data
                    .slice(4)
                    .trim();

            if (!action) {
                return;
            }

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
            console.error(
                '[CALLBACK ERROR]',
                safeError(error)
            );

            if (chatId) {
                try {
                    await sendReply(
                        bot,
                        chatId,
                        '😵 Server AI lagi penuh sebentar. Coba lagi.'
                    );
                } catch {}
            }
        }
    }
);

/* ============================================================
   TELEGRAM MESSAGE
   ============================================================ */

bot.on(
    'message',
    async (msg) => {
        const text =
            cleanText(
                msg.text ||
                msg.caption ||
                ''
            );

        if (
            !text &&
            !getMediaFromMessage(msg)
        ) {
            return;
        }

        if (isCommand(text)) {
            return;
        }

        const chatId =
            String(msg.chat.id);

        if (
            aiMutedChats.has(
                chatId
            )
        ) {
            return;
        }

        /*
         * Abaikan pesan Telegram yang terlalu lama.
         */

        if (
            msg.date &&
            Math.floor(
                Date.now() / 1000
            ) -
                msg.date >
                120
        ) {
            return;
        }

        try {
            const mediaResult =
                await buildMediaPrompt(
                    msg,
                    text ||
                        '[Sistem: Pengguna mengirim media tanpa caption.]'
                );

            const currentTimeInstruction =
                `[INFO SISTEM: Waktu sekarang ${nowWIB()} WIB.]`;

            const finalPrompt =
                `${currentTimeInstruction}\n\n${mediaResult.finalPrompt}`;

            await processAIMessage(
                msg,
                finalPrompt,
                mediaResult.base64Media,
                mediaResult.mimeTypeMedia
            );
        } catch (error) {
            console.error(
                '[MESSAGE ERROR]',
                safeError(error)
            );

            try {
                await sendReply(
                    bot,
                    msg.chat.id,
                    '😵 Server AI lagi penuh sebentar. Coba kirim lagi ya.',
                    {
                        reply_to_message_id:
                            msg.message_id
                    }
                );
            } catch {}
        }
    }
);

/* ============================================================
   EXPRESS SERVER
   ============================================================ */

const app =
    express();

app.use(cors());

app.use(
    express.json({
        limit: '2mb'
    })
);

/* ============================================================
   PUBLIC CONFIG
   API KEY TIDAK PERNAH DIKEMBALIKAN.
   ============================================================ */

app.get(
    '/public-config',
    (req, res) => {
        res.json({
            ok: true,

            provider:
                activeProvider,

            gemini: {
                accounts:
                    (
                        secretConfig
                            .geminiAccounts ||
                        []
                    ).map(
                        a => ({
                            email:
                                a.email
                        })
                    ),

                models:
                    [
                        ...GEMINI_MODELS
                    ],

                currentAccountIndex:
                    geminiAccountIndex,

                currentModelIndex:
                    geminiModelIndex
            },

            openai: {
                accounts:
                    (
                        secretConfig
                            .openaiAccounts ||
                        []
                    ).map(
                        a => ({
                            email:
                                a.email
                        })
                    ),

                model:
                    OPENAI_MODEL
            }
        });
    }
);

/* ============================================================
   ACTIVATE PROVIDER
   HTML -> LOCAL NODE
   ============================================================ */

app.post(
    '/activate-provider',
    (req, res) => {
        const provider =
            String(
                req.body
                    ?.provider ||
                    ''
            ).toUpperCase();

        if (
            ![
                'GEMINI',
                'OPENAI'
            ].includes(
                provider
            )
        ) {
            return res
                .status(400)
                .json({
                    ok: false,
                    error:
                        'Provider tidak valid.'
                });
        }

        const incomingGemini =
            Array.isArray(
                req.body
                    ?.geminiAccounts
            )
                ? req.body.geminiAccounts
                : [];

        const incomingOpenAI =
            Array.isArray(
                req.body
                    ?.openaiAccounts
            )
                ? req.body.openaiAccounts
                : [];

        /*
         * Normalisasi email + key.
         */

        const normalize =
            (arr) =>
                arr
                    .map(
                        item => ({
                            email:
                                String(
                                    item
                                        ?.email ||
                                    ''
                                ).trim(),

                            key:
                                String(
                                    item
                                        ?.key ||
                                    ''
                                ).trim()
                        })
                    )
                    .filter(
                        item =>
                            item.email &&
                            item.key
                    );

        /* ====================================================
           GEMINI
           ==================================================== */

        if (
            provider ===
            'GEMINI'
        ) {
            const accounts =
                normalize(
                    incomingGemini
                );

            if (
                !accounts.length
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,

                        error:
                            'Gemini belum memiliki API key di HTML.'
                    });
            }

            secretConfig
                .geminiAccounts =
                accounts;

            /*
             * Pertahankan posisi failover
             * selama masih valid.
             */

            if (
                geminiAccountIndex >=
                accounts.length
            ) {
                geminiAccountIndex =
                    0;
            }

            if (
                geminiModelIndex >=
                GEMINI_MODELS.length
            ) {
                geminiModelIndex =
                    0;
            }
        }

        /* ====================================================
           OPENAI
           ==================================================== */

        if (
            provider ===
            'OPENAI'
        ) {
            const accounts =
                normalize(
                    incomingOpenAI
                );

            if (
                !accounts.length
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,

                        error:
                            'OpenAI belum memiliki API key di HTML.'
                    });
            }

            secretConfig
                .openaiAccounts =
                accounts;
        }

        activeProvider =
            provider;

        saveDb();

        const target =
            provider ===
            'GEMINI'
                ? currentGeminiTarget()
                : null;

        res.json({
            ok: true,

            provider:
                activeProvider,

            model:
                target?.model ||
                OPENAI_MODEL,

            account:
                target?.email ||
                secretConfig
                    .openaiAccounts[0]
                    ?.email ||
                null
        });
    }
);

/* ============================================================
   BACKWARD COMPATIBILITY
   ============================================================

   Endpoint lama tetap ada supaya HTML lama tidak langsung
   meledak.

   TAPI:
   endpoint ini TIDAK menerima standalone API key.
   ============================================================ */

app.post(
    '/deploy-key',
    (req, res) => {
        const provider =
            String(
                req.body
                    ?.provider ||
                    ''
            ).toUpperCase();

        if (
            ![
                'GEMINI',
                'OPENAI'
            ].includes(
                provider
            )
        ) {
            return res
                .status(400)
                .json({
                    ok: false,

                    error:
                        'Provider tidak valid.'
                });
        }

        const accounts =
            provider ===
            'GEMINI'
                ? secretConfig
                    .geminiAccounts
                : secretConfig
                    .openaiAccounts;

        if (
            !accounts?.length
        ) {
            return res
                .status(400)
                .json({
                    ok: false,

                    error:
                        'Aktifkan provider dari HTML terlebih dahulu.'
                });
        }

        activeProvider =
            provider;

        saveDb();

        res.json({
            ok: true,

            provider:
                activeProvider,

            model:
                provider ===
                'GEMINI'
                    ? GEMINI_MODELS[
                        geminiModelIndex
                    ]
                    : OPENAI_MODEL
        });
    }
);

/* ============================================================
   ROOT STATUS
   ============================================================ */

app.get(
    '/',
    (req, res) => {
        let target = null;

        if (
            activeProvider ===
            'GEMINI' &&
            secretConfig
                .geminiAccounts
                .length
        ) {
            target =
                currentGeminiTarget();
        }

        res.json({
            ok: true,

            service:
                'VGen AI Telegram Bot',

            provider:
                activeProvider,

            model:
                target?.model ||
                (
                    activeProvider ===
                    'OPENAI'
                        ? OPENAI_MODEL
                        : null
                ),

            timeWIB:
                nowWIB()
        });
    }
);

/* ============================================================
   START SERVER
   ============================================================ */

app.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log(
            `✅ VGEN AI TELEGRAM ONLINE di port ${PORT}`
        );

        console.log(
            `🤖 Provider saat startup: ${
                activeProvider ||
                'BELUM DIAKTIFKAN'
            }`
        );

        if (
            activeProvider ===
                'GEMINI' &&
            secretConfig
                .geminiAccounts
                .length
        ) {
            const t =
                currentGeminiTarget();

            console.log(
                `🔄 Gemini failover siap: ${t.email} / ${t.model}`
            );
        } else {
            console.log(
                '🟦 Menunggu aktivasi provider dari HTML localhost.'
            );
        }
    }
);