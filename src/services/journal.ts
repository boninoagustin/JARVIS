/**
 * Trade Journal — Self-Evolving Agent
 * 
 * Logs every trading alert with full context, tracks results (win/loss),
 * calculates performance metrics, and auto-tunes Scalper thresholds
 * based on historical performance.
 * 
 * Inspired by: awesome-llm-apps/ai_self_evolving_agent
 */

import { db } from '../db/memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

// ─── Interfaces ───

export interface TradeRecord {
    id: string;
    ticker: string;
    direction: 'BUY' | 'SELL';
    grade: 'A+' | 'B';
    points: number;
    events: string[];
    macroContext: Record<string, string>;
    kronosVerdict?: string;
    investmentSentiment?: string;
    mixtureConsensus?: string;
    timestamp: number;
    date: string;              // YYYY-MM-DD for daily grouping
    result?: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'PARTIAL_TP1' | 'TIMEOUT';
    pnl?: number;
    durationMin?: number;       // 🆕 Duración del trade en minutos (entrada → cierre)
    mode?: 'live' | 'backtesting'; // 🆕 Modo de ejecución (default: live)
    sessionId?: string;         // 🆕 ID de sesión para agrupar trades de backtesting
    configNote?: string;        // 🆕 Nota sobre la configuración del indicador
    // 🆕 Niveles de ejecución para tracking automático en el Diario Analítico
    entryPrice?: number;
    tp1Price?: number;
    tp2Price?: number;
    slPrice?: number;
    originalSlPrice?: number;   // 🆕 Precio del Stop Loss original antes de ser movido a Breakeven
    tp1Hit?: boolean;           // Se marca true cuando el precio toca TP1
    tp2Hit?: boolean;           // Se marca true cuando el precio toca TP2
    slHit?: boolean;            // Se marca true cuando el precio toca SL
    tp1Timestamp?: number;      // Cuándo se alcanzó TP1
    tp2Timestamp?: number;      // Cuándo se alcanzó TP2
    slTimestamp?: number;       // Cuándo se alcanzó SL
    isChochEntry?: boolean;     // Se marca true si la entrada fue directa por CHoCH (sin esperar retroceso OTE)
}

export interface PerformanceMetrics {
    totalTrades: number;
    wins: number;
    losses: number;
    breakeven: number;
    pending: number;
    winRate: number;
    byTicker: Record<string, { wins: number; losses: number; winRate: number; avgPoints: number }>;
    byGrade: Record<string, { wins: number; losses: number; winRate: number }>;
}

const JOURNAL_COLLECTION = 'trade_journal';

// ─── Trade Logging ───

