import nodeFetch from 'node-fetch';
import OpenAI from 'openai';
import { db } from '../db/memory.js';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

const deepseek = DEEPSEEK_API_KEY
    ? new OpenAI({ baseURL: DEEPSEEK_BASE_URL, apiKey: DEEPSEEK_API_KEY })
    : null;

// Fallback si no se puede leer el roster en vivo.
const FALLBACK_ASSETS = ['BTCUSD', 'EURUSD', 'US100', 'XAUUSD'];

// Noticias relevantes para FX / macro / oro / índices (el universo del bot).
const NEWS_QUERIES = [
    'forex dollar euro yen',
    'central bank interest rates inflation',
    'gold price',
    'European Asian stock markets indices'
];

const STOPWORDS = new Set([
    'the','a','an','is','are','was','were','be','been','being','has','have','had',
    'do','does','did','will','would','could','should','can','may','might',
    'of','in','on','at','to','for','as','by','with','and','or','but','its','it',
    'this','that','these','those','what','which','who','whom','how','why','when','where',
    'say','says','said','more','after','before','amid','over','under','into','from',
    'up','down','out','vs','new','top','week','ahead'
]);

// Titulares irrelevantes para el trading del bot: mineras, joyería, ETFs,
// nombres de compañía (Ltd/Inc/Corp/PLC), tickers y resultados corporativos.
const IRRELEVANT_PATTERNS: RegExp[] = [
    /\b(mining|miner|mines)\b/i,
    /\b(jewelr|jewellery|jewelry|dhanteras|hallmark|bullion)\b/i,
    /\b(ltd|inc|corp|plc|llc)\b/i,
    /\b(nse:|bse:|nyse:|nasdaq:|lse:)\b/i,
    /\b(gold trust|etf|exchange-traded)\b/i,
    /\b(net income|net profit|revenue|dividend|market cap|share price|eps)\b/i,
    /\b(rupee|rupees|inr|rs|lakh|crore|bhari|taka)\b/i
];

function tokenize(s: string): Set<string> {
    return new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const union = a.size + b.size - inter;
    return inter / union;
}

function isIrrelevant(title: string): boolean {
    return IRRELEVANT_PATTERNS.some(re => re.test(title));
}

async function fetchYahooPrice(symbol: string): Promise<number | null> {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
        const res = await nodeFetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const data: any = await res.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        return typeof price === 'number' ? price : null;
    } catch (e: any) {
        console.error(`[YAHOO] Error fetching price for ${symbol}:`, e.message);
        return null;
    }
}

/** Activos que el bot opera EN VIVO (assetSessionConfigs con enabled=true y sin disabledReason). */
async function getLiveAssets(): Promise<string[]> {
    try {
        const { globalState } = await import('../db/trading.js');
        const assets = [...(globalState.assetSessionConfigs as Map<string, any>).entries()]
            .filter(([k, c]) => k !== 'GLOBAL' && c?.enabled === true && !c?.disabledReason)
            .map(([k]) => k);
        return assets.length > 0 ? assets : FALLBACK_ASSETS;
    } catch (e: any) {
        console.error('[FINNHUB] Error leyendo roster en vivo:', e?.message ?? e);
        return FALLBACK_ASSETS;
    }
}

/** Titulares vía Google News RSS (gratis, sin key). */
async function fetchGoogleNews(query: string): Promise<Array<{ title: string; source: string; pubDate: string }>> {
    try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
        const res = await nodeFetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const xml = await res.text();
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
        return items.map(m => {
            const b = m[1];
            const rawTitle = (b.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
            const source = (b.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '').trim();
            const pubDate = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
            let title = rawTitle;
            if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(3 + source.length));
            return { title, source, pubDate };
        }).filter(x => x.title && x.title !== 'Google News');
    } catch (e: any) {
        console.error('[NEWS] Error Google News RSS:', e?.message ?? e);
        return [];
    }
}

