/**
 * Investment Agent — Fundamental Analysis + Sentiment
 * 
 * Complements Kronos (technical prediction) with fundamental data:
 * - Market data from CoinGecko (crypto) or Yahoo Finance (forex/indices)
 * - Latest news via DuckDuckGo scraping
 * - LLM-powered synthesis with Gemini
 * 
 * Inspired by: awesome-llm-apps/ai_investment_agent
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

const geminiClient = config.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }) : null;

// ─── Interfaces ───

export interface MarketData {
    ticker: string;
    price: number;
    change24h: number;        // percentage
    volume24h: number;
    marketCap?: number;
    high24h?: number;
    low24h?: number;
    provider: string;
}

export interface InvestmentAnalysis {
    sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    confidence: number;       // 0-100
    summary: string;          // Summary in Spanish
    keyFactors: string[];     // Key factors driving the analysis
    newsHighlights: string[]; // Relevant headline snippets
}

// ─── Market Data Providers ───

/**
 * Fetch market data from CoinGecko (crypto assets).
 */
async function fetchCoinGeckoData(ticker: string): Promise<MarketData | null> {
    // Map common ticker names to CoinGecko IDs
    const COINGECKO_IDS: Record<string, string> = {
        'BTCUSD': 'bitcoin', 'BTCUSDT': 'bitcoin', 'XBTUSDT': 'bitcoin',
        'ETHUSD': 'ethereum', 'ETHUSDT': 'ethereum',
        'SOLUSD': 'solana', 'SOLUSDT': 'solana',
        'BNBUSD': 'binancecoin', 'BNBUSDT': 'binancecoin',
        'XRPUSD': 'ripple', 'XRPUSDT': 'ripple',
        'DOGEUSD': 'dogecoin', 'DOGEUSDT': 'dogecoin',
        'ADAUSD': 'cardano', 'ADAUSDT': 'cardano',
        'AVAXUSD': 'avalanche-2', 'AVAXUSDT': 'avalanche-2',
        'LINKUSD': 'chainlink', 'LINKUSDT': 'chainlink',
    };

    const cleanTicker = ticker.toUpperCase().replace(/\.P$/, '').replace(/PERP$/, '').replace(/[^A-Z0-9]/g, '');
    const coinId = COINGECKO_IDS[cleanTicker];
    
    if (!coinId) return null;

    try {
        const nodeFetch = (await import('node-fetch')).default;
        const res = await nodeFetch(
            `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`,
            { timeout: 10000 }
        );
        
        if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
        
        const data: any = await res.json();
        const market = data.market_data;
        
        return {
            ticker: cleanTicker,
            price: market.current_price?.usd || 0,
            change24h: market.price_change_percentage_24h || 0,
            volume24h: market.total_volume?.usd || 0,
            marketCap: market.market_cap?.usd,
            high24h: market.high_24h?.usd,
            low24h: market.low_24h?.usd,
            provider: 'CoinGecko'
        };
    } catch (error: any) {
        console.error(`[INVESTMENT] CoinGecko error for ${ticker}:`, error.message);
        return null;
    }
}

/**
 * Fetch market data from Yahoo Finance (forex, indices, commodities).
 */
