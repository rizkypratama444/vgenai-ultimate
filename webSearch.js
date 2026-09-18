const TAVILY_API_KEY = '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';
const SERPER_API_KEY = 'e52de145383e7437e28cf88e262a1264f96d1243';

const MIN_SEARCH_RESULTS = 4;
const MAX_SEARCH_RESULTS = 10;
const REQUEST_TIMEOUT = 15000;
const MAX_QUERY_LENGTH = 500;

const SEARCH_CONFIG = {
    tavilyApiKey: TAVILY_API_KEY.trim(),
    serperApiKey: SERPER_API_KEY.trim(),
    maxResults: MAX_SEARCH_RESULTS
};

function randomSearchResultLimit() {
    return Math.floor(
        Math.random() *
        (MAX_SEARCH_RESULTS - MIN_SEARCH_RESULTS + 1)
    ) + MIN_SEARCH_RESULTS;
}

function cleanQuery(query) {
    return String(query || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, MAX_QUERY_LENGTH);
}

async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

function normalizeResults(results, provider, maxResults) {
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
            title: String(item.title || 'Tanpa judul'),
            url: String(item.url || item.link || ''),
            content: String(
                item.content ||
                item.snippet ||
                item.description ||
                ''
            ).slice(0, 2500),
            provider
        }));
}

async function loadWebSearchConfig() {
    return SEARCH_CONFIG;
}

async function searchTavily(query, config) {
    if (!config.tavilyApiKey) {
        throw new Error('Tavily API key kosong.');
    }

    const q = cleanQuery(query);

    const res = await fetchWithTimeout(
        'https://api.tavily.com/search',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                api_key: config.tavilyApiKey,
                query: q,
                search_depth: 'basic',
                topic: 'general',
                max_results: config.maxResults,
                include_answer: false,
                include_raw_content: false
            })
        }
    );

    const data = await res.json().catch(() => ({}));

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

async function searchSerper(query, config) {
    if (!config.serperApiKey) {
        throw new Error('Serper API key kosong.');
    }

    const q = cleanQuery(query);

    const res = await fetchWithTimeout(
        'https://google.serper.dev/search',
        {
            method: 'POST',
            headers: {
                'X-API-KEY': config.serperApiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q,
                num: config.maxResults
            })
        }
    );

    const data = await res.json().catch(() => ({}));

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

const SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL = 60000;
const PREVIEW_TIMEOUT = 5000;

