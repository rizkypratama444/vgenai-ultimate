const TAVILY_API_KEY = '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';
const SERPER_API_KEY = 'e52de145383e7437e28cf88e262a1264f96d1243';

const MIN_SEARCH_RESULTS = 4;
const MAX_SEARCH_RESULTS = 10;
const REQUEST_TIMEOUT = 15000;
const MAX_QUERY_LENGTH = 500;
const SEARCH_CACHE_TTL = 90000;

const SEARCH_CONFIG = {
    tavilyApiKey: TAVILY_API_KEY.trim(),
    serperApiKey: SERPER_API_KEY.trim(),
    maxResults: MAX_SEARCH_RESULTS
};

function randomSearchResultLimit() {
    return Math.floor(
        Math.random() * (MAX_SEARCH_RESULTS - MIN_SEARCH_RESULTS + 1)
    ) + MIN_SEARCH_RESULTS;
}

function cleanQuery(query) {
    return String(query || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, MAX_QUERY_LENGTH);
}

function cleanText(value) {
    return String(value || '')
        .replace(/\r/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractUserQuestion(value) {
    let text = String(value || '').trim();

    if (!text) {
        return '';
    }

    const buttonMarker = text.match(
        /Permintaan pengguna dari tombol:\s*([\s\S]*)/i
    );

    if (buttonMarker && buttonMarker[1]) {
        text = buttonMarker[1];
    } else {
        const userMarker = text.match(
            /Permintaan pengguna:\s*([\s\S]*)/i
        );

        if (userMarker && userMarker[1]) {
            text = userMarker[1];
        }
    }

    text = text.replace(
        /\[INFO SISTEM:[\s\S]*?\]/gi,
        ' '
    );

    text = text.replace(
        /\[Sistem:[\s\S]*?\]/gi,
        ' '
    );

    text = text.replace(
        /<<<(?:BUTTONS|IMAGE|FILE):[\s\S]*?>>>/gi,
        ' '
    );

    text = text.replace(
        /\[WEB SEARCH.*?\]/gi,
        ' '
    );

    return cleanText(text);
}

function getWIBDateParts() {
    const now = new Date();

    const parts = new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone: 'Asia/Jakarta',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }
    ).formatToParts(now);

    const out = {};

    for (const part of parts) {
        if (part.type !== 'literal') {
            out[part.type] = part.value;
        }
    }

    return out;
}

function getWIBDateText() {
    const parts = getWIBDateParts();

    return `${parts.year}-${parts.month}-${parts.day}`;
}

function getWIBMonthText() {
    const date = new Date(
        `${getWIBDateText()}T00:00:00+07:00`
    );

    return new Intl.DateTimeFormat(
        'en-US',
        {
            timeZone: 'Asia/Jakarta',
            month: 'long',
            year: 'numeric'
        }
    ).format(date);
}

const ENTITY_ALIASES = [
    ['persija jakarta', 'Persija Jakarta'],
    ['persija', 'Persija Jakarta'],
    ['persib bandung', 'Persib Bandung'],
    ['persib', 'Persib Bandung'],
    ['persebaya', 'Persebaya Surabaya'],
    ['bali united', 'Bali United'],
    ['madura united', 'Madura United'],
    ['arema', 'Arema FC'],
    ['pss sleman', 'PSS Sleman'],
    ['psis semarang', 'PSIS Semarang'],
    ['persis solo', 'Persis Solo'],
    ['barito putera', 'Barito Putera'],
    ['dewa united', 'Dewa United'],
    ['borneo fc', 'Borneo FC'],
    ['borneo', 'Borneo FC'],
    ['malut united', 'Malut United'],
    ['persita', 'Persita Tangerang'],
    ['persik', 'Persik Kediri'],
    ['psm makassar', 'PSM Makassar'],
    ['real madrid', 'Real Madrid'],
    ['barcelona', 'Barcelona'],
    ['manchester united', 'Manchester United'],
    ['manchester city', 'Manchester City'],
    ['liverpool', 'Liverpool'],
    ['arsenal', 'Arsenal'],
    ['chelsea', 'Chelsea'],
    ['tottenham', 'Tottenham Hotspur'],
    ['bayern munich', 'Bayern Munich'],
    ['psg', 'Paris Saint-Germain'],
    ['juventus', 'Juventus'],
    ['inter milan', 'Inter Milan'],
    ['ac milan', 'AC Milan'],
    ['dortmund', 'Borussia Dortmund']
];

