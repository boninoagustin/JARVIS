// A/B pico rollover (sep-2026, punto 4): runBacktest EURUSD con rolloverPeakPips=19 vs 0.
// Mide cuántos trades entran en 20:29-21:00 UTC y cuánto PnL aportan/roban sin el pico.
// Uso: npx tsx scripts/test_rollover_ab.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import type { LogEntry } from '../jarvis-os/src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', 'logs');

const TICKER = 'EURUSD';
const TFS = ['M5', 'M15'];

function loadLogs(ticker: string, tfs: string[]): Map<string, string[]> {
    const tickerDir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    for (const tf of tfs) {
        const candidates = [
            path.join(tickerDir, `pine-logs-SMC Master_${tf}.csv`),
            path.join(tickerDir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`),
        ];
        const found = candidates.find(c => fs.existsSync(c));
        if (!found) continue;
        logs.set(tf, fs.readFileSync(found, 'utf8').split('\n').filter(l => l.trim().length > 0));
    }
    return logs;
}

const sessions: any = {};
for (const s of ['ASIA', 'LONDON', 'NY', 'OFF']) {
    sessions[s] = {};
    for (const t of ['choch5m', 'bos5m', 'choch15m', 'bos15m']) {
        sessions[s][t] = { enabled: true, minScore: 4 };
    }
}

const mkConfig = (rolloverPeakPips?: number) => ({
    ticker: TICKER,
    entryTrigger: 'SMART',
    minBuyPoints: 4, minSellPoints: 4,
    slBufferPercent: 0.1, fixedRR: 2.0, oteEntryPercent: 50,
    spreadPips: 0, commissionPerLot: 0, // 0 = auto → defaults FOREX (base 0.1 pips)
    sessions,
    enabled: true,
    rolloverPeakPips,
});

function inRolloverWindow(tsMs: number): boolean {
    const d = new Date(tsMs);
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return m >= 20 * 60 + 29 && m < 21 * 60;
}

const logs = loadLogs(TICKER, TFS);
const prepared: LogEntry[] = await prepareEntries(logs);
console.log(`entradas preparadas: ${prepared.length}`);

const resA = runBacktest(logs, mkConfig(19) as any, undefined, prepared); // pico ON (default real)
const resB = runBacktest(logs, mkConfig(0) as any, undefined, prepared);  // pico OFF

function stats(trades: any[]) {
    const inWin = trades.filter(t => inRolloverWindow(t.timestamp));
    const pnl = (arr: any[]) => arr.reduce((s, t) => s + (Number.isFinite(t.rMultiple) ? t.rMultiple : 0), 0);
    return {
        total: trades.length,
        inWindow: inWin.length,
        inWindowPnL: pnl(inWin),
        totalPnL: pnl(trades),
        wr: trades.filter(t => (t.rMultiple || 0) > 0).length,
    };
}

const a = stats(resA.trades);
const b = stats(resB.trades);

console.log('');
console.log('═══ A/B PICO ROLLOVER EURUSD (histórico completo) ═══');
console.log(`                | pico ON (19p) | pico OFF (0) | Δ`);
console.log(`trades totales  | ${String(a.total).padStart(12)} | ${String(b.total).padStart(11)} | ${b.total - a.total}`);
console.log(`trades 20:29-21 | ${String(a.inWindow).padStart(12)} | ${String(b.inWindow).padStart(11)} | ${b.inWindow - a.inWindow}`);
console.log(`PnL total (R)   | ${a.totalPnL.toFixed(1).padStart(12)} | ${b.totalPnL.toFixed(1).padStart(11)} | ${(b.totalPnL - a.totalPnL).toFixed(1)}`);
console.log(`PnL ventana (R) | ${a.inWindowPnL.toFixed(1).padStart(12)} | ${b.inWindowPnL.toFixed(1).padStart(11)} |`);
console.log(`WR total        | ${((a.wr / Math.max(1, a.total)) * 100).toFixed(1).padStart(11)}% | ${((b.wr / Math.max(1, b.total)) * 100).toFixed(1).padStart(10)}% |`);

// Diagnóstico: distribución horaria UTC de los trades y alertas válidas en la ventana
const byHour: Record<number, number> = {};
for (const t of resB.trades) {
    const h = new Date(t.timestamp).getUTCHours();
    byHour[h] = (byHour[h] || 0) + 1;
}
console.log('');
console.log('Trades por hora UTC (pico OFF):', Object.entries(byHour).sort((x, y) => Number(x[0]) - Number(y[0])).map(([h, c]) => `${h}h:${c}`).join(' '));
const alertsInWin = prepared.filter(e => inRolloverWindow(e.ts)).length;
console.log(`alertas válidas en ventana 20:29-21:00 UTC: ${alertsInWin} / ${prepared.length} total`);
if (alertsInWin > 0) {
    const byType: Record<string, number> = {};
    for (const e of prepared.filter(e => inRolloverWindow(e.ts))) {
        const t = (e as any).type || (e as any).event || '?';
        byType[t] = (byType[t] || 0) + 1;
    }
    console.log('tipos de alerta en ventana:', JSON.stringify(byType).slice(0, 300));
}
if (b.inWindow > 0) {
    const winB = resB.trades.filter(t => inRolloverWindow(t.timestamp));
    console.log('');
    console.log(`Detalle trades de ventana SIN pico (${winB.length}): PnL ${b.inWindowPnL.toFixed(1)}R, WR ${((winB.filter(t => (t.rMultiple || 0) > 0).length / winB.length) * 100).toFixed(0)}%`);
    console.log('→ si el PnL de ventana es positivo, el backtest SIN pico sobre-valora estas entradas.');
}
process.exit(0);