async function fetchYahooData(ticker: string): Promise<MarketData | null> {
    const YAHOO_MAP: Record<string, string> = {
        'EURUSD': 'EURUSD=X', 'GBPUSD': 'GBPUSD=X', 'USDCAD': 'USDCAD=X',
        'USDJPY': 'USDJPY=X', 'AUDUSD': 'AUDUSD=X', 'NZDUSD': 'NZDUSD=X',
        'US100': 'NQ=F', 'NAS100': 'NQ=F', 'NDX': 'NQ=F',
        'US500': 'ES=F', 'SPX': 'ES=F', 'SP500': 'ES=F',
        'US30': 'YM=F', 'DJI': 'YM=F',
        'XAUUSD': 'GC=F', 'GOLD': 'GC=F', 'XAAUSD': 'GC=F',
        'XAGUSD': 'SI=F', 'SILVER': 'SI=F',
        'USOIL': 'CL=F', 'WTI': 'CL=F',
    };

    const cleanTicker = ticker.toUpperCase().replace(/\.P$/, '').replace(/PERP$/, '').replace(/[^A-Z0-9]/g, '');
    const yahooSymbol = YAHOO_MAP[cleanTicker];
    
    if (!yahooSymbol) return null;

    try {
        const nodeFetch = (await import('node-fetch')).default;
        const res = await nodeFetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=2d`,
            { timeout: 10000 }
        );
        
        if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
        
        const data: any = await res.json();
        const result = data.chart?.result?.[0];
        if (!result) return null;

        const meta = result.meta;
        const prevClose = meta.chartPreviousClose || meta.previousClose;
        const price = meta.regularMarketPrice;
        const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

        return {
            ticker: cleanTicker,
            price: price,
            change24h: parseFloat(change.toFixed(2)),
            volume24h: meta.regularMarketVolume || 0,
            high24h: meta.regularMarketDayHigh,
            low24h: meta.regularMarketDayLow,
            provider: 'Yahoo Finance'
        };
    } catch (error: any) {
        console.error(`[INVESTMENT] Yahoo error for ${ticker}:`, error.message);
        return null;
    }
}

// ─── News Fetcher ───

/**
 * Fetch latest news headlines about an asset using DuckDuckGo.
 */
async function fetchNews(ticker: string, maxResults: number = 5): Promise<string[]> {
    try {
        const nodeFetch = (await import('node-fetch')).default;
        // Search for trading-relevant news
        const query = `${ticker} trading news today`;
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        
        const res = await nodeFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });
        
        const html = await res.text();
        const results: string[] = [];
        
        // Extract snippets from DuckDuckGo HTML results
        const regex = /<a class="result__snippet[^>]*>(.*?)<\/a>/gs;
        let match;
        let count = 0;
        
        while ((match = regex.exec(html)) !== null && count < maxResults) {
            const snippet = match[1].replace(/<\/?[^>]+(>|$)/g, '').replace(/\s+/g, ' ').trim();
            if (snippet.length > 20) {
                results.push(snippet);
                count++;
            }
        }
        
        return results;
    } catch (error: any) {
        console.error(`[INVESTMENT] News fetch error:`, error.message);
        return [];
    }
}

// ─── Main Analysis Function ───

const INVESTMENT_PROMPT = `Eres un analista financiero experto. Dada la información de mercado y noticias de un activo, genera un análisis breve y conciso.

REGLAS:
- Responde SOLO en formato JSON válido, sin markdown ni backticks
- El JSON debe tener esta estructura exacta:
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": 0-100,
  "summary": "Resumen en español, máximo 2 oraciones",
  "keyFactors": ["factor1", "factor2", "factor3"]
}
- Sé directo y profesional
- Basa tu análisis en los datos proporcionados, no inventes`;

/**
 * Main entry point: analyze an asset with fundamental data + news + LLM synthesis.
 */
export async function analyzeInvestment(
    ticker: string, 
    direction: 'BUY' | 'SELL'
): Promise<InvestmentAnalysis> {
    console.log(`[INVESTMENT] Analyzing ${ticker} (${direction})...`);

    // 1. Fetch market data (try CoinGecko first, then Yahoo)
    let marketData = await fetchCoinGeckoData(ticker);
    if (!marketData) {
        marketData = await fetchYahooData(ticker);
    }

    // 2. Fetch news
    const news = await fetchNews(ticker);

    // 3. If no data at all, return neutral
    if (!marketData && news.length === 0) {
        console.warn(`[INVESTMENT] No data available for ${ticker}`);
        return {
            sentiment: 'NEUTRAL',
            confidence: 0,
            summary: `Sin datos fundamentales disponibles para ${ticker}.`,
            keyFactors: ['Sin datos de mercado', 'Sin noticias recientes'],
            newsHighlights: []
        };
    }

    // 4. Build context for LLM
    let context = `Activo: ${ticker}\nDirección del setup técnico: ${direction}\n\n`;
    
    if (marketData) {
        context += `DATOS DE MERCADO (${marketData.provider}):\n`;
        context += `- Precio actual: $${marketData.price}\n`;
        context += `- Cambio 24h: ${marketData.change24h > 0 ? '+' : ''}${marketData.change24h}%\n`;
        context += `- Volumen 24h: $${(marketData.volume24h / 1e6).toFixed(1)}M\n`;
        if (marketData.high24h) context += `- Máximo 24h: $${marketData.high24h}\n`;
        if (marketData.low24h) context += `- Mínimo 24h: $${marketData.low24h}\n`;
        if (marketData.marketCap) context += `- Market Cap: $${(marketData.marketCap / 1e9).toFixed(1)}B\n`;
    }

    if (news.length > 0) {
        context += `\nNOTICIAS RECIENTES:\n`;
        news.forEach((n, i) => context += `${i + 1}. ${n}\n`);
    }

    // 5. Synthesize with LLM
    if (!geminiClient) {
        return {
            sentiment: 'NEUTRAL',
            confidence: 30,
            summary: marketData 
                ? `${ticker}: $${marketData.price} (${marketData.change24h > 0 ? '+' : ''}${marketData.change24h}% 24h). Sin LLM para análisis profundo.`
                : `Sin datos para ${ticker}.`,
            keyFactors: marketData ? [`Cambio 24h: ${marketData.change24h}%`] : [],
            newsHighlights: news.slice(0, 3)
        };
    }

    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: [{ role: 'user', parts: [{ text: context }] }],
            config: {
                systemInstruction: INVESTMENT_PROMPT,
                maxOutputTokens: 300,
                temperature: 0.2
            }
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new Error('Empty LLM response');

        // Parse JSON response (handle potential markdown wrapping)
        const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            sentiment: parsed.sentiment || 'NEUTRAL',
            confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
            summary: parsed.summary || 'Análisis no disponible.',
            keyFactors: parsed.keyFactors || [],
            newsHighlights: news.slice(0, 3)
        };
    } catch (error: any) {
        console.error(`[INVESTMENT] LLM analysis error:`, error.message);
        return {
            sentiment: 'NEUTRAL',
            confidence: 20,
            summary: `Error en análisis LLM. Datos: ${ticker} $${marketData?.price || '?'} (${marketData?.change24h || '?'}% 24h)`,
            keyFactors: ['Error en síntesis LLM'],
            newsHighlights: news.slice(0, 3)
        };
    }
}

/**
 * Multi-Agent Swarm Analysis (Trading Committee)
 * Orchestrates 3 agents: Technical, Fundamental, and Risk Manager, 
 * synthesized by a CEO agent.
 */
export async function analyzeInvestmentSwarm(
    ticker: string, 
    direction: 'BUY' | 'SELL',
    accountBalance: number = 1000 // Default to $1000 if unknown
): Promise<string> {
    console.log(`[SWARM] Iniciando Comité de Inversión para ${ticker}...`);

    if (!geminiClient) {
        return "El Swarm requiere Gemini API configurada.";
    }

    // 1. Data Gathering Phase
    let marketData = await fetchCoinGeckoData(ticker);
    if (!marketData) marketData = await fetchYahooData(ticker);
    const news = await fetchNews(ticker);
    
    const marketContext = marketData ? `Precio: $${marketData.price}. Cambio 24h: ${marketData.change24h}%. Volumen: $${(marketData.volume24h / 1e6).toFixed(1)}M.` : 'Sin datos técnicos.';
    const newsContext = news.length > 0 ? news.join('\n') : 'Sin noticias recientes.';

    // 2. Swarm Execution (Parallel Agents)
    console.log(`[SWARM] Ejecutando agentes en paralelo...`);
    
    // Agent 1: Technical Analyst (Based on direction and market data)
    const technicalPrompt = `Eres el Analista Técnico Principal. Evalúa el activo ${ticker}.
El usuario sugiere una dirección de trade: ${direction}.
Datos actuales: ${marketContext}
Dame un veredicto técnico muy breve (1-2 oraciones) y tu nivel de confianza en este setup (0-100%).`;

    // Agent 2: Fundamental/Sentiment Analyst (Based on news)
    const fundamentalPrompt = `Eres el Analista Fundamental Principal. Evalúa el activo ${ticker}.
Titulares recientes:
${newsContext}
Dame un veredicto fundamental muy breve (1-2 oraciones) y si el sentimiento es BULLISH, BEARISH o NEUTRAL.`;

    // Agent 3: Risk Manager
    const riskPrompt = `Eres el Gestor de Riesgo. Evalúa un trade en ${ticker} dirección ${direction}.
El balance de la cuenta es $${accountBalance}. La regla de oro es no arriesgar más del 1-2% por trade.
Datos de volatilidad (cambio 24h): ${marketData?.change24h || 'desconocido'}%.
Dame una recomendación estricta de gestión de riesgo, tamaño de posición (lotaje o %) y dónde colocar el Stop Loss (amplio o ajustado).`;

    try {
        const [techRes, fundRes, riskRes] = await Promise.all([
            geminiClient.models.generateContent({
                model: 'gemini-3.1-flash-lite-preview',
                contents: [{ role: 'user', parts: [{ text: technicalPrompt }] }],
                config: { temperature: 0.1, maxOutputTokens: 200 }
            }),
            geminiClient.models.generateContent({
                model: 'gemini-3.1-flash-lite-preview',
                contents: [{ role: 'user', parts: [{ text: fundamentalPrompt }] }],
                config: { temperature: 0.3, maxOutputTokens: 200 }
            }),
            geminiClient.models.generateContent({
                model: 'gemini-3.1-flash-lite-preview',
                contents: [{ role: 'user', parts: [{ text: riskPrompt }] }],
                config: { temperature: 0.1, maxOutputTokens: 200 }
            })
        ]);

        const techReport = techRes.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Fallo técnico.';
        const fundReport = fundRes.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Fallo fundamental.';
        const riskReport = riskRes.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Fallo de riesgo.';

        // 3. CEO Synthesis
        console.log(`[SWARM] Sintetizando decisión del CEO...`);
        const ceoPrompt = `Eres el CEO del Fondo de Cobertura 'Alejabot Capital'.
Debes tomar la decisión final sobre si ejecutar o descartar un trade en ${ticker} (${direction}).

Reportes de tu comité:
1. ANALISTA TÉCNICO: ${techReport}
2. ANALISTA FUNDAMENTAL: ${fundReport}
3. GESTOR DE RIESGO: ${riskReport}

Escribe tu veredicto final para el usuario. Sé directo, profesional y estructurado.
Usa este formato:
🎯 **Decisión Final CEO:** [APROBADO | RECHAZADO | ESPERAR]
📈 **Resumen Técnico:** ...
📰 **Sentimiento Fundamental:** ...
🛡️ **Plan de Riesgo:** ...
💡 **Conclusión:** ...`;

        const ceoRes = await geminiClient.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [{ role: 'user', parts: [{ text: ceoPrompt }] }],
            config: { temperature: 0.2, maxOutputTokens: 400 }
        }).catch(async (e) => {
            console.warn(`[SWARM] Fallback to gemini-3.1-flash-lite-preview for CEO: ${e.message}`);
            return await geminiClient.models.generateContent({
                model: 'gemini-3.1-flash-lite-preview',
                contents: [{ role: 'user', parts: [{ text: ceoPrompt }] }],
                config: { temperature: 0.2, maxOutputTokens: 400 }
            }).catch(async (e2) => {
                console.warn(`[SWARM] Fallback to gemini-2.5-pro for CEO: ${e2.message}`);
                return await geminiClient.models.generateContent({
                    model: 'gemini-2.5-pro',
                    contents: [{ role: 'user', parts: [{ text: ceoPrompt }] }],
                    config: { temperature: 0.2, maxOutputTokens: 400 }
                });
            });
        });

        return ceoRes.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'El CEO no pudo generar un reporte.';
    } catch (err: any) {
        console.error(`[SWARM] Error en el comité de inversión:`, err.message);
        return `Error en el Swarm Multi-Agente: ${err.message}`;
    }
}

/**
 * Format an InvestmentAnalysis into a Telegram-friendly string.
 */
export function formatInvestmentAlert(analysis: InvestmentAnalysis): string {
    const sentimentIcon = analysis.sentiment === 'BULLISH' ? '🟢' : analysis.sentiment === 'BEARISH' ? '🔴' : '⚪';
    
    let msg = `📊 *Análisis Fundamental:* ${sentimentIcon} ${analysis.sentiment} (${analysis.confidence}% confianza)\n`;
    msg += `${analysis.summary}\n`;
    
    if (analysis.keyFactors.length > 0) {
        msg += `📌 *Factores:* ${analysis.keyFactors.join(' • ')}`;
    }
    
    return msg;
}