function generateTradeId(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Log a new trade alert to the journal.
 * Returns the generated trade ID for reference in Telegram messages.
 */
export async function logTrade(record: Omit<TradeRecord, 'id' | 'date'>): Promise<string> {
    if (!db) {
        console.warn('[JOURNAL] DB not initialized, skipping log.');
        return 'N/A';
    }

    const id = generateTradeId();
    const date = new Date(record.timestamp).toISOString().split('T')[0];

    try {
        // Eliminar propiedades undefined para evitar errores en Firestore
        const cleanRecord = Object.fromEntries(
            Object.entries({
                ...record,
                id,
                date,
                tp1Hit: record.tp1Hit || false,
                tp2Hit: record.tp2Hit || false,
                slHit: record.slHit || false,
            }).filter(([_, v]) => v !== undefined)
        );

        await db.collection(JOURNAL_COLLECTION).doc(id).set(cleanRecord);
        console.log(`[JOURNAL] Trade #${id} logged: ${record.ticker} ${record.direction} ${record.grade} (${record.points} pts) | SL:${record.slPrice} TP1:${record.tp1Price} TP2:${record.tp2Price}`);
        return id;
    } catch (err: any) {
        console.error('[JOURNAL] Error logging trade:', err.message);
        return 'ERR';
    }
}

// ─── Result Recording ───

/**
 * Record the result of a trade by its ID.
 */
export async function recordResult(
    tradeId: string,
    result: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'TIMEOUT',
    pnl?: number
): Promise<boolean> {
    if (!db) return false;

    try {
        const docRef = db.collection(JOURNAL_COLLECTION).doc(tradeId.toUpperCase());
        const doc = await docRef.get();
        
        if (!doc.exists) {
            console.warn(`[JOURNAL] Trade #${tradeId} not found.`);
            return false;
        }

        await docRef.update({ result, pnl: pnl || null });
        console.log(`[JOURNAL] Trade #${tradeId} recorded as ${result}${pnl ? ` (${pnl > 0 ? '+' : ''}${pnl}%)` : ''}`);
        return true;
    } catch (err: any) {
        console.error('[JOURNAL] Error recording result:', err.message);
        return false;
    }
}

// ─── Performance Metrics ───

/**
 * Get performance metrics for the last N days.
 */
export async function getPerformance(days: number = 30): Promise<PerformanceMetrics> {
    const empty: PerformanceMetrics = {
        totalTrades: 0, wins: 0, losses: 0, breakeven: 0, pending: 0,
        winRate: 0, byTicker: {}, byGrade: {}
    };

    if (!db) return empty;

    try {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const snapshot = await db.collection(JOURNAL_COLLECTION)
            .where('timestamp', '>=', cutoff)
            .orderBy('timestamp', 'desc')
            .get();

        if (snapshot.empty) return empty;

        const trades = snapshot.docs
            .map(d => d.data() as TradeRecord)
            .filter(t => t.mode !== 'backtesting'); // Excluir backtesting de métricas reales
        const withResult = trades.filter(t => t.result);

        const wins = withResult.filter(t => t.result === 'WIN').length;
        const losses = withResult.filter(t => t.result === 'LOSS').length;
        const be = withResult.filter(t => t.result === 'BREAKEVEN').length;

        // By ticker
        const byTicker: PerformanceMetrics['byTicker'] = {};
        for (const t of withResult) {
            if (!byTicker[t.ticker]) byTicker[t.ticker] = { wins: 0, losses: 0, winRate: 0, avgPoints: 0 };
            if (t.result === 'WIN') byTicker[t.ticker].wins++;
            else if (t.result === 'LOSS') byTicker[t.ticker].losses++;
        }
        for (const [, stats] of Object.entries(byTicker)) {
            const total = stats.wins + stats.losses;
            stats.winRate = total > 0 ? Math.round((stats.wins / total) * 100) : 0;
        }

        // By grade
        const byGrade: PerformanceMetrics['byGrade'] = {};
        for (const t of withResult) {
            if (!byGrade[t.grade]) byGrade[t.grade] = { wins: 0, losses: 0, winRate: 0 };
            if (t.result === 'WIN') byGrade[t.grade].wins++;
            else if (t.result === 'LOSS') byGrade[t.grade].losses++;
        }
        for (const [, stats] of Object.entries(byGrade)) {
            const total = stats.wins + stats.losses;
            stats.winRate = total > 0 ? Math.round((stats.wins / total) * 100) : 0;
        }

        return {
            totalTrades: trades.length,
            wins, losses, breakeven: be,
            pending: trades.length - withResult.length,
            winRate: (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0,
            byTicker, byGrade
        };
    } catch (err: any) {
        console.error('[JOURNAL] Error getting performance:', err.message);
        return empty;
    }
}

// ─── Optimal Thresholds (Auto-Tuning) ───

/**
 * Calculate optimal minimum points per ticker based on historical win rate.
 * If a ticker consistently loses at low points, raise the threshold.
 * If it wins at lower points, allow it.
 */
export async function getOptimalThresholds(): Promise<Record<string, number>> {
    if (!db) return {};

    try {
        const snapshot = await db.collection(JOURNAL_COLLECTION)
            .where('result', 'in', ['WIN', 'LOSS'])
            .get();

        if (snapshot.empty) return {};

        // Group by ticker and analyze point thresholds
        const tickerData: Record<string, { wins: number[]; losses: number[] }> = {};
        
        for (const doc of snapshot.docs) {
            const t = doc.data() as TradeRecord;
            if (!tickerData[t.ticker]) tickerData[t.ticker] = { wins: [], losses: [] };
            if (t.result === 'WIN') tickerData[t.ticker].wins.push(t.points);
            else if (t.result === 'LOSS') tickerData[t.ticker].losses.push(t.points);
        }

        const thresholds: Record<string, number> = {};
        
        for (const [ticker, data] of Object.entries(tickerData)) {
            const total = data.wins.length + data.losses.length;
            if (total < 5) continue; // Need at least 5 trades to adjust

            const winRate = data.wins.length / total;
            
            if (winRate < 0.4) {
                // Poor performance: raise threshold by 1
                const avgLossPoints = data.losses.reduce((a, b) => a + b, 0) / data.losses.length;
                thresholds[ticker] = Math.ceil(avgLossPoints) + 1;
            } else if (winRate > 0.7 && data.wins.length >= 3) {
                // Great performance: allow lower threshold
                const minWinPoints = Math.min(...data.wins);
                thresholds[ticker] = Math.max(4, minWinPoints - 1);
            }
            // Default (40-70% win rate): keep standard threshold (5)
        }

        return thresholds;
    } catch (err: any) {
        console.error('[JOURNAL] Error calculating thresholds:', err.message);
        return {};
    }
}

// ─── Daily Review ───

/**
 * Get all pending trades (no result yet) to ask the user at end of day.
 */
export async function getPendingTrades(): Promise<TradeRecord[]> {
    if (!db) return [];

    try {
        const today = new Date().toISOString().split('T')[0];
        const snapshot = await db.collection(JOURNAL_COLLECTION)
            .where('date', '==', today)
            .get();

        return snapshot.docs
            .map(d => d.data() as TradeRecord)
            .filter(t => !t.result);
    } catch (err: any) {
        console.error('[JOURNAL] Error getting pending trades:', err.message);
        return [];
    }
}

/**
 * Send a comprehensive end-of-day summary with stats and pending trades.
 * Unified daily review — called from trading.ts watchdog at 18:00 ART.
 */
export async function sendDailyReview(): Promise<void> {
    if (!db) return;

    try {
        const today = new Date().toISOString().split('T')[0];
        const snapshot = await db.collection(JOURNAL_COLLECTION)
            .where('date', '==', today)
            .get();

        const allToday = snapshot.docs
            .map(d => d.data() as TradeRecord)
            .filter(t => t.mode !== 'backtesting'); // Excluir backtesting del resumen diario
        const withResult = allToday.filter(t => t.result);
        const pending = allToday.filter(t => !t.result);

        const wins = withResult.filter(t => t.result === 'WIN').length;
        const losses = withResult.filter(t => t.result === 'LOSS').length;
        const be = withResult.filter(t => t.result === 'BREAKEVEN').length;
        const partials = withResult.filter(t => t.result === 'PARTIAL_TP1').length;
        const closed = wins + losses + be;
        const winRate = closed > 0 ? ((wins / closed) * 100).toFixed(1) : '—';

        // PnL acumulado
        const totalPnl = withResult.reduce((sum, t) => sum + (t.pnl || 0), 0);
        const pnlSign = totalPnl >= 0 ? '+' : '';

        // Duración promedio
        const tradesWithDuration = withResult.filter(t => (t as any).durationMin);
        const avgDuration = tradesWithDuration.length > 0
            ? Math.round(tradesWithDuration.reduce((sum, t) => sum + ((t as any).durationMin || 0), 0) / tradesWithDuration.length)
            : null;

        // Mejor par
        const byTicker: Record<string, { wins: number; losses: number; pnl: number }> = {};
        for (const t of withResult) {
            if (!byTicker[t.ticker]) byTicker[t.ticker] = { wins: 0, losses: 0, pnl: 0 };
            if (t.result === 'WIN') byTicker[t.ticker].wins++;
            else if (t.result === 'LOSS') byTicker[t.ticker].losses++;
            byTicker[t.ticker].pnl += t.pnl || 0;
        }
        const bestPair = Object.entries(byTicker).sort((a, b) => b[1].pnl - a[1].pnl)[0];

        let msg = `📊 *CIERRE DE SESIÓN | ${today.split('-').reverse().join('/')}*\n\n`;
        
        if (allToday.length === 0) {
            msg += `😴 Sin actividad hoy. Sin alertas ni trades registrados.`;
        } else {
            msg += `✅ *WIN:* ${wins} | ❌ *LOSS:* ${losses} | ➖ *BE:* ${be}\n`;
            if (partials > 0) msg += `🟡 *TP1 parciales:* ${partials}\n`;
            msg += `📈 *Win Rate:* ${winRate}% (${closed} cerrados)\n`;
            msg += `💰 *PnL acumulado:* ${pnlSign}${totalPnl.toFixed(2)}%\n`;
            if (avgDuration) msg += `⏱️ *Duración promedio:* ${avgDuration} min\n`;
            if (bestPair) {
                const pairWR = (bestPair[1].wins + bestPair[1].losses) > 0 
                    ? ((bestPair[1].wins / (bestPair[1].wins + bestPair[1].losses)) * 100).toFixed(0) 
                    : '—';
                msg += `⭐ *Mejor par:* ${bestPair[0]} (WR ${pairWR}%, PnL ${bestPair[1].pnl >= 0 ? '+' : ''}${bestPair[1].pnl.toFixed(1)}%)\n`;
            }

            // 🏅 Performance por calidad de setup (A+ vs B)
            const byGrade: Record<string, { wins: number; losses: number }> = {};
            for (const t of withResult) {
                if (!byGrade[t.grade]) byGrade[t.grade] = { wins: 0, losses: 0 };
                if (t.result === 'WIN') byGrade[t.grade].wins++;
                else if (t.result === 'LOSS') byGrade[t.grade].losses++;
            }
            const gradeEntries = Object.entries(byGrade)
                .filter(([, s]) => (s.wins + s.losses) > 0)
                .sort(([a], [b]) => b.localeCompare(a));
            if (gradeEntries.length > 0) {
                msg += `\n🏅 *Por Calidad:*\n`;
                for (const [grade, stats] of gradeEntries) {
                    const total = stats.wins + stats.losses;
                    const wr = total > 0 ? ((stats.wins / total) * 100).toFixed(0) : '—';
                    msg += `  ${grade}: ${stats.wins}W/${stats.losses}L (${wr}%)\n`;
                }
            }

            // 🤖 Recomendación automática
            const closedWR = closed > 0 ? (wins / closed) * 100 : 0;
            if (closedWR < 35 && closed >= 3) {
                msg += `\n⚠️ *RECOMENDACIÓN:* Win rate bajo (${closedWR.toFixed(0)}%). Considerá subir minPts +2 o activar solo macro alineados.`;
            } else if (closedWR >= 65 && closed >= 5) {
                msg += `\n🔥 *DÍA SÓLIDO.* El sistema está funcionando bien. Mantené la configuración actual.`;
            }

            if (pending.length > 0) {
                msg += `\n\n⏳ *${pending.length} trade(s) pendiente(s):*\n`;
                for (const t of pending) {
                    const dirIcon = t.direction === 'BUY' ? '🟢' : '🔴';
                    const levels = t.tp1Price 
                        ? ` | SL:${t.slPrice} TP1:${t.tp1Price}${t.tp2Price ? ` TP2:${t.tp2Price}` : ''}`
                        : '';
                    msg += `  ${dirIcon} \`${t.id}\` ${t.ticker} ${t.grade} (${t.points} pts)${levels}\n`;
                }
                msg += `\n📝 *Registrá resultados:* "El trade XXXX fue win/loss/breakeven"`;
            }
        }

        // Enviar a Telegram
        for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
            try {
                await bot.api.sendMessage(userId, msg, { parse_mode: 'Markdown' });
            } catch {
                try { await bot.api.sendMessage(userId, msg); } catch {}
            }
        }
        console.log(`[JOURNAL] 📊 Resumen diario enviado: ${wins}W/${losses}L/${be}BE | PnL: ${pnlSign}${totalPnl.toFixed(2)}%`);
    } catch (err: any) {
        console.error('[JOURNAL] Error en resumen diario:', err.message);
    }
}

// ─── Formatters ───

/**
 * Format performance metrics as a Telegram-friendly string.
 */
export function formatPerformance(metrics: PerformanceMetrics): string {
    if (metrics.totalTrades === 0) return '📊 No hay trades registrados aún.';

    let msg = `📊 *RENDIMIENTO DE TRADING*\n\n`;
    msg += `📈 Total: ${metrics.totalTrades} trades\n`;
    msg += `✅ Ganados: ${metrics.wins} | ❌ Perdidos: ${metrics.losses} | ➖ BE: ${metrics.breakeven}\n`;
    msg += `⏳ Pendientes: ${metrics.pending}\n`;
    msg += `🎯 *Win Rate: ${metrics.winRate}%*\n\n`;

    const tickers = Object.entries(metrics.byTicker);
    if (tickers.length > 0) {
        msg += `📌 *Por Activo:*\n`;
        for (const [ticker, stats] of tickers) {
            const icon = stats.winRate >= 60 ? '🟢' : stats.winRate >= 40 ? '🟡' : '🔴';
            msg += `${icon} ${ticker}: ${stats.winRate}% (${stats.wins}W/${stats.losses}L)\n`;
        }
    }

    return msg;
}
