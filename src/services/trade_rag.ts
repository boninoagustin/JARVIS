/**
 * Agentic RAG — Trade History Query
 * 
 * Allows natural language queries over the trade journal stored in Firebase.
 * Uses Gemini to parse the user's question into Firebase query filters,
 * then synthesizes the results into a natural language response.
 * 
 * Example queries:
 * - "¿Qué pasó la última vez que hubo CHoCH en EURUSD?"
 * - "¿Cuántos trades ganadores tuve esta semana?"
 * - "¿Cuál es mi mejor par para compras?"
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { db } from '../db/memory.js';

const geminiClient = config.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }) : null;

const JOURNAL_COLLECTION = 'trade_journal';

// ─── Query Parser ───

interface ParsedQuery {
    ticker?: string;
    direction?: 'BUY' | 'SELL';
    events?: string[];       // confluence events to filter
    result?: 'WIN' | 'LOSS';
    grade?: 'A+' | 'B';
    daysBack?: number;
    limit?: number;
}

const PARSE_PROMPT = `Eres un parser de consultas de trading. Dada una pregunta en lenguaje natural, extrae los filtros relevantes.

Responde SOLO JSON sin backticks:
{"ticker":"BTCUSD","direction":"BUY","events":["CHoCH","Sweep"],"result":"WIN","grade":"A+","daysBack":7,"limit":10}

Reglas:
- Solo incluye campos que el usuario mencionó explícitamente
- ticker: símbolo del activo (BTCUSD, EURUSD, etc.)
- direction: BUY o SELL
- events: nombres de confluencias (CHoCH, Sweep, OB, DIV, Breaker, POC)
- result: WIN o LOSS
- grade: "A+" o "B"
- daysBack: cuántos días atrás buscar (default 30 si no se especifica)
- limit: máximo de resultados (default 10)
- Si la pregunta es general ("¿cómo me fue?"), usa solo daysBack
- Si dice "última vez", usa limit: 1`;

async function parseQuery(naturalQuery: string): Promise<ParsedQuery> {
    if (!geminiClient) {
        return { daysBack: 30, limit: 10 };
    }

    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: [{ role: 'user', parts: [{ text: naturalQuery }] }],
            config: { systemInstruction: PARSE_PROMPT, maxOutputTokens: 150, temperature: 0.1 }
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) return { daysBack: 30, limit: 10 };

        const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        return {
            ticker: parsed.ticker,
            direction: parsed.direction,
            events: parsed.events,
            result: parsed.result,
            grade: parsed.grade,
            daysBack: parsed.daysBack || 30,
            limit: Math.min(parsed.limit || 10, 20)
        };
    } catch (e: any) {
        console.error('[RAG] Query parse error:', e.message);
        return { daysBack: 30, limit: 10 };
    }
}

// ─── Firebase Query ───

async function fetchTrades(filters: ParsedQuery): Promise<any[]> {
    if (!db) return [];

    try {
        const cutoff = Date.now() - ((filters.daysBack || 30) * 24 * 60 * 60 * 1000);
        let query: FirebaseFirestore.Query = db.collection(JOURNAL_COLLECTION)
            .where('timestamp', '>=', cutoff)
            .orderBy('timestamp', 'desc');

        // Note: Firestore has limitations on compound queries.
        // We do basic filtering in-query and fine-grained filtering in-memory.
        const snapshot = await query.limit(100).get();
        
        let trades = snapshot.docs.map(d => d.data());

        // In-memory filtering for fields Firestore can't compound-query
        if (filters.ticker) {
            trades = trades.filter(t => t.ticker?.toUpperCase().includes(filters.ticker!.toUpperCase()));
        }
        if (filters.direction) {
            trades = trades.filter(t => t.direction === filters.direction);
        }
        if (filters.result) {
            trades = trades.filter(t => t.result === filters.result);
        }
        if (filters.grade) {
            trades = trades.filter(t => t.grade === filters.grade);
        }
        if (filters.events && filters.events.length > 0) {
            trades = trades.filter(t => {
                const tradeEvents = (t.events || []).join(' ').toUpperCase();
                return filters.events!.some(e => tradeEvents.includes(e.toUpperCase()));
            });
        }

        return trades.slice(0, filters.limit || 10);
    } catch (e: any) {
        console.error('[RAG] Firebase query error:', e.message);
        return [];
    }
}

// ─── Response Synthesis ───

const SYNTH_PROMPT = `Eres JARVIS analizando el historial de trading del usuario. Dada una pregunta y los trades encontrados, genera una respuesta útil y concisa en español.

Reglas:
- Sé directo y profesional
- Incluye estadísticas relevantes (win rate, puntos promedio, etc.)
- Si hay patrones interesantes, mencionálos
- Máximo 3-4 párrafos
- Usa emojis moderadamente`;

/**
 * Main entry point: query trade history with natural language.
 */
export async function queryTradeHistory(naturalQuery: string): Promise<string> {
    console.log(`[RAG] Query: "${naturalQuery}"`);

    // Step 1: Parse the natural language query
    const filters = await parseQuery(naturalQuery);
    console.log('[RAG] Parsed filters:', JSON.stringify(filters));

    // Step 2: Fetch matching trades from Firebase
    const trades = await fetchTrades(filters);
    
    if (trades.length === 0) {
        return '📭 No encontré trades que coincidan con tu consulta en el journal. Puede que aún no haya suficiente historial registrado.';
    }

    // Step 3: Synthesize response
    if (!geminiClient) {
        // Fallback: raw data
        return trades.map(t => {
            const icon = t.result === 'WIN' ? '✅' : t.result === 'LOSS' ? '❌' : '⏳';
            return `${icon} ${t.ticker} ${t.direction} ${t.grade} (${t.points} pts) — ${t.result || 'PENDIENTE'}`;
        }).join('\n');
    }

    try {
        const context = `PREGUNTA: ${naturalQuery}\n\nTRADES ENCONTRADOS (${trades.length}):\n\n` +
            trades.map((t, i) => {
                return `[${i + 1}] ${t.date} ${t.ticker} ${t.direction} ${t.grade} (${t.points} pts) | ` +
                    `Confluencias: ${(t.events || []).join(', ')} | ` +
                    `Resultado: ${t.result || 'PENDIENTE'}${t.pnl ? ` (${t.pnl}%)` : ''}`;
            }).join('\n');

        const response = await geminiClient.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: [{ role: 'user', parts: [{ text: context }] }],
            config: { systemInstruction: SYNTH_PROMPT, maxOutputTokens: 500, temperature: 0.3 }
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        return text || '⚠️ No pude generar una respuesta de los datos encontrados.';
    } catch (e: any) {
        console.error('[RAG] Synthesis error:', e.message);
        return `📊 Encontré ${trades.length} trades pero hubo un error sintetizando. Trades: ` +
            trades.map(t => `${t.ticker} ${t.direction} (${t.result || '?'})`).join(', ');
    }
}
