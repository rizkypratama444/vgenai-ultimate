// ============================================================
// 🌐 VGEN AI - WEB SEARCH ENGINE
// ============================================================
//
// CONFIG:
// Revamp Open AI x Gemini.html
//
// ALUR:
//
// Telegram
//    ↓
// vickyyvall.js
//    ↓
// webSearch.js
//    ↓
// baca config dari HTML LOCALHOST
//    ↓
// Tavily
//    ↓
// kalau gagal/kosong
//    ↓
// Serper
//    ↓
// maksimal 5 hasil
//
// ============================================================


// ============================================================
// ⚙️ CONFIG HTML LOCALHOST
// ============================================================
//
// GANTI PORT SESUAI SERVER HTML LU.
//
// CONTOH:
// http://127.0.0.1:3000/Revamp%20Open%20AI%20x%20Gemini.html
//
// Kalau HTML lu ada di:
// http://localhost:8080/Revamp%20Open%20AI%20x%20Gemini.html
//
// ubah URL di bawah.
//
// ============================================================

const fs = require('fs');
const path = require('path');

const LOCAL_HTML_PATH = path.join(
    __dirname,
    'Revamp Open AI x Gemini.html'
);


// ============================================================
// 🔢 DEFAULT LIMIT
// ============================================================

const DEFAULT_MAX_SEARCH_RESULTS = 5;


// ============================================================
// 🧠 CACHE CONFIG
// ============================================================
//
// Supaya bot TIDAK download HTML setiap kali user search.
//
// Config diambil sekali,
// lalu disimpan sementara di memory.
//
// ============================================================

let cachedConfig = null;
let configLoadedAt = 0;


// Refresh config setiap 10 menit.
const CONFIG_CACHE_TIME =
    10 * 60 * 1000;


