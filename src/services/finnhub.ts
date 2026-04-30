import nodeFetch from 'node-fetch';
import { db } from '../db/memory.js';
import { generateResponse } from '../llm/client.js';

const FINNHUB_API_KEY = 'd7pt291r01qosaaprsr0d7pt291r01qosaaprsrg';

export async function updateFundamentals() {
    console.log('[FINNHUB] Actualizando datos fundamentales...');
    try {
        // 1. Obtener noticias de mercado general (Forex, Crypto, Stocks)
        const res = await nodeFetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`);
        const newsData: any = await res.json();
        
        if (!Array.isArray(newsData) || newsData.length === 0) {
            console.warn('[FINNHUB] No se obtuvieron noticias validas.');
            return;
        }

        // Tomar las 10 noticias más recientes para analizar
        const topNews = newsData.slice(0, 10).map(n => ({
            time: new Date(n.datetime * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            source: n.source,
            text: n.headline,
            impact: n.category === 'top news' ? 'high' : 'medium' // Estimación simple de impacto
        }));

        // 2. Analizar sentimiento usando el LLM (Gemini)
        const prompt = `
Eres un analista financiero cuantitativo. A continuación te presento los últimos titulares de noticias del mercado:

${topNews.map(n => `- [${n.source}] ${n.text}`).join('\n')}

Por favor, analiza el sentimiento de mercado y el impacto probable para los siguientes activos:
1. BTCUSD (Bitcoin)
2. EURUSD (Euro/Dólar)
3. US100 (Nasdaq)

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta, sin backticks de Markdown:
{
  "BTCUSD": {
    "score": "75% BULLISH", // O BEARISH o NEUTRAL / MIXED
    "reason": "Explicación breve del motivo basado en las noticias.",
    "status": "status-buy" // status-buy (alcista), status-sell (bajista), status-neutral, status-alert
  },
  "EURUSD": {
    "score": "60% BEARISH",
    "reason": "...",
    "status": "status-sell"
  },
  "US100": {
    "score": "NEUTRAL / MIXED",
    "reason": "...",
    "status": "status-alert"
  }
}
        `;

        const llmResponse = await generateResponse([{ role: 'user', content: prompt }]);
        const responseText = llmResponse.content || '{}';
        
        let sentimentData = {};
        try {
            // Limpiar posible formato markdown del JSON
            const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            sentimentData = JSON.parse(cleanJson);
        } catch (e) {
            console.error('[FINNHUB] Error parseando respuesta del LLM:', responseText);
            // Valores por defecto si falla
            sentimentData = {
                BTCUSD: { score: "NEUTRAL", reason: "Error analizando sentimiento", status: "status-neutral" },
                EURUSD: { score: "NEUTRAL", reason: "Error analizando sentimiento", status: "status-neutral" },
                US100: { score: "NEUTRAL", reason: "Error analizando sentimiento", status: "status-neutral" }
            };
        }

        // 3. Guardar en Firebase
        if (db) {
            await db.collection('app_settings').doc('fundamentals').set({
                last_updated: new Date().toISOString(),
                news: topNews,
                sentiment: sentimentData
            }, { merge: true });
            console.log('[FINNHUB] Datos fundamentales guardados en Firebase.');
        }
    } catch (error: any) {
        console.error('[FINNHUB] Error en updateFundamentals:', error.message);
    }
}
