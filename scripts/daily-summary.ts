/**
 * Daily Performance Summary — JARVIS v5.3
 * 
 * Se ejecuta via cron (ej: node scripts/daily-summary.ts) tipo 23:59 ART.
 * Envía un resumen diario a Telegram con:
 *   - Señales disparadas hoy
 *   - Win rate del día
 *   - PnL acumulado
 *   - Mejores y peores setups
 *   - Sugerencia automática de ajuste de thresholds
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { db } from '../src/db/memory.js';
import { bot } from '../src/bot/telegram.js';
import { config } from '../src/config.js';
import { getPerformance, formatPerformance } from '../src/services/journal.js';

async function sendDailySummary() {
    if (!db) {
        console.error('[DAILY] Firebase no inicializado.');
        process.exit(1);
    }

    await bot.init();
    console.log(`[DAILY] Generando resumen para @${bot.botInfo.username}...`);

    // ─── 1. Obtener trades de las últimas 24h ───
    const now = Date.now();
    const startOfDay = now - 24 * 60 * 60 * 1000;

    const tradesSnap = await db.collection('trade_journal')
        .where('timestamp', '>=', startOfDay)
        .orderBy('timestamp', 'desc')
        .get();

    const trades = tradesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // ─── 2. Calcular métricas ───
    const total = trades.length;
    if (total === 0) {
        const msg = '📊 *Resumen Diario JARVIS*\n\n🛌 Sin actividad hoy. Sin señales de trading.\n\n💤 A descansar. Mañana más.';
        await sendToAll(msg);
        process.exit(0);
    }

    const wins = trades.filter(t => (t as any).result === 'WIN').length;
    const losses = trades.filter(t => (t as any).result === 'LOSS').length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';

    let totalPnl = 0;
    for (const t of trades) {
        const pnl = (t as any).pnl;
        if (typeof pnl === 'number') totalPnl += pnl;
    }

    // ─── 3. Agrupar por grado (A+, B) y dirección ───
    const aPlusTrades = trades.filter(t => (t as any).grade === 'A+');
    const bTrades = trades.filter(t => (t as any).grade === 'B');
    
    const buyTrades = trades.filter(t => (t as any).direction === 'BUY');
    const sellTrades = trades.filter(t => (t as any).direction === 'SELL');

    const aPlusWinRate = aPlusTrades.length > 0 
        ? ((aPlusTrades.filter(t => (t as any).result === 'WIN').length / aPlusTrades.length) * 100).toFixed(1) 
        : 'N/A';
    const bWinRate = bTrades.length > 0 
        ? ((bTrades.filter(t => (t as any).result === 'WIN').length / bTrades.length) * 100).toFixed(1) 
        : 'N/A';

    // ─── 4. Puntaje promedio por grado ───
    const avgPtsA = aPlusTrades.length > 0
        ? (aPlusTrades.reduce((sum, t) => sum + ((t as any).points || 0), 0) / aPlusTrades.length).toFixed(1)
        : 'N/A';
    const avgPtsB = bTrades.length > 0
        ? (bTrades.reduce((sum, t) => sum + ((t as any).points || 0), 0) / bTrades.length).toFixed(1)
        : 'N/A';

    // ─── 5. Sugerencia automática de ajuste ───
    let suggestion = '';
    const overallWinRate = parseFloat(winRate);
    
    if (overallWinRate >= 80 && total >= 5) {
        suggestion = '🟢 Excelente rendimiento. Considerá bajar minPts -1 para más oportunidades.';
    } else if (overallWinRate >= 60 && total >= 3) {
        suggestion = '🟡 Buen rendimiento. Mantener configuración actual.';
    } else if (overallWinRate < 40 && total >= 5) {
        suggestion = '🔴 Rendimiento bajo. Sugiero subir minPts +2 y solo operar Overlap (10-12:30 ART).';
    } else if (total < 3) {
        suggestion = '⚪ Muy pocas señales para evaluar. Continuar observando.';
    } else {
        suggestion = '🟡 Rendimiento mixto. Revisar calidad de setups manualmente.';
    }

    // Si A+ pierde más que B, hay problema de calidad
    if (aPlusTrades.length > 0 && bTrades.length > 0) {
        const aPlusWR = parseFloat(aPlusWinRate as string);
        const bWR = parseFloat(bWinRate as string);
        if (!isNaN(aPlusWR) && !isNaN(bWR) && aPlusWR < bWR) {
            suggestion += '\n⚠️ ALERTA: A+ está perdiendo más que B. Revisar si las zonas de alta puntuación están mal calibradas.';
        }
    }

    // ─── 6. Performance completa del journal ───
    const perf = await getPerformance(30);
    const perfStr = formatPerformance(perf);

    // ─── 7. Formatear mensaje ───
    const emoji = overallWinRate >= 60 ? '🟢' : overallWinRate >= 40 ? '🟡' : '🔴';
    
    let msg = `${emoji} *Resumen Diario JARVIS — ${new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}*\n\n`;
    
    msg += `📊 *Hoy:*\n`;
    msg += `• Señales: ${total} (${wins}W / ${losses}L)\n`;
    msg += `• Win Rate: ${winRate}%\n`;
    msg += `• PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%\n`;
    msg += `• Compras: ${buyTrades.length} | Ventas: ${sellTrades.length}\n\n`;
    
    msg += `🎯 *Por Calidad:*\n`;
    msg += `• A+: ${aPlusTrades.length} trades — WR: ${aPlusWinRate}% (pts avg: ${avgPtsA})\n`;
    msg += `• B: ${bTrades.length} trades — WR: ${bWinRate}% (pts avg: ${avgPtsB})\n\n`;
    
    msg += `🧠 *Jarvis sugiere:* ${suggestion}\n\n`;
    
    msg += `📈 *Últimos 30 días:*\n${perfStr}`;

    await sendToAll(msg);
    console.log('[DAILY] Resumen enviado.');
    process.exit(0);
}

async function sendToAll(message: string) {
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (err: any) {
            try { await bot.api.sendMessage(userId, message); } catch (e) {}
        }
    }
}

sendDailySummary().catch(err => {
    console.error('[DAILY] Error:', err);
    process.exit(1);
});
