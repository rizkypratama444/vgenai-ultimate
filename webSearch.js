const TAVILY_API_KEY = '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';
const SERPER_API_KEY = 'e52de145383e7437e28cf88e262a1264f96d1243';

const MAX_SEARCH_RESULTS = 5;
const REQUEST_TIMEOUT = 15000;
const MAX_QUERY_LENGTH = 500;

const SEARCH_CONFIG = {
    tavilyApiKey: TAVILY_API_KEY.trim(),
    serperApiKey: SERPER_API_KEY.trim(),
    maxResults: MAX_SEARCH_RESULTS
};

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

async function searchWeb(query) {
    const config = await loadWebSearchConfig();
    const errors = [];

    try {
        const results = await searchTavily(query, config);

        if (results.length > 0) {
            console.log(`[WEB SEARCH] Tavily berhasil: ${results.length} hasil`);

            return {
                provider: 'Tavily',
                results: results.slice(0, MAX_SEARCH_RESULTS)
            };
        }

        errors.push('Tavily: hasil kosong');
    } catch (error) {
        errors.push(`Tavily: ${error.message}`);
        console.warn(`[WEB SEARCH] Tavily gagal: ${error.message}`);
    }

    try {
        const results = await searchSerper(query, config);

        if (results.length > 0) {
            console.log(`[WEB SEARCH] Serper berhasil: ${results.length} hasil`);

            return {
                provider: 'Serper',
                results: results.slice(0, MAX_SEARCH_RESULTS)
            };
        }

        errors.push('Serper: hasil kosong');
    } catch (error) {
        errors.push(`Serper: ${error.message}`);
        console.warn(`[WEB SEARCH] Serper gagal: ${error.message}`);
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

    const keywords = [
        'terbaru',
        'terkini',
        'sekarang',
        'saat ini',
        'hari ini',
        'hariini',
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
        'update terbaru',
        'info terbaru',
        'informasi terbaru',
        'kabar terbaru',
        'berita terbaru',
        'data terbaru',
        'versi terbaru',
        'harga terbaru',
        'status terbaru',
        'rilis terbaru',
        'release terbaru',
        'perkembangan terbaru',
        'kejadian terbaru',
        'peristiwa terbaru',
        'laporan terbaru',
        'sumber terbaru',
        'fakta terbaru',
        'hasil terbaru',
        'hasil hari ini',
        'berita hari ini',
        'kabar hari ini',
        'info hari ini',
        'informasi hari ini',
        'data hari ini',
        'status hari ini',
        'update hari ini',
        'latest',
        'latest news',
        'latest update',
        'latest version',
        'latest release',
        'latest information',
        'latest info',
        'latest data',
        'latest price',
        'latest result',
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
        'next week',
        'next month',
        'next year',
        'newest',
        'just now',
        'breaking',
        'breaking news',
        'live update',
        'live news',
        'real time',
        'realtime',

        'berita',
        'kabar',
        'headline',
        'news',
        'news today',
        'news terbaru',
        'news terkini',
        'what happened',
        'what is happening',
        'apa yang terjadi',
        'apa kabar',
        'kejadian',
        'peristiwa',
        'laporan',
        'laporan hari ini',
        'laporan terbaru',
        'berita terkini',
        'berita nasional',
        'berita internasional',
        'berita dunia',
        'berita teknologi',
        'berita ekonomi',
        'berita politik',
        'berita olahraga',
        'berita bisnis',
        'berita game',
        'berita gadget',
        'berita crypto',
        'berita saham',
        'berita sepak bola',
        'berita film',
        'berita musik',

        'klasemen',
        'peringkat liga',
        'peringkat',
        'top skor',
        'top assist',
        'pencetak gol',
        'live score',
        'live skor',
        'score live',
        'skor langsung',
        'hasil pertandingan',
        'hasil match',
        'hasil laga',
        'hasil pertandingan hari ini',
        'pertandingan',
        'pertandingan hari ini',
        'pertandingan besok',
        'jadwal pertandingan',
        'jadwal match',
        'jadwal laga',
        'jadwal bola',
        'jadwal sepak bola',
        'jadwal pertandingan hari ini',
        'jadwal pertandingan besok',
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
        'fixture',
        'match result',
        'match results',
        'football results',
        'football standings',
        'football schedule',
        'transfer news',
        'player transfer',
        'sports news',
        'sport news',
        'olahraga terbaru',
        'berita olahraga',
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

        'harga bitcoin',
        'harga btc',
        'harga ethereum',
        'harga eth',
        'harga crypto',
        'harga kripto',
        'harga saham',
        'harga emas',
        'harga dolar',
        'kurs dolar',
        'kurs usd',
        'kurs eur',
        'kurs jpy',
        'kurs gbp',
        'kurs aud',
        'kurs sgd',
        'kurs idr',
        'nilai tukar',
        'exchange rate',
        'exchange rates',
        'stock price',
        'share price',
        'bitcoin price',
        'btc price',
        'crypto price',
        'crypto prices',
        'ethereum price',
        'eth price',
        'gold price',
        'gold price today',
        'forex',
        'forex rate',
        'market price',
        'market prices',
        'market update',
        'market today',
        'saham',
        'saham hari ini',
        'saham terbaru',
        'crypto',
        'kripto',
        'bitcoin',
        'ethereum',
        'emas',
        'dolar',
        'rupiah',
        'kurs',
        'valas',
        'investasi',
        'inflasi',
        'suku bunga',
        'bank indonesia',
        'bi rate',
        'fed rate',
        'interest rate',

        'cuaca',
        'prakiraan cuaca',
        'ramalan cuaca',
        'cuaca hari ini',
        'cuaca sekarang',
        'cuaca besok',
        'cuaca minggu ini',
        'hujan hari ini',
        'hujan sekarang',
        'akan hujan',
        'bakal hujan',
        'kemungkinan hujan',
        'suhu sekarang',
        'suhu hari ini',
        'temperature',
        'weather',
        'weather today',
        'weather now',
        'weather tomorrow',
        'weather forecast',
        'forecast',
        'rain forecast',
        'temperature today',
        'temperature now',

        'versi terbaru',
        'versi sekarang',
        'rilis terbaru',
        'release terbaru',
        'update software',
        'update aplikasi',
        'update android',
        'update ios',
        'versi android',
        'versi ios',
        'versi windows',
        'versi linux',
        'versi macos',
        'github terbaru',
        'github release',
        'github releases',
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
        'software update',
        'latest version',
        'latest release',
        'latest update',
        'latest software',
        'github update',
        'npm update',
        'node update',
        'android update',
        'ios update',
        'windows update',
        'macos update',
        'linux update',
        'chrome update',
        'firefox update',
        'browser update',
        'security update',
        'framework terbaru',
        'library terbaru',
        'package terbaru',
        'dependency terbaru',
        'npm package',
        'javascript terbaru',
        'nodejs',
        'react terbaru',
        'nextjs terbaru',
        'next.js terbaru',
        'python terbaru',
        'typescript terbaru',

        'cari info',
        'carikan info',
        'cari informasi',
        'carikan informasi',
        'cari berita',
        'carikan berita',
        'cari di internet',
        'carikan di internet',
        'cari online',
        'carikan online',
        'cari web',
        'carikan web',
        'search web',
        'web search',
        'search internet',
        'internet search',
        'look up',
        'search for',
        'find information',
        'find info',
        'find out',
        'lookup',
        'cek di internet',
        'cek online',
        'cek web',
        'cek internet',
        'tolong cari',
        'tolong carikan',
        'tolong cek online',
        'tolong cek internet',
        'coba cari',
        'coba cek',
        'bisa cari',
        'bisa cek',
        'bantu cari',
        'bantu cek',
        'cari tahu',
        'carikan tahu',
        'kasih info terbaru',
        'kasih informasi terbaru',
        'kasih berita terbaru',
        'minta info terbaru',
        'minta informasi terbaru',
        'minta berita terbaru',
        'search it',
        'search this',
        'search that',
        'search online',
        'search the web',
        'search the internet',
        'find online',
        'find on google',
        'google it',
        'google search',
        'cek google',
        'cari google',
        'carikan google',
        'telusuri',
        'telusurin',
        'telusuri internet',
        'telusuri web',
        'browsing',
        'browse web',
        'browse internet',
        'web lookup',
        'online lookup',
        'internet lookup',
        'verify online',
        'verifikasi online',
        'cek sumber',
        'cek sumber online',
        'cek faktanya',
        'cek fakta',
        'fact check',
        'fact-check',
        'verify this',
        'verify that',
        'benar gak',
        'benar nggak',
        'bener gak',
        'bener nggak',
        'apakah benar',
        'apakah ini benar',
        'emang benar',
        'emang bener',

        'harga',
        'berapa harga',
        'berapa harganya',
        'biaya terbaru',
        'tarif terbaru',
        'rate terbaru',
        'price today',
        'price now',
        'cost today',
        'current price',

        'siapa sekarang',
        'siapa yang sekarang',
        'siapa terbaru',
        'siapa pemimpin',
        'siapa presiden',
        'siapa ceo',
        'siapa direktur',
        'siapa pemain',
        'siapa pelatih',

        'kapan',
        'kapan rilis',
        'kapan tayang',
        'kapan keluar',
        'kapan launching',
        'kapan launch',
        'jadwal rilis',
        'release date',
        'release schedule',
        'launch date',
        'launching date',
        'air date',
        'premiere date',

        'dimana sekarang',
        'di mana sekarang',
        'lokasi sekarang',
        'location now',
        'where is',
        'where are',
        'status sekarang',
        'status saat ini',
        'current status',
        'live status',

        'film terbaru',
        'film sekarang',
        'movie terbaru',
        'movie release',
        'series terbaru',
        'tv series terbaru',
        'anime terbaru',
        'anime episode',
        'episode terbaru',
        'episode baru',
        'game terbaru',
        'game release',
        'game update',
        'game news',
        'steam update',
        'playstation update',
        'xbox update',
        'nintendo update',
        'music release',
        'album terbaru',
        'lagu terbaru',
        'konser terbaru',
        'event terbaru',

        'restoran terbaru',
        'tempat terbaru',
        'wisata terbaru',
        'hotel terbaru',
        'promo terbaru',
        'diskon terbaru',
        'promo hari ini',
        'diskon hari ini',

        'earthquake',
        'gempa',
        'gempa terbaru',
        'gempa hari ini',
        'banjir',
        'banjir terbaru',
        'banjir hari ini',
        'gunung meletus',
        'erupsi',
        'erupsi terbaru',
        'tsunami',
        'bencana terbaru',
        'disaster news',

        'jadwal kereta',
        'jadwal pesawat',
        'jadwal penerbangan',
        'flight status',
        'flight schedule',
        'train schedule',
        'traffic',
        'macet',
        'kemacetan',
        'jalan ditutup',
        'road closure',
        'traffic update'
    ];

    return containsAny(value, keywords);
}

module.exports = {
    searchWeb,
    formatWebResultsForAI,
    shouldSearchWeb
};