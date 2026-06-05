import nodeFetch from 'node-fetch';
import { db } from '../db/memory.js';
import { generateResponse } from '../llm/client.js';

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';

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
        const res = await nodeFetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`);
        const newsData: any = await res.json();
        
        if (!Array.isArray(newsData) || newsData.length === 0) {
            console.warn('[FINNHUB] No se obtuvieron noticias validas.');
            // Si no hay noticias, guardar al menos los macrodatos si están disponibles
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
        const topNews = newsData.slice(0, 10).map(n => ({
            time: new Date(n.datetime * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            source: n.source,
            text: n.headline,
            impact: n.category === 'top news' ? 'high' : 'medium' // Estimación simple de impacto
        }));

        // 2. Analizar sentimiento y traducir noticias usando el LLM (Gemini)
        const prompt = `
Eres un analista financiero cuantitativo y traductor. A continuación te presento los últimos titulares de noticias del mercado en inglés:

${topNews.map((n, idx) => `ID ${idx}: [${n.source}] ${n.text}`).join('\n')}

Por favor realiza dos tareas:
1. Traduce cada uno de los titulares al español de manera natural, profesional y precisa (manteniendo acrónimos financieros conocidos como FOMC, Fed, CPI, NFP si aplica).
2. Analiza el sentimiento de mercado y el impacto probable para los siguientes activos:
   - BTCUSD (Bitcoin)
   - EURUSD (Euro/Dólar)
   - US100 (Nasdaq)
   - XAUUSD (Oro/Dólar)

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta, sin backticks de Markdown:
{
  "translations": {
    "0": "Traducción al español del titular ID 0",
    "1": "Traducción al español del titular ID 1",
    "2": "Traducción al español del titular ID 2",
    "3": "Traducción al español del titular ID 3",
    "4": "Traducción al español del titular ID 4",
    "5": "Traducción al español del titular ID 5",
    "6": "Traducción al español del titular ID 6",
    "7": "Traducción al español del titular ID 7",
    "8": "Traducción al español del titular ID 8",
    "9": "Traducción al español del titular ID 9"
  },
  "sentiment": {
    "BTCUSD": {
      "score": "75% BULLISH", // O BEARISH o NEUTRAL / MIXED
      "reason": "Explicación breve del motivo basado en las noticias (en español).",
      "status": "status-buy" // status-buy (alcista), status-sell (bajista), status-neutral, status-alert
    },
    "EURUSD": {
      "score": "60% BEARISH",
      "reason": "Explicación en español...",
      "status": "status-sell"
    },
    "US100": {
      "score": "NEUTRAL / MIXED",
      "reason": "Explicación en español...",
      "status": "status-alert"
    },
    "XAUUSD": {
      "score": "80% BULLISH",
      "reason": "Explicación en español...",
      "status": "status-buy"
    }
  }
}
        `;

        const llmResponse = await generateResponse([{ role: 'user', content: prompt }]);
        const responseText = llmResponse.content || '{}';
        
        let sentimentData = {};
        let finalNews = [...topNews];
        try {
            // Limpiar posible formato markdown del JSON
            const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            
            sentimentData = parsed.sentiment || {};
            
            // Si el LLM devolvió las traducciones, aplicarlas a las noticias
            if (parsed.translations) {
                finalNews = topNews.map((n, idx) => {
                    const translatedText = parsed.translations[String(idx)] || parsed.translations[idx];
                    return {
                        ...n,
                        text: translatedText || n.text
                    };
                });
            }
        } catch (e) {
            console.error('[FINNHUB] Error parseando respuesta del LLM:', responseText);
            // Valores por defecto si falla
            sentimentData = {
                BTCUSD: { score: "NEUTRAL", reason: "Error analizando sentimiento", status: "status-neutral" },
                EURUSD: { score: "NEUTRAL", reason: "Error analizando sentimiento", status: "status-neutral" },
                US100: { score: "NEUTRAL", reason: "Error analizando sentimiento", status: "status-neutral" },
                XAUUSD: { score: "NEUTRAL", reason: "Error analizando sentimiento", status: "status-neutral" }
            };
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
                sentiment: sentimentData,
                macro: macroData
            }, { merge: true });
            console.log('[FINNHUB] Datos fundamentales guardados en Firebase.');
        }
    } catch (error: any) {
        console.error('[FINNHUB] Error en updateFundamentals:', error.message);
    }
}