const SPORTS_TERMS = [
    'persija',
    'persib',
    'persebaya',
    'bali united',
    'madura united',
    'arema',
    'pss sleman',
    'psis',
    'persis',
    'barito putera',
    'dewa united',
    'borneo',
    'malut united',
    'persita',
    'persik',
    'psm',
    'real madrid',
    'barcelona',
    'manchester united',
    'manchester city',
    'liverpool',
    'arsenal',
    'chelsea',
    'tottenham',
    'bayern',
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
    'basketball',
    'sepak bola',
    'football',
    'soccer',
    'olahraga',
    'klasemen',
    'ranking',
    'peringkat',
    'standings',
    'skor',
    'score',
    'pertandingan',
    'match',
    'laga',
    'jadwal',
    'lawan',
    'pemain',
    'player',
    'transfer',
    'pelatih',
    'coach',
    'lineup',
    'line up',
    'starting xi',
    'formasi',
    'gol',
    'assist'
];

const SEARCH_INTENT_TERMS = [
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

const CURRENT_TERMS = [
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
    'realtime',
    'update',
    'release terbaru',
    'versi terbaru'
];

const SCHEDULE_TERMS = [
    'jadwal',
    'schedule',
    'fixture',
    'fixtures',
    'tanggal',
    'tanggal berapa',
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
    'besok lawan',
    'besok main',
    'hari apa main',
    'hari apa tanding',
    'upcoming',
    'upcoming match',
    'next match',
    'next game'
];

const NEWS_TERMS = [
    'berita',
    'kabar',
    'news',
    'headline',
    'kejadian',
    'peristiwa',
    'laporan',
    'perkembangan',
    'breaking news'
];

const MARKET_TERMS = [
    'harga',
    'price',
    'stok',
    'stock',
    'ready stock',
    'restock',
    'tersedia',
    'ketersediaan',
    'available',
    'availability',
    'promo',
    'diskon',
    'bitcoin',
    'btc',
    'ethereum',
    'eth',
    'crypto',
    'kripto',
    'saham',
    'gold',
    'emas',
    'dolar',
    'rupiah',
    'kurs',
    'nilai tukar',
    'exchange rate',
    'forex',
    'market'
];

const WEATHER_TERMS = [
    'cuaca',
    'hujan',
    'prakiraan',
    'ramalan cuaca',
    'suhu',
    'temperature',
    'weather',
    'forecast',
    'rain forecast'
];

const TECH_TERMS = [
    'versi terbaru',
    'versi sekarang',
    'rilis terbaru',
    'software terbaru',
    'update software',
    'update aplikasi',
    'update android',
    'update ios',
    'update windows',
    'update linux',
    'github terbaru',
    'github release',
    'npm terbaru',
    'npm version',
    'nodejs terbaru',
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
    'browser update',
    'security update',
    'javascript terbaru',
    'python terbaru',
    'typescript terbaru',
    'react terbaru',
    'nextjs terbaru'
];

const QUESTION_TERMS = [
    'apa',
    'siapa',
    'kapan',
    'dimana',
    'di mana',
    'berapa',
    'which',
    'who',
    'when',
    'where',
    'what',
    'how much',
    'how many',
    'who won',
    'who is winning',
    'who leads',
    'who is leading',
    'what happened',
    'when is',
    'where is',
    'who is'
];

const OFFICIAL_DOMAIN_SCORES = new Map([
    ['ileague.id', 18],
    ['persija.id', 18],
    ['liga.id', 14],
    ['ligaindonesiabaru.com', 14],
    ['pssi.org', 12],
    ['uefa.com', 12],
    ['fifa.com', 12],
    ['premierleague.com', 12],
    ['laliga.com', 12],
    ['bundesliga.com', 12],
    ['seriea.it', 12],
    ['nba.com', 12],
    ['nfl.com', 12],
    ['mlb.com', 12],
    ['motogp.com', 12]
]);

const SEARCH_CACHE = new Map();

function containsAny(value, list) {
    return list.some(
        item => value.includes(item)
    );
}

function getCanonicalEntities(text) {
    const value = String(text || '').toLowerCase();
    const found = [];

    for (const [alias, canonical] of ENTITY_ALIASES) {
        if (
            value.includes(alias) &&
            !found.includes(canonical)
        ) {
            found.push(canonical);
        }
    }

    return found.slice(0, 3);
}

function hasDatePattern(value) {
    return (
        /\b(?:tanggal|tgl)\s*\d{1,2}\b/i.test(value) ||
        /\b\d{1,2}\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b/i.test(value) ||
        /\b(?:19|20)\d{2}\b/i.test(value)
    );
}

function tokenize(value) {
    const stop = new Set([
        'yang',
        'dan',
        'atau',
        'di',
        'ke',
        'dari',
        'buat',
        'untuk',
        'ini',
        'itu',
        'apa',
        'siapa',
        'kapan',
        'dimana',
        'di mana',
        'dong',
        'deh',
        'nih',
        'sih',
        'lah',
        'kah',
        'the',
        'a',
        'an',
        'of',
        'to',
        'for',
        'and',
        'or',
        'is',
        'are'
    ]);

    return [
        ...new Set(
            String(value || '')
                .toLowerCase()
                .replace(
                    /[^a-z0-9\u00C0-\u024F]+/gi,
                    ' '
                )
                .split(/\s+/)
                .filter(
                    token =>
                        token.length >= 3 &&
                        !stop.has(token)
                )
        )
    ].slice(0, 24);
}

function buildSearchPlan(query, context = '') {
    const question =
        extractUserQuestion(query);

    const contextText =
        extractUserQuestion(context);

    const combined =
        cleanText(
            `${question} ${contextText}`
        );

    const value =
        combined.toLowerCase();

    const entities =
        getCanonicalEntities(combined);

    const hasSports =
        containsAny(
            value,
            SPORTS_TERMS
        );

    const hasSchedule =
        containsAny(
            value,
            SCHEDULE_TERMS
        );

    const hasNews =
        containsAny(
            value,
            NEWS_TERMS
        );

    const hasMarket =
        containsAny(
            value,
            MARKET_TERMS
        );

    const hasWeather =
        containsAny(
            value,
            WEATHER_TERMS
        );

    const hasTech =
        containsAny(
            value,
            TECH_TERMS
        );

    const hasCurrent =
        containsAny(
            value,
            CURRENT_TERMS
        );

    const hasQuestion =
        containsAny(
            value,
            QUESTION_TERMS
        );

    const hasDate =
        hasDatePattern(value);

    const explicit =
        containsAny(
            value,
            SEARCH_INTENT_TERMS
        );

    const scheduleSports =
        hasSports &&
        (
            hasSchedule ||
            hasDate ||
            /\b(?:lawan|vs|versus|main|tanding|bermain)\b/i.test(value)
        );

    const dateText =
        getWIBDateText();

    const monthText =
        getWIBMonthText();

    let anchor =
        entities.join(' ');

    if (!anchor) {
        anchor = question;
    }

    let primary;
    let secondary;

    if (scheduleSports) {
        primary =
            `${anchor} jadwal pertandingan terbaru upcoming fixture next match ${monthText} ${dateText} official`;

        secondary = entities.length
            ? `"${entities[0]}" jadwal pertandingan terbaru ${monthText} ${dateText} site:ileague.id OR site:${entities[0] === 'Persija Jakarta' ? 'persija.id' : 'liga.id'}`
            : `${question} jadwal pertandingan terbaru ${monthText} ${dateText} official`;
    } else if (
        hasSports &&
        (
            hasCurrent ||
            hasQuestion ||
            explicit
        )
    ) {
        primary =
            `${anchor} berita hasil skor klasemen pemain terbaru ${monthText} ${dateText}`;

        secondary = entities.length
            ? `"${entities[0]}" terbaru ${monthText} ${dateText} official`
            : `${question} terbaru ${monthText} ${dateText}`;
    } else if (
        hasNews ||
        explicit
    ) {
        primary =
            `${question} ${monthText} ${dateText} latest current official sources`;

        secondary =
            `${question} latest current ${dateText}`;
    } else if (hasMarket) {
        primary =
            `${question} current price availability ${dateText} official`;

        secondary =
            `${question} latest ${dateText}`;
    } else if (hasWeather) {
        primary =
            `${question} weather forecast ${dateText}`;

        secondary =
            `${question} current weather ${dateText}`;
    } else if (hasTech) {
        primary =
            `${question} latest official release ${dateText}`;

        secondary =
            `${question} latest update ${dateText}`;
    } else {
        primary =
            `${question || combined} ${dateText}`;

        secondary =
            `${question || combined} latest current`;
    }

    primary =
        cleanQuery(primary);

    secondary =
        cleanQuery(secondary);

    return {
        question,
        context: contextText,
        combined,
        entities,
        hasSports,
        hasSchedule,
        hasNews,
        hasMarket,
        hasWeather,
        hasTech,
        hasCurrent,
        hasQuestion,
        hasDate,
        explicit,
        scheduleSports,
        primary,
        secondary,
        preferredProvider:
            scheduleSports ||
            (
                hasSports &&
                hasCurrent
            )
                ? 'Serper'
                : 'Tavily'
    };
}

function shouldSearchWeb(
    text,
    context = ''
) {
    const plan =
        buildSearchPlan(
            text,
            context
        );

    const value =
        plan.combined.toLowerCase();

    if (!value) {
        return false;
    }

    if (plan.explicit) {
        return true;
    }

    if (plan.hasNews) {
        return true;
    }

    if (plan.scheduleSports) {
        return true;
    }

    if (
        plan.hasMarket &&
        (
            plan.hasCurrent ||
            plan.hasQuestion ||
            plan.explicit
        )
    ) {
        return true;
    }

    if (
        plan.hasWeather &&
        (
            plan.hasCurrent ||
            plan.hasQuestion ||
            plan.explicit
        )
    ) {
        return true;
    }

    if (
        plan.hasTech &&
        (
            plan.hasCurrent ||
            plan.hasQuestion ||
            plan.explicit
        )
    ) {
        return true;
    }

    if (
        plan.hasDate &&
        /\b(?:lawan|vs|versus|tanding|tandingan|main|bermain)\b/i.test(value)
    ) {
        return true;
    }

    if (
        plan.hasSchedule &&
        (
            plan.hasQuestion ||
            plan.hasCurrent ||
            plan.hasSports
        )
    ) {
        return true;
    }

    if (
        plan.hasCurrent &&
        plan.hasQuestion
    ) {
        return true;
    }

    return false;
}

function getDomain(url) {
    try {
        return new URL(url)
            .hostname
            .toLowerCase()
            .replace(/^www\./, '');
    } catch {
        return '';
    }
}

function isOfficialDomain(domain) {
    for (
        const key of OFFICIAL_DOMAIN_SCORES.keys()
    ) {
        if (
            domain === key ||
            domain.endsWith(`.${key}`)
        ) {
            return true;
        }
    }

    return false;
}

function domainScore(url) {
    const domain =
        getDomain(url);

    if (!domain) {
        return 0;
    }

    for (
        const [key, score]
        of OFFICIAL_DOMAIN_SCORES.entries()
    ) {
        if (
            domain === key ||
            domain.endsWith(`.${key}`)
        ) {
            return score;
        }
    }

    if (
        domain.endsWith('.go.id') ||
        domain.endsWith('.ac.id')
    ) {
        return 5;
    }

    return 0;
}

function normalizeResults(
    results,
    provider,
    maxResults
) {
    if (!Array.isArray(results)) {
        return [];
    }

    return results
        .filter(
            item =>
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
        .map(item => ({
            title:
                cleanText(
                    item.title ||
                    'Tanpa judul'
                ).slice(0, 300),

            url:
                String(
                    item.url ||
                    item.link ||
                    ''
                ).trim(),

            content:
                cleanText(
                    item.content ||
                    item.snippet ||
                    item.description ||
                    ''
                ).slice(0, 2500),

            provider
        }))
        .filter(
            item =>
                /^https?:\/\//i.test(
                    item.url
                )
        )
        .slice(0, maxResults);
}

async function fetchWithTimeout(
    url,
    options = {},
    timeout = REQUEST_TIMEOUT
) {
    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () => controller.abort(),
            timeout
        );

    try {
        return await fetch(
            url,
            {
                ...options,
                signal:
                    controller.signal
            }
        );
    } finally {
        clearTimeout(timer);
    }
}

