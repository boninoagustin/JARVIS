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

        // 1. Obtener noticias de mercado general (Forex, Crypto, Stocks)
        const res = await nodeFetch(`https://finnhub.io/api/v1/news?category=general&token=${process.env.FINNHUB_API_KEY || ''}`);
        const newsData: any = await res.json();

        if (!Array.isArray(newsData) || newsData.length === 0) {
            console.warn('[FINNHUB] No se obtuvieron noticias validas.');
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

        // Tomar las 10 noticias más recientes para analizar
        const topNews = newsData.slice(0, 10).map((n: any) => ({
            time: new Date(n.datetime * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            source: n.source,
            text: n.headline,
            impact: n.category === 'top news' ? 'high' : 'medium'
        }));

        const liveAssets = await getLiveAssets();
        console.log(`[FINNHUB] Roster en vivo (${liveAssets.length}): ${liveAssets.join(', ')}`);

        // 2. Análisis por-noticia × por-activo usando DeepSeek
        let newsAnalysis: Record<string, Array<{ asset: string; direction: 'bullish' | 'bearish'; reason: string }>> = {};
        let finalNews = [...topNews];

        if (deepseek) {
            const prompt = `Eres un analista financiero cuantitativo experto. A continuación tienes los titulares de noticias de mercado (en inglés):

${topNews.map((n: any, idx: number) => `ID ${idx}: [${n.source}] ${n.text}`).join('\n')}

Activos que el bot opera EN VIVO (analiza ÚNICAMENTE estos):
${liveAssets.join(', ')}

Para CADA titular realiza DOS tareas:
1. Tradúcelo al español de forma natural y precisa (manteniendo acrónimos como FOMC, Fed, CPI, NFP).
2. Determina qué activos de la lista se ven afectados de forma CLARA y si el efecto es ALCISTA (bullish) o BAJISTA (bearish), con una razón breve en español (máx ~12 palabras). Si un activo no tiene efecto claro, OMÍTELO.

Responde ÚNICAMENTE con un objeto JSON válido (sin backticks de Markdown) con esta estructura exacta:
{
  "translations": {
    "0": "traducción del titular ID 0",
    "1": "traducción del titular ID 1"
  },
  "news_analysis": {
    "0": [
      { "asset": "BTCUSD", "direction": "bullish", "reason": "razón breve en español" },
      { "asset": "XAUUSD", "direction": "bearish", "reason": "razón breve en español" }
    ],
    "1": [
      { "asset": "EURUSD", "direction": "bullish", "reason": "razón breve en español" }
    ]
  }
}

Reglas estrictas:
- "direction" SOLO puede ser "bullish" o "bearish".
- Incluye únicamente activos con efecto claro; los neutrales se omiten del array.
- Genera un array "news_analysis" para TODOS los IDs (puede ser un array vacío [] si ninguna noticia afecta a ningún activo).
- No inventes activos que no estén en la lista de "en vivo".`;

            try {
                const completion = await deepseek.chat.completions.create({
                    model: DEEPSEEK_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.2,
                    max_tokens: 8000
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
                console.log(`[FINNHUB] DeepSeek analizó ${topNews.length} noticias para ${liveAssets.length} activos.`);
            } catch (e: any) {
                console.error('[FINNHUB] Error analizando noticias con DeepSeek:', e?.message ?? e);
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

            await db.collection('app_settings').doc('fundamentals').set({
                last_updated: new Date().toISOString(),
                news: finalNews,
                macro: macroData
            }, { merge: true });
            console.log('[FINNHUB] Datos fundamentales (con análisis por-activo) guardados en Firebase.');
        }
    } catch (error: any) {
        console.error('[FINNHUB] Error en updateFundamentals:', error?.message ?? error);
    }
}