/** Junta noticias de las consultas FX/macro/oro/índices, dedupe y ordena por fecha. */
async function fetchRelevantNews(): Promise<Array<{ time: string; source: string; text: string; impact: 'high' | 'medium' }>> {
    const collected: Array<{ title: string; source: string; pubDate: string }> = [];
    for (const q of NEWS_QUERIES) {
        const r = await fetchGoogleNews(q);
        collected.push(...r);
        if (r.length === 0) await new Promise(res => setTimeout(res, 500));
    }

    // 1. Filtrar titulares irrelevantes (mineras, joyería, compañías, tickers)
    const relevant = collected.filter(n => !isIrrelevant(n.title));

    // 2. Dedupe difuso por solapamiento de tokens significativos (misma noticia, distinta fuente)
    const kept: Array<{ title: string; source: string; pubDate: string }> = [];
    const keptTokens: Set<string>[] = [];
    for (const n of relevant) {
        const tk = tokenize(n.title);
        if (tk.size === 0) continue;
        const dup = keptTokens.some(kt => jaccard(tk, kt) >= 0.7);
        if (dup) continue;
        kept.push(n);
        keptTokens.push(tk);
    }

    kept.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));

    const mapped = kept.map(n => ({
        time: n.pubDate ? new Date(n.pubDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--',
        source: n.source || 'Market',
        text: n.title,
        impact: (/\b(fed|ecb|boj|boe|rate|rates|inflation|cpi|nfp|gdp|central bank|interest)\b/i.test(n.title) ? 'high' : 'medium') as 'high' | 'medium'
    }));

    if (mapped.length > 0) return mapped;

    // Fallback a Finnhub general
    try {
        const res = await nodeFetch(`https://finnhub.io/api/v1/news?category=general&token=${process.env.FINNHUB_API_KEY || ''}`);
        const newsData: any = await res.json();
        if (Array.isArray(newsData) && newsData.length > 0) {
            return newsData.slice(0, 12).map((n: any) => ({
                time: new Date(n.datetime * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                source: n.source,
                text: n.headline,
                impact: n.category === 'top news' ? 'high' : 'medium'
            }));
        }
    } catch (e: any) {
        console.error('[NEWS] Fallback Finnhub falló:', e?.message ?? e);
    }
    return [];
}

// ── Calendario económico (ForexFactory) ──────────────────────────────────────
interface EcoEventAnalysis {
    asset: string;
    beat: 'bullish' | 'bearish';
    miss: 'bullish' | 'bearish';
    reason: string;
}

interface EcoEvent {
    title: string;
    country: string;
    date: string;
    impact: string;
    forecast: string;
    previous: string;
    analysis?: EcoEventAnalysis[];
}

let lastCalendarAnalysis = 0;
const CALENDAR_INTERVAL = 2 * 60 * 60 * 1000; // re-analizar como mucho cada 2h (gentil con ForexFactory)

/** Eventos de alto impacto futuros (ForexFactory), con forecast, dedup por país+día. */
async function fetchEconomicCalendar(): Promise<EcoEvent[]> {
    try {
        const res = await nodeFetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const data: any[] = await res.json();
        if (!Array.isArray(data)) return [];

        const now = Date.now();
        // Alto + Medio impacto (el Medio aporta contenido en días flojos)
        const upcoming = data.filter(e => (e?.impact === 'High' || e?.impact === 'Medium') && Date.parse(e?.date || '') > now);
        // Solo cuantificables (con forecast); discursos/statements se omiten.
        const withForecast = upcoming.filter(e => e?.forecast && String(e.forecast).trim());

        const seen = new Map<string, EcoEvent>();
        const MAIN = /rate|decision|cpi|employment|gdp|non-farm|nfp|payroll|inflation/i;
        for (const e of withForecast) {
            const key = `${e.country}_${e.date.slice(0, 10)}`;
            const cur = seen.get(key);
            if (!cur) { seen.set(key, e); continue; }
            // preferir High sobre Medium, y el evento principal (tasa/CPI/empleo) sobre derivados
            if (e.impact === 'High' && cur.impact !== 'High') { seen.set(key, e); continue; }
            if (MAIN.test(e.title) && !MAIN.test(cur.title)) seen.set(key, e);
        }

        const byDate = (a: EcoEvent, b: EcoEvent) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0);
        const highs = [...seen.values()].filter(e => e.impact === 'High').sort(byDate);
        const mediums = [...seen.values()].filter(e => e.impact !== 'High').sort(byDate);
        // priorizar Alto impacto, completar con Medio hasta 10
        return [...highs, ...mediums].slice(0, 10);
    } catch (e: any) {
        console.error('[CAL] Error fetchEconomicCalendar:', e?.message ?? e);
        return [];
    }
}