// ============================================================
// 📥 LOAD CONFIG DARI HTML
// ============================================================
async function loadWebSearchConfig() {

    const now = Date.now();

    // Pakai cache kalau masih valid
    if (
        cachedConfig &&
        now - configLoadedAt < CONFIG_CACHE_TIME
    ) {
        return cachedConfig;
    }

    console.log(
        '[WEB SEARCH] Membaca config dari HTML lokal...'
    );

    // ========================================================
    // 📂 BACA FILE HTML LANGSUNG DARI FILESYSTEM
    // ========================================================

    let html;

    try {

        html = await fs.promises.readFile(
            LOCAL_HTML_PATH,
            'utf8'
        );

    } catch (error) {

        throw new Error(
            `HTML config tidak ditemukan: ${LOCAL_HTML_PATH}`
        );
    }


    // ========================================================
    // 🔎 CARI CONFIG
    // ========================================================

    const match = html.match(
        /<script[^>]*id=["']vgen-websearch-config["'][^>]*>([\s\S]*?)<\/script>/i
    );


    if (!match) {

        throw new Error(
            'Config vgen-websearch-config tidak ditemukan di HTML.'
        );
    }


    // ========================================================
    // 🧠 PARSE JSON
    // ========================================================

    let config;

    try {

        config = JSON.parse(
            match[1].trim()
        );

    } catch (error) {

        throw new Error(
            'Isi vgen-websearch-config bukan JSON yang valid.'
        );
    }


    // ========================================================
    // 🔐 VALIDASI API KEY
    // ========================================================

    if (!config.tavilyApiKey) {

        throw new Error(
            'Tavily API key tidak ditemukan di HTML.'
        );
    }


    if (!config.serperApiKey) {

        throw new Error(
            'Serper API key tidak ditemukan di HTML.'
        );
    }


    // ========================================================
    // 🔢 MAX RESULT
    // ========================================================

    const maxResults =
        Number(config.maxResults) ||
        DEFAULT_MAX_SEARCH_RESULTS;


    cachedConfig = {

        tavilyApiKey:
            String(
                config.tavilyApiKey
            ).trim(),

        serperApiKey:
            String(
                config.serperApiKey
            ).trim(),

        maxResults:
            Math.min(
                Math.max(
                    maxResults,
                    1
                ),
                5
            )
    };


    configLoadedAt = now;


    console.log(
        `[WEB SEARCH] Config HTML berhasil dibaca. Max hasil: ${cachedConfig.maxResults}`
    );


    return cachedConfig;
}

// ============================================================
// 🧹 CLEAN QUERY
// ============================================================

function cleanQuery(query) {

    return String(query || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 500);
}


// ============================================================
// 📦 NORMALIZE RESULTS
// ============================================================

function normalizeResults(
    results,
    provider,
    maxResults
) {

    if (!Array.isArray(results)) {
        return [];
    }


    return results

        .filter(item =>
            item &&
            (
                item.title ||
                item.url ||
                item.link ||
                item.content ||
                item.snippet ||
                item.description
            )
        )

        .slice(0, maxResults)

        .map(item => ({

            title: String(
                item.title ||
                'Tanpa judul'
            ),

            url: String(
                item.url ||
                item.link ||
                ''
            ),

            content: String(
                item.content ||
                item.snippet ||
                item.description ||
                ''
            ).slice(0, 2500),

            provider

        }));
}


// ============================================================
// 🔎 TAVILY
// ============================================================

async function searchTavily(
    query,
    config
) {

    if (!config.tavilyApiKey) {

        throw new Error(
            'Tavily API key kosong.'
        );
    }


    const q =
        cleanQuery(query);


    const res = await fetch(
        'https://api.tavily.com/search',
        {

            method: 'POST',

            headers: {
                'Content-Type': 'application/json'
            },

            body: JSON.stringify({

                api_key:
                    config.tavilyApiKey,

                query:
                    q,

                // Basic = hemat credit
                search_depth:
                    'basic',

                topic:
                    'general',

                max_results:
                    config.maxResults,

                include_answer:
                    false,

                include_raw_content:
                    false
            })
        }
    );


    const data =
        await res.json().catch(
            () => ({})
        );


    if (!res.ok) {

        throw new Error(

            data?.detail ||

            data?.error ||

            `Tavily HTTP ${res.status}`
        );
    }


    return normalizeResults(

        data.results,

        'Tavily',

        config.maxResults
    );
}


// ============================================================
// 🔎 SERPER
// ============================================================

async function searchSerper(
    query,
    config
) {

    if (!config.serperApiKey) {

        throw new Error(
            'Serper API key kosong.'
        );
    }


    const q =
        cleanQuery(query);


    const res = await fetch(
        'https://google.serper.dev/search',
        {

            method: 'POST',

            headers: {

                'X-API-KEY':
                    config.serperApiKey,

                'Content-Type':
                    'application/json'
            },

            body: JSON.stringify({

                q,

                num:
                    config.maxResults
            })
        }
    );


    const data =
        await res.json().catch(
            () => ({})
        );


    if (!res.ok) {

        throw new Error(

            data?.message ||

            data?.error ||

            `Serper HTTP ${res.status}`
        );
    }


    return normalizeResults(

        data.organic,

        'Serper',

        config.maxResults
    );
}


// ============================================================
// 🔄 MAIN SEARCH
// ============================================================
//
// PRIORITAS:
//
// 1. Load config HTML
// 2. Tavily
// 3. Kalau gagal/kosong → Serper
//
// SATU pertanyaan normalnya:
// = 1 request Tavily
//
// Kalau Tavily gagal:
// = bisa lanjut 1 request Serper
//
// ============================================================

async function searchWeb(query) {

    const config =
        await loadWebSearchConfig();


    const providers = [

        [
            'Tavily',
            () => searchTavily(
                query,
                config
            )
        ],

        [
            'Serper',
            () => searchSerper(
                query,
                config
            )
        ]

    ];


    const errors = [];


    for (
        const [name, searchFn]
        of providers
    ) {

        try {

            const results =
                await searchFn();


            if (
                Array.isArray(results) &&
                results.length > 0
            ) {

                console.log(

                    `[WEB SEARCH] ${name} berhasil: ${results.length} hasil`
                );


                return {

                    provider:
                        name,

                    results:
                        results.slice(
                            0,
                            config.maxResults
                        )
                };
            }


            errors.push(
                `${name}: hasil kosong`
            );


            console.warn(

                `[WEB SEARCH] ${name} hasil kosong, mencoba provider berikutnya...`
            );

        } catch (error) {

            errors.push(

                `${name}: ${error.message}`
            );


            console.warn(

                `[WEB SEARCH] ${name} gagal: ${error.message}`
            );
        }
    }


    throw new Error(

        `Semua provider web search gagal. ${errors.join(' | ')}`
    );
}


// ============================================================
// 🧠 FORMAT HASIL UNTUK GEMINI
// ============================================================

function formatWebResultsForAI(
    searchData
) {

    if (
        !searchData ||
        !Array.isArray(searchData.results) ||
        searchData.results.length === 0
    ) {

        return '';
    }


    return searchData.results

        .slice(
            0,
            DEFAULT_MAX_SEARCH_RESULTS
        )

        .map(
            (item, index) => {

                return [

                    `[SUMBER ${index + 1}]`,

                    `Provider: ${
                        item.provider || 'Web'
                    }`,

                    `Judul: ${
                        item.title
                    }`,

                    `URL: ${
                        item.url
                    }`,

                    `Isi: ${
                        item.content
                    }`

                ].join('\n');
            }
        )

        .join('\n\n');
}


// ============================================================
// 🧠 SMART WEB SEARCH TRIGGER
// ============================================================

function shouldSearchWeb(text) {

    const value =
        String(text || '')
            .toLowerCase()
            .trim();


    if (!value) {
        return false;
    }


    // ========================================================
    // 🔥 FRESH / CURRENT
    // ========================================================

    const freshKeywords = [

        'terbaru',
        'terkini',
        'sekarang',
        'saat ini',
        'hari ini',
        'barusan',
        'baru saja',
        'tadi',
        'kemarin',
        'besok',
        'minggu ini',
        'bulan ini',
        'tahun ini',
        'pekan ini',
        'belakangan ini',
        'akhir-akhir ini',
        'update terbaru',
        'info terbaru',
        'informasi terbaru',
        'kabar terbaru',
        'perkembangan terbaru',
        'berita terbaru',
        'data terbaru',
        'versi terbaru',
        'harga terbaru',
        'status terbaru',

        'latest',
        'recent',
        'recently',
        'right now',
        'currently',
        'current',
        'today',
        'tonight',
        'yesterday',
        'tomorrow',
        'this week',
        'this month',
        'this year',
        'newest',
        'just now',
        'breaking',
        'breaking news',
        'live update',
        'latest update'
    ];


    // ========================================================
    // 📰 NEWS
    // ========================================================

    const newsKeywords = [

        'berita',
        'kabar',
        'headline',
        'breaking news',
        'news',
        'latest news',
        'news today',
        'what happened',
        'apa yang terjadi',
        'kejadian terbaru',
        'peristiwa terbaru',
        'perkembangan terbaru',
        'laporan terbaru',
        'laporan hari ini',
        'berita terkini'
    ];


    // ========================================================
    // ⚽ SPORTS
    // ========================================================

    const sportsKeywords = [

        'klasemen',
        'peringkat liga',
        'top skor',
        'top assist',
        'pencetak gol',
        'live score',
        'live skor',
        'hasil pertandingan',
        'hasil match',
        'hasil laga',
        'pertandingan',
        'jadwal pertandingan',
        'jadwal match',
        'jadwal laga',
        'jadwal bola',
        'jadwal sepak bola',
        'transfer pemain',
        'transfer terbaru',
        'bursa transfer',
        'rumor transfer',
        'pemain baru',
        'pelatih baru',
        'cedera pemain',
        'starting eleven',
        'starting xi',
        'susunan pemain',
        'line up',
        'lineup',
        'formasi',
        'kartu merah',
        'kartu kuning',
        'gol',
        'assist',
        'football',
        'soccer',
        'league',
        'standings',
        'fixtures',
        'match result',
        'football results',
        'football standings',
        'football schedule',
        'transfer news',
        'player transfer',
        'sports news',
        'sport news',
        'olahraga terbaru',
        'berita olahraga'
    ];


    // ========================================================
    // 💰 HARGA / MARKET / FINANCE
    // ========================================================

    const financeKeywords = [

        'harga bitcoin',
        'harga btc',
        'harga ethereum',
        'harga eth',
        'harga crypto',
        'harga saham',
        'harga emas',
        'harga dolar',
        'kurs dolar',
        'kurs usd',
        'kurs eur',
        'kurs jpy',
        'exchange rate',
        'nilai tukar',
        'stock price',
        'share price',
        'bitcoin price',
        'crypto price',
        'ethereum price',
        'gold price',
        'forex',
        'market price',
        'harga terbaru'
    ];


    // ========================================================
    // 🌦️ WEATHER
    // ========================================================

    const weatherKeywords = [

        'cuaca',
        'prakiraan cuaca',
        'ramalan cuaca',
        'cuaca hari ini',
        'cuaca sekarang',
        'hujan hari ini',
        'akan hujan',
        'suhu sekarang',
        'temperature',
        'weather',
        'weather today',
        'weather now',
        'forecast'
    ];


    // ========================================================
    // 💻 TECH / SOFTWARE
    // ========================================================

    const techKeywords = [

        'versi terbaru',
        'rilis terbaru',
        'release terbaru',
        'update software',
        'update aplikasi',
        'update android',
        'update ios',
        'versi android',
        'versi ios',
        'github terbaru',
        'npm terbaru',
        'nodejs terbaru',
        'node js terbaru',
        'openai terbaru',
        'gemini terbaru',
        'api terbaru',
        'api update',
        'software update',
        'latest version',
        'latest release',
        'latest update',
        'github release',
        'npm version',
        'node version',
        'android version',
        'ios version'
    ];


    // ========================================================
    // 🔎 GENERAL SEARCH INTENT
    // ========================================================

    const searchIntentKeywords = [

        'cari info',
        'carikan info',
        'cari informasi',
        'carikan informasi',
        'cari berita',
        'carikan berita',
        'cari di internet',
        'carikan di internet',
        'cari online',
        'search web',
        'web search',
        'search internet',
        'look up',
        'search for',
        'find information',
        'find info',
        'cek di internet',
        'cek online',
        'tolong cari',
        'tolong cek online'
    ];


    // ========================================================
    // 🔥 CEK
    // ========================================================

    const allGroups = [

        freshKeywords,

        newsKeywords,

        sportsKeywords,

        financeKeywords,

        weatherKeywords,

        techKeywords,

        searchIntentKeywords

    ];


    for (
        const keywords
        of allGroups
    ) {

        for (
            const keyword
            of keywords
        ) {

            if (
                value.includes(
                    keyword
                )
            ) {

                return true;
            }
        }
    }


    return false;
}


// ============================================================
// 📤 EXPORT
// ============================================================

module.exports = {

    searchWeb,

    formatWebResultsForAI,

    shouldSearchWeb

};