async function searchTavily(
    query,
    config
) {
    if (!config.tavilyApiKey) {
        throw new Error(
            'Tavily API key kosong.'
        );
    }

    const res =
        await fetchWithTimeout(
            'https://api.tavily.com/search',
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json'
                },

                body:
                    JSON.stringify({
                        api_key:
                            config.tavilyApiKey,

                        query:
                            cleanQuery(
                                query
                            ),

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
        await res.json()
            .catch(() => ({}));

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

async function searchSerper(
    query,
    config
) {
    if (!config.serperApiKey) {
        throw new Error(
            'Serper API key kosong.'
        );
    }

    const res =
        await fetchWithTimeout(
            'https://google.serper.dev/search',
            {
                method: 'POST',

                headers: {
                    'X-API-KEY':
                        config.serperApiKey,

                    'Content-Type':
                        'application/json'
                },

                body:
                    JSON.stringify({
                        q:
                            cleanQuery(
                                query
                            ),

                        num:
                            config.maxResults
                    })
            }
        );

    const data =
        await res.json()
            .catch(() => ({}));

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

function resultRelevanceScore(
    item,
    plan
) {
    const text =
        `${item.title} ${item.content}`
            .toLowerCase();

    const tokens =
        tokenize(plan.question);

    let score = 0;

    for (const token of tokens) {
        if (text.includes(token)) {
            score +=
                token.length >= 6
                    ? 2
                    : 1;
        }
    }

    for (const entity of plan.entities) {
        if (
            text.includes(
                entity.toLowerCase()
            )
        ) {
            score += 9;
        }
    }

    if (plan.scheduleSports) {
        if (
            /(jadwal|schedule|fixture|fixtures|upcoming|next match|pertandingan|laga|match)/i.test(text)
        ) {
            score += 6;
        }

        if (
            /(vs|versus|lawan|kick[- ]?off|kickoff|19\d\d|20\d\d)/i.test(text)
        ) {
            score += 3;
        }

        if (
            isOfficialDomain(
                getDomain(item.url)
            )
        ) {
            score += 8;
        }
    }

    if (plan.hasSports) {
        if (
            /(sepak bola|football|soccer|liga|klasemen|standings|skor|score|pertandingan|match|laga)/i.test(text)
        ) {
            score += 3;
        }

        if (
            isOfficialDomain(
                getDomain(item.url)
            )
        ) {
            score += 5;
        }
    }

    if (
        plan.hasNews &&
        /(news|berita|headline|kabar|laporan|perkembangan)/i.test(text)
    ) {
        score += 3;
    }

    if (
        plan.hasMarket &&
        /(price|harga|promo|diskon|stock|stok|market|kurs|exchange)/i.test(text)
    ) {
        score += 3;
    }

    if (
        plan.hasWeather &&
        /(weather|cuaca|forecast|hujan|temperature|suhu)/i.test(text)
    ) {
        score += 3;
    }

    if (
        plan.hasTech &&
        /(release|update|version|versi|software|github|npm|node|api|library)/i.test(text)
    ) {
        score += 3;
    }

    const date =
        getWIBDateParts();

    if (
        text.includes(
            date.year
        )
    ) {
        score += 2;
    }

    if (
        plan.hasCurrent &&
        /(terbaru|latest|current|today|sekarang|hari ini|2026)/i.test(text)
    ) {
        score += 2;
    }

    score +=
        domainScore(
            item.url
        );

    return score;
}

function dedupeResults(
    results
) {
    const seen =
        new Set();

    const out = [];

    for (
        const item of results
    ) {
        const key =
            `${item.url.toLowerCase()}|${item.title.toLowerCase()}`;

        if (
            seen.has(key)
        ) {
            continue;
        }

        seen.add(key);
        out.push(item);
    }

    return out;
}

function rankResults(
    results,
    plan,
    maxResults
) {
    return dedupeResults(results)
        .map(
            (item, index) => ({
                ...item,
                _score:
                    resultRelevanceScore(
                        item,
                        plan
                    ),
                _index:
                    index
            })
        )
        .sort(
            (a, b) => {
                if (
                    b._score !==
                    a._score
                ) {
                    return (
                        b._score -
                        a._score
                    );
                }

                return (
                    a._index -
                    b._index
                );
            }
        )
        .slice(
            0,
            maxResults
        )
        .map(
            ({
                _score,
                _index,
                ...item
            }) => item
        );
}

function shouldFallback(
    results,
    plan
) {
    if (
        !Array.isArray(results) ||
        results.length === 0
    ) {
        return true;
    }

    const ranked =
        rankResults(
            results,
            plan,
            results.length
        );

    const strong =
        ranked.filter(
            item =>
                resultRelevanceScore(
                    item,
                    plan
                ) >=
                (
                    plan.scheduleSports
                        ? 11
                        : 7
                )
        ).length;

    if (
        plan.scheduleSports
    ) {
        const hasOfficial =
            ranked.some(
                item =>
                    isOfficialDomain(
                        getDomain(
                            item.url
                        )
                    ) &&
                    resultRelevanceScore(
                        item,
                        plan
                    ) >= 10
            );

        return (
            strong < 2 ||
            (
                !hasOfficial &&
                ranked.length >= 3
            )
        );
    }

    return (
        strong <
        Math.min(
            2,
            results.length
        )
    );
}

async function loadWebSearchConfig() {
    return SEARCH_CONFIG;
}

function isSearchCached(
    query,
    context = ''
) {
    const plan =
        buildSearchPlan(
            query,
            context
        );

    const cacheKey =
        plan.primary.toLowerCase();

    const cached =
        SEARCH_CACHE.get(
            cacheKey
        );

    return Boolean(
        cached &&
        Date.now() -
            cached.timestamp <
            SEARCH_CACHE_TTL
    );
}

async function searchWeb(
    query,
    context = ''
) {
    const plan =
        buildSearchPlan(
            query,
            context
        );

    if (!plan.primary) {
        throw new Error(
            'Query pencarian kosong.'
        );
    }

    const cacheKey =
        plan.primary.toLowerCase();

    const cached =
        SEARCH_CACHE.get(
            cacheKey
        );

    if (
        cached &&
        Date.now() -
            cached.timestamp <
            SEARCH_CACHE_TTL
    ) {
        console.log(
            `[WEB SEARCH] Cache hit: ${cached.data.searchQuery}`
        );

        return cached.data;
    }

    const maxResults =
        randomSearchResultLimit();

    const config = {
        ...SEARCH_CONFIG,
        maxResults
    };

    const providers =
        plan.preferredProvider === 'Serper'
            ? [
                ['Serper', searchSerper],
                ['Tavily', searchTavily]
            ]
            : [
                ['Tavily', searchTavily],
                ['Serper', searchSerper]
            ];

    const errors = [];
    let allResults = [];
    const usedProviders = [];

    try {
        const first =
            await providers[0][1](
                plan.primary,
                config
            );

        allResults =
            first;

        usedProviders.push(
            providers[0][0]
        );
    } catch (error) {
        errors.push(
            `${providers[0][0]}: ${error.message}`
        );

        console.warn(
            `[WEB SEARCH] ${providers[0][0]} gagal: ${error.message}`
        );
    }

    let ranked =
        rankResults(
            allResults,
            plan,
            maxResults
        );

    if (
        shouldFallback(
            ranked,
            plan
        )
    ) {
        try {
            const second =
                await providers[1][1](
                    plan.secondary,
                    config
                );

            allResults = [
                ...allResults,
                ...second
            ];

            usedProviders.push(
                providers[1][0]
            );

            ranked =
                rankResults(
                    allResults,
                    plan,
                    maxResults
                );
        } catch (error) {
            errors.push(
                `${providers[1][0]}: ${error.message}`
            );

            console.warn(
                `[WEB SEARCH] ${providers[1][0]} gagal: ${error.message}`
            );
        }
    }

    if (
        ranked.length === 0
    ) {
        throw new Error(
            `Semua provider web search gagal. ${errors.join(' | ')}`
        );
    }

    const data = {
        provider:
            usedProviders.join(' + ') ||
            'Web',

        resultLimit:
            maxResults,

        searchQuery:
            plan.primary,

        backupQuery:
            plan.secondary,

        results:
            ranked.slice(
                0,
                maxResults
            )
    };

    SEARCH_CACHE.set(
        cacheKey,
        {
            timestamp:
                Date.now(),

            data
        }
    );

    console.log(
        `[WEB SEARCH] ${data.provider} | ${data.results.length} hasil | ${plan.primary}`
    );

    return data;
}

function formatWebResultsForAI(
    searchData
) {
    if (
        !searchData ||
        !Array.isArray(
            searchData.results
        ) ||
        searchData.results.length === 0
    ) {
        return '';
    }

    const dateText =
        getWIBDateText();

    return [
        '[WEB SEARCH GROUNDING]',

        `Tanggal pencarian: ${dateText}`,

        `Query: ${searchData.searchQuery || ''}`,

        `Provider: ${searchData.provider || 'Web'}`,

        'Gunakan sumber di bawah sebagai bukti utama untuk fakta yang dapat berubah.',

        'Untuk jadwal, skor, klasemen, harga, stok, rilis, dan status terbaru, prioritaskan sumber resmi atau sumber yang paling langsung menjawab.',

        'Jika ada sumber resmi yang memberikan jawaban langsung, jangan mengatakan tidak tahu hanya karena pengetahuan model tidak memilikinya.',

        'Jika sumber berbeda, jelaskan perbedaannya dan jangan mencampur tanggal, jam, lawan, atau angka dari sumber yang berbeda tanpa dasar.',

        'Jangan mengarang detail yang tidak didukung hasil web.',

        '',

        ...searchData.results
            .slice(
                0,
                MAX_SEARCH_RESULTS
            )
            .map(
                (item, index) =>
                    [
                        `[SUMBER ${index + 1}]`,
                        `Provider: ${item.provider || 'Web'}`,
                        `Judul: ${item.title}`,
                        `URL: ${item.url}`,
                        `Isi: ${item.content}`
                    ].join('\n')
            )
    ].join('\n\n');
}

module.exports = {
    searchWeb,
    formatWebResultsForAI,
    shouldSearchWeb,
    isSearchCached
};