/** Anticipación por evento: si el dato sale por encima/por debajo del forecast. */
async function analyzeEconomicCalendar(events: EcoEvent[], liveAssets: string[]): Promise<EcoEvent[]> {
    if (!deepseek || events.length === 0) return events;

    const prompt = `Eres un analista financiero cuantitativo. A continuación los próximos eventos económicos de ALTO impacto (con forecast y valor previo):

${events.map((e, idx) => `ID ${idx}: [${e.country}] ${e.title} (forecast ${e.forecast || '—'}, previous ${e.previous || '—'})`).join('\n')}

Activos que el bot opera EN VIVO:
${liveAssets.join(', ')}

Para CADA evento, determiná qué activos se ven afectados y en qué dirección si el dato SALE POR ENCIMA del forecast ("beat") o POR DEBAJO ("miss"). Para decisiones de tasas, "beat" = suba mayor a la esperada, "miss" = suba menor o recorte.

Responde ÚNICAMENTE con un objeto JSON válido (sin backticks de Markdown) con esta estructura:
{
  "event_analysis": {
    "0": [
      { "asset": "EURUSD", "beat": "bearish", "miss": "bullish", "reason": "razón breve en español" }
    ]
  }
}

Reglas estrictas:
- "beat" y "miss" SOLO pueden ser "bullish" o "bearish".
- Incluí únicamente activos con efecto claro; los neutrales se omiten.
- Generá un array "event_analysis" para TODOS los IDs.`;

    try {
        const completion = await deepseek.chat.completions.create({
            model: DEEPSEEK_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 12000
        });
        const responseText = completion.choices?.[0]?.message?.content || '';
        const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanJson);
        const ea = parsed.event_analysis || {};
        return events.map((e, idx) => ({
            ...e,
            analysis: (ea[String(idx)] ?? ea[idx]) || []
        }));
    } catch (e: any) {
        console.error('[CAL] Error DeepSeek calendario:', e?.message ?? e);
        return events;
    }
}