async function resolvePreviewImage(pageUrl) {
    if (!/^https?:\/\//i.test(String(pageUrl || ''))) {
        return '';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT);

    try {
        const response = await fetch(pageUrl, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 VGenAI Web Preview'
            }
        });

        if (!response.ok) {
            return '';
        }

        const contentType = response.headers.get('content-type') || '';

        if (!contentType.includes('text/html')) {
            return '';
        }

        const html = (await response.text()).slice(0, 300000);

        const patterns = [
            /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
            /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
            /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);

            if (!match || !match[1]) {
                continue;
            }

            try {
                return new URL(match[1], pageUrl).href;
            } catch {
                continue;
            }
        }

        return '';
    } catch {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

async function attachPreviewImages(results, maxResults = MAX_SEARCH_RESULTS) {
    const list = Array.isArray(results)
        ? results.slice(0, maxResults)
        : [];

    const enriched = await Promise.all(
        list.map(async item => ({
            ...item,
            imageUrl: await resolvePreviewImage(item.url)
        }))
    );

    return enriched;
}

function isSearchCached(query) {
    const cacheKey = cleanQuery(query).toLowerCase();

    if (!cacheKey) return false;

    const cached = SEARCH_CACHE.get(cacheKey);

    return Boolean(
        cached &&
        Date.now() - cached.timestamp < SEARCH_CACHE_TTL
    );
}

async function searchWeb(query) {
    const cacheKey = cleanQuery(query).toLowerCase();

    if (!cacheKey) {
        throw new Error('Query pencarian kosong.');
    }

    const cached = SEARCH_CACHE.get(cacheKey);

    if (
        cached &&
        Date.now() - cached.timestamp < SEARCH_CACHE_TTL
    ) {
        console.log('[WEB SEARCH] Menggunakan cache.');
        return cached.data;
    }

    const maxResults = randomSearchResultLimit();

    const config = {
        ...SEARCH_CONFIG,
        maxResults
    };

    const providers = [
        ['Tavily', searchTavily],
        ['Serper', searchSerper]
    ];

    const errors = [];

    for (const [name, searchFn] of providers) {
        try {
            const rawResults = await searchFn(query, config);

            if (
                Array.isArray(rawResults) &&
                rawResults.length > 0
            ) {
                const results = await attachPreviewImages(
                    rawResults,
                    maxResults
                );

                const data = {
                    provider: name,
                    resultLimit: maxResults,
                    results: results.slice(0, maxResults)
                };

                SEARCH_CACHE.set(cacheKey, {
                    timestamp: Date.now(),
                    data
                });

                console.log(
                    `[WEB SEARCH] ${name} berhasil: ${data.results.length} hasil`
                );

                return data;
            }

            errors.push(`${name}: hasil kosong`);
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

function formatWebResultsForAI(searchData) {
    if (
        !searchData ||
        !Array.isArray(searchData.results) ||
        searchData.results.length === 0
    ) {
        return '';
    }

    return searchData.results
        .slice(0, MAX_SEARCH_RESULTS)
        .map((item, index) => {
            return [
                `[SUMBER ${index + 1}]`,
                `Provider: ${item.provider || 'Web'}`,
                `Judul: ${item.title}`,
                `URL: ${item.url}`,
                `Isi: ${item.content}`
            ].join('\n');
        })
        .join('\n\n');
}

function containsAny(value, keywords) {
    return keywords.some(keyword => value.includes(keyword));
}

function shouldSearchWeb(text) {
    const value = String(text || '')
        .toLowerCase()
        .trim();

    if (!value) {
        return false;
    }

    const explicitSearchKeywords = [
        'cari',
        'carikan',
        'cariin',
        'tolong cari',
        'tolong carikan',
        'coba cari',
        'bisa cari',
        'bantu cari',
        'cari tahu',
        'cari info',
        'cari informasi',
        'cari berita',
        'cari di internet',
        'cari online',
        'cari web',
        'cek online',
        'cek internet',
        'cek web',
        'cek sumber',
        'cek fakta',
        'cek faktanya',
        'verifikasi',
        'browsing',
        'browse',
        'search',
        'search web',
        'search internet',
        'search online',
        'search the web',
        'search the internet',
        'google it',
        'google search',
        'lookup',
        'look up',
        'find online',
        'find information',
        'find info',
        'fact check',
        'fact-check',
        'verify'
    ];

    const currentKeywords = [
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
        'lusa',
        'minggu ini',
        'pekan ini',
        'bulan ini',
        'tahun ini',
        'minggu depan',
        'bulan depan',
        'tahun depan',
        'belakangan ini',
        'akhir akhir ini',
        'akhir-akhir ini',
        'latest',
        'recent',
        'recently',
        'currently',
        'current',
        'today',
        'tonight',
        'yesterday',
        'tomorrow',
        'this week',
        'this month',
        'this year',
        'right now',
        'just now',
        'breaking',
        'live',
        'real time',
        'realtime'
    ];

    const newsKeywords = [
        'berita',
        'berita terbaru',
        'berita terkini',
        'berita hari ini',
        'kabar',
        'kabar terbaru',
        'kabar hari ini',
        'news',
        'news today',
        'latest news',
        'breaking news',
        'headline',
        'kejadian',
        'peristiwa',
        'laporan',
        'perkembangan'
    ];

    const sportsKeywords = [
        'persija',
        'persib',
        'madura united',
        'bali united',
        'persebaya',
        'arema',
        'pss sleman',
        'psis',
        'persis solo',
        'barito putera',
        'dewa united',
        'borneo',
        'malut united',
        'semen padang',
        'psbs biak',
        'persita',
        'persik',
        'persis',
        'psm',
        'pso',
        'real madrid',
        'barcelona',
        'atletico madrid',
        'manchester united',
        'manchester city',
        'liverpool',
        'arsenal',
        'chelsea',
        'tottenham',
        'bayern munich',
        'psg',
        'juventus',
        'inter milan',
        'ac milan',
        'dortmund',
        'liga 1',
        'liga indonesia',
        'liga 2',
        'premier league',
        'la liga',
        'serie a',
        'bundesliga',
        'champions league',
        'europa league',
        'conference league',
        'nba',
        'nfl',
        'mlb',
        'nhl',
        'motogp',
        'formula 1',
        'formula one',
        'f1',
        'ufc',
        'boxing',
        'tennis',
        'badminton',
        'basket',
        'basketball',
        'sepak bola',
        'football',
        'soccer',
        'olahraga',
        'klasemen',
        'klasemen liga',
        'tabel liga',
        'tabel klasemen',
        'peringkat',
        'ranking',
        'standings',
        'posisi liga',
        'posisi klasemen',
        'top skor',
        'top assist',
        'skor',
        'score',
        'live score',
        'hasil pertandingan',
        'hasil laga',
        'hasil match',
        'pertandingan',
        'match',
        'laga',
        'jadwal',
        'jadwal pertandingan',
        'jadwal laga',
        'jadwal match',
        'jadwal bola',
        'jadwal sepak bola',
        'lawan',
        'lawan apa',
        'lawan siapa',
        'main lawan',
        'siapa lawannya',
        'siapa yang dilawan',
        'siapa yang menang',
        'siapa pemenang',
        'siapa juara',
        'siapa memimpin',
        'siapa pemimpin',
        'siapa nomor satu',
        'pemain',
        'player',
        'pemain terbaru',
        'transfer',
        'transfer pemain',
        'bursa transfer',
        'rumor transfer',
        'pelatih',
        'coach',
        'starting eleven',
        'starting xi',
        'line up',
        'lineup',
        'susunan pemain',
        'formasi',
        'cedera pemain',
        'kartu merah',
        'kartu kuning',
        'gol',
        'assist'
    ];

    const marketKeywords = [
        'harga',
        'harga terbaru',
        'harga sekarang',
        'harga hari ini',
        'price',
        'price today',
        'current price',
        'stok',
        'stock',
        'ready stock',
        'restock',
        'tersedia',
        'ketersediaan',
        'available',
        'availability',
        'in stock',
        'out of stock',
        'promo',
        'promo terbaru',
        'promo hari ini',
        'diskon',
        'diskon terbaru',
        'diskon hari ini',
        'bitcoin',
        'btc',
        'ethereum',
        'eth',
        'crypto',
        'kripto',
        'saham',
        'stock market',
        'emas',
        'gold',
        'dolar',
        'rupiah',
        'kurs',
        'nilai tukar',
        'exchange rate',
        'forex',
        'market'
    ];

    const scheduleKeywords = [
        'tanggal',
        'tanggal berapa',
        'tanggal berapa main',
        'tanggal main',
        'kapan main',
        'kapan pertandingan',
        'kapan laga',
        'kapan match',
        'kapan tanding',
        'jam berapa',
        'pukul berapa',
        'main jam berapa',
        'pertandingan jam berapa',
        'jadwal rilis',
        'release date',
        'release schedule',
        'launch date',
        'tayang kapan',
        'tayang jam berapa',
        'kapan tayang',
        'kapan keluar',
        'kapan rilis',
        'besok lawan',
        'besok main',
        'hari apa main',
        'hari apa tanding'
    ];

    const weatherKeywords = [
        'cuaca',
        'cuaca hari ini',
        'cuaca sekarang',
        'cuaca besok',
        'prakiraan cuaca',
        'ramalan cuaca',
        'hujan',
        'akan hujan',
        'bakal hujan',
        'suhu',
        'temperature',
        'weather',
        'weather today',
        'weather now',
        'weather tomorrow',
        'weather forecast',
        'forecast',
        'rain forecast'
    ];

    const techKeywords = [
        'versi terbaru',
        'versi sekarang',
        'rilis terbaru',
        'release terbaru',
        'software terbaru',
        'update software',
        'update aplikasi',
        'update android',
        'update ios',
        'update windows',
        'update linux',
        'update macos',
        'github terbaru',
        'github release',
        'npm terbaru',
        'npm version',
        'nodejs terbaru',
        'node js terbaru',
        'node version',
        'openai terbaru',
        'openai update',
        'gemini terbaru',
        'gemini update',
        'api terbaru',
        'api update',
        'package terbaru',
        'library terbaru',
        'dependency terbaru',
        'chrome update',
        'firefox update',
        'browser update',
        'security update',
        'javascript terbaru',
        'python terbaru',
        'typescript terbaru',
        'react terbaru',
        'nextjs terbaru'
    ];

    const questionKeywords = [
        'apa yang terjadi',
        'apa kabar terbaru',
        'apa update terbaru',
        'apa berita terbaru',
        'siapa yang menang',
        'siapa pemenang',
        'siapa juara',
        'siapa yang memimpin',
        'siapa pemimpin',
        'siapa nomor satu',
        'siapa peringkat pertama',
        'kapan',
        'dimana',
        'di mana',
        'where',
        'when',
        'who won',
        'who is winning',
        'who leads',
        'who is leading',
        'what happened',
        'what happened today',
        'when is',
        'where is',
        'who is'
    ];

    const hasExplicitSearch = explicitSearchKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasCurrentKeyword = currentKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasNewsKeyword = newsKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasSportsKeyword = sportsKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasMarketKeyword = marketKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasScheduleKeyword = scheduleKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasWeatherKeyword = weatherKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasTechKeyword = techKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasQuestionKeyword = questionKeywords.some(
        keyword => value.includes(keyword)
    );

    const hasDatePattern =
        /\b(?:tanggal|tgl)\s*\d{1,2}\b/i.test(value) ||
        /\b\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b/i.test(value) ||
        /\b(?:19|20)\d{2}\b/.test(value);

    const hasMatchPattern =
        /\b(?:lawan|vs|versus|tanding|tandingan|main|bermain)\b/i.test(value);

    const hasRankingPattern =
        /\b(?:klasemen|ranking|peringkat|posisi|standings|tabel)\b/i.test(value);

    const looksLikeCurrentSportsQuestion =
        hasSportsKeyword &&
        (
            hasCurrentKeyword ||
            hasScheduleKeyword ||
            hasDatePattern ||
            hasMatchPattern ||
            hasRankingPattern ||
            hasQuestionKeyword
        );

    const looksLikeCurrentDataQuestion =
        (
            hasMarketKeyword ||
            hasWeatherKeyword ||
            hasTechKeyword
        ) &&
        (
            hasCurrentKeyword ||
            hasQuestionKeyword ||
            hasExplicitSearch
        );

    return (
        hasExplicitSearch ||
        hasNewsKeyword ||
        looksLikeCurrentSportsQuestion ||
        looksLikeCurrentDataQuestion ||
        (hasDatePattern && hasQuestionKeyword) ||
        (hasDatePattern && hasMatchPattern) ||
        (hasScheduleKeyword && hasQuestionKeyword)
    );
}

module.exports = {
    searchWeb,
    formatWebResultsForAI,
    shouldSearchWeb,
    isSearchCached
};