export async function updateFundamentals() {
    const { getCurrentSessionId } = await import('./backtesting.js');
    if (getCurrentSessionId()) {
        console.log('[FINNHUB] Backtesting active. Skipping fundamentals update.');
        return;
    }

    console.log('[FINNHUB] Actualizando datos fundamentales...');
    try {
        // Obtener macrodatos en paralelo
        let vixPrice: number | null = null;
        let dxyPrice: number | null = null;
        let us10yPrice: number | null = null;
        try {
            console.log('[YAHOO] Obteniendo macrodatos (VIX, DXY, US10Y)...');
            const [vix, dxy, us10y] = await Promise.all([
                fetchYahooPrice('^VIX'),
                fetchYahooPrice('DX-Y.NYB'),
                fetchYahooPrice('^TNX')
            ]);
            vixPrice = vix;
            dxyPrice = dxy;
            us10yPrice = us10y;
            console.log(`[YAHOO] Macrodatos obtenidos: VIX=${vixPrice}, DXY=${dxyPrice}, US10Y=${us10yPrice}`);
        } catch (e: any) {
            console.error('[FINNHUB] Error fetching Yahoo macro prices:', e.message);
        }

        // 1. Obtener noticias relevantes (FX / macro / oro / índices)
        const topNews = (await fetchRelevantNews()).slice(0, 10);

        if (topNews.length === 0) {
            console.warn('[FINNHUB] No se obtuvieron noticias relevantes.');
            if (db && (vixPrice !== null || dxyPrice !== null || us10yPrice !== null)) {
                const macroData: any = {};
                if (vixPrice !== null) macroData.vix = vixPrice;
                if (dxyPrice !== null) macroData.dxy = dxyPrice;
                if (us10yPrice !== null) macroData.us10y = us10yPrice;
                await db.collection('app_settings').doc('fundamentals').set({
                    last_updated: new Date().toISOString(),
                    macro: macroData
                }, { merge: true });
                console.log('[FINNHUB] Solo macrodatos guardados en Firebase debido a falta de noticias.');
            }
            return;
        }

        const liveAssets = await getLiveAssets();
        console.log(`[FINNHUB] Roster en vivo (${liveAssets.length}): ${liveAssets.join(', ')}`);
        console.log(`[FINNHUB] Analizando ${topNews.length} noticias relevantes...`);

        // 2. Análisis por-noticia × por-activo usando DeepSeek
        let newsAnalysis: Record<string, Array<{ asset: string; direction: 'bullish' | 'bearish'; reason: string }>> = {};
        let finalNews = [...topNews];
        let analysisOk = false;

        if (deepseek) {
            const prompt = `Eres un analista financiero cuantitativo experto. A continuación tienes titulares de noticias de mercado (en inglés):

${topNews.map((n: any, idx: number) => `ID ${idx}: [${n.source}] ${n.text}`).join('\n')}

Activos que el bot opera EN VIVO (analiza ÚNICAMENTE estos):
${liveAssets.join(', ')}

Para CADA titular realiza DOS tareas:
1. Tradúcelo al español de forma natural y precisa (manteniendo acrónimos como FOMC, Fed, CPI, NFP, BoE, BoJ).
2. Determina qué activos de la lista se ven afectados de forma CLARA y si el efecto es ALCISTA (bullish) o BAJISTA (bearish), con una razón breve en español (máx ~12 palabras). Si un activo no tiene efecto claro, OMÍTELO.

Responde ÚNICAMENTE con un objeto JSON válido (sin backticks de Markdown) con esta estructura exacta:
{
  "translations": {
    "0": "traducción del titular ID 0",
    "1": "traducción del titular ID 1"
  },
  "news_analysis": {
    "0": [
      { "asset": "EURUSD", "direction": "bullish", "reason": "razón breve en español" },
      { "asset": "XAUUSD", "direction": "bearish", "reason": "razón breve en español" }
    ],
    "1": [
      { "asset": "USDJPY", "direction": "bullish", "reason": "razón breve en español" }
    ]
  }
}

Reglas estrictas:
- "direction" SOLO puede ser "bullish" o "bearish".
- Incluye únicamente activos con efecto claro; los neutrales se omiten del array.
- Genera un array "news_analysis" para TODOS los IDs (puede ser un array vacío [] si la noticia no afecta a ningún activo).
- No inventes activos que no estén en la lista de "en vivo".`;

            for (let attempt = 1; attempt <= 3 && !analysisOk; attempt++) {
                try {
                    const completion = await deepseek.chat.completions.create({
                        model: DEEPSEEK_MODEL,
                        messages: [{ role: 'user', content: prompt }],
                        temperature: 0.2,
                        max_tokens: 12000
                    });
                    const responseText = completion.choices?.[0]?.message?.content || '';

                    const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                    const parsed = JSON.parse(cleanJson);

                    newsAnalysis = parsed.news_analysis || {};

                    finalNews = topNews.map((n: any, idx: number) => {
                        const translatedText = parsed.translations?.[String(idx)] ?? parsed.translations?.[idx];
                        const analysis = (newsAnalysis[String(idx)] ?? newsAnalysis[idx]) || [];
                        return { ...n, text: translatedText || n.text, analysis };
                    });
                    analysisOk = true;
                    console.log(`[FINNHUB] DeepSeek analizó ${topNews.length} noticias para ${liveAssets.length} activos (intento ${attempt}).`);
                } catch (e: any) {
                    console.error(`[FINNHUB] Error DeepSeek (intento ${attempt}):`, e?.message ?? e);
                    if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
                }
            }
        } else {
            console.warn('[FINNHUB] DEEPSEEK_API_KEY no configurada. Noticias sin análisis.');
        }

        // 3. Guardar en Firebase
        if (db) {
            const macroData: any = {};
            if (vixPrice !== null) macroData.vix = vixPrice;
            if (dxyPrice !== null) macroData.dxy = dxyPrice;
            if (us10yPrice !== null) macroData.us10y = us10yPrice;

            const payload: any = {
                last_updated: new Date().toISOString(),
                macro: macroData
            };
            // Solo pisar las noticias si el análisis DeepSeek tuvo éxito (evita dejar titulares sin analizar).
            if (analysisOk) payload.news = finalNews;

            await db.collection('app_settings').doc('fundamentals').set(payload, { merge: true });
            console.log(analysisOk
                ? '[FINNHUB] Datos fundamentales (con análisis por-activo) guardados en Firebase.'
                : '[FINNHUB] Análisis DeepSeek falló; se guardan solo macrodatos (noticias previas intactas).');
        }

        // 4. Calendario económico (anticipar eventos de alto impacto)
        if (db && Date.now() - lastCalendarAnalysis >= CALENDAR_INTERVAL) {
            try {
                const events = await fetchEconomicCalendar();
                if (events.length > 0) {
                    const analyzed = await analyzeEconomicCalendar(events, liveAssets);
                    await db.collection('app_settings').doc('economic_calendar').set({
                        last_updated: new Date().toISOString(),
                        events: analyzed
                    }, { merge: true });
                    lastCalendarAnalysis = Date.now();
                    console.log(`[CAL] Calendario económico: ${analyzed.length} eventos guardados.`);
                }
            } catch (e: any) {
                console.error('[CAL] Error calendario económico:', e?.message ?? e);
            }
        }
    } catch (error: any) {
        console.error('[FINNHUB] Error en updateFundamentals:', error?.message ?? error);
    }
}
