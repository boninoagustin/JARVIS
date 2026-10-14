// Diagnóstico fino por trade (sep-2026): histograma de rMultiple, duración y distancia SL
// para EURUSD (pierde) vs XAUUSD (gana) con la MISMA config base.
// Uso: npx tsx scripts/diag_engine_branch2.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import type { LogEntry } from '../jarvis-os/src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', 'logs');

function loadLogs(ticker: string): Map<string, string[]> {
    const tickerDir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    for (const tf of ['M5', 'M15']) {
        const found = [
            path.join(tickerDir, `pine-logs-SMC Master_${tf}.csv`),
            path.join(tickerDir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`),
        ].find(c => fs.existsSync(c));
        if (found) logs.set(tf, fs.readFileSync(found, 'utf8').split('\n').filter(l => l.trim().length > 0));
    }
    return logs;
}

const mkConfig = (ticker: string) => {
    const sessions: any = {};
    for (const s of ['ASIA', 'LONDON', 'NY', 'OFF']) {
        sessions[s] = {};
        for (const t of ['choch5m', 'bos5m', 'choch15m', 'bos15m']) sessions[s][t] = { enabled: true, minScore: 4 };
    }
    return { ticker, entryTrigger: 'SMART', minBuyPoints: 4, minSellPoints: 4,
        slBufferPercent: 0.1, fixedRR: 2.0, oteEntryPercent: 50,
        spreadPips: 0, commissionPerLot: 0, sessions, enabled: true };
};

for (const ticker of ['EURUSD', 'XAUUSD']) {
    const logs = loadLogs(ticker);
    const prepared: LogEntry[] = await prepareEntries(logs);
    const res = runBacktest(logs, mkConfig(ticker) as any, undefined, prepared);
    const trades = res.trades.filter(t => Number.isFinite(t.rMultiple));

    const wins = trades.filter(t => (t.rMultiple as number) > 0);
    const losses = trades.filter(t => (t.rMultiple as number) < 0);
    const winR = wins.map(t => t.rMultiple as number);
    const lossR = losses.map(t => t.rMultiple as number);
    const dur = trades.map(t => t.durationMin ?? 0).sort((a, b) => a - b);
    const slDist = trades.map(t => Math.abs(t.entryPrice - t.slPrice) / t.entryPrice * 10000); // pips aprox
    const med = (a: number[]) => a.length ? a[Math.floor(a.length / 2)] : 0;
    const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

    console.log(`\n════ ${ticker} (${trades.length} trades) ════`);
    console.log(`  wins n=${wins.length}: r medio=${avg(winR).toFixed(2)} mediana=${med(winR.slice().sort((a,b)=>a-b)).toFixed(2)} | min=${Math.min(...winR).toFixed(2)} max=${Math.max(...winR).toFixed(2)}`);
    console.log(`  losses n=${losses.length}: r medio=${avg(lossR).toFixed(2)} mediana=${med(lossR.slice().sort((a,b)=>a-b)).toFixed(2)} | min=${Math.min(...lossR).toFixed(2)} max=${Math.max(...lossR).toFixed(2)}`);
    console.log(`  duración (min): mediana=${med(dur)} p90=${dur[Math.floor(dur.length * 0.9)]} max=${dur[dur.length - 1]}`);
    console.log(`  distancia SL (pips): media=${avg(slDist).toFixed(1)} mediana=${med(slDist.slice().sort((a,b)=>a-b)).toFixed(1)}`);
    // wins por bucket
    const b: Record<string, number> = {};
    for (const r of winR) {
        const k = r < 0.5 ? '<0.5R' : r < 1 ? '0.5-1R' : r < 1.5 ? '1-1.5R' : r < 2 ? '1.5-2R' : '>=2R';
        b[k] = (b[k] || 0) + 1;
    }
    console.log(`  wins por bucket: ${JSON.stringify(b)}`);
    // tp1Hit pero terminó LOSS
    const tp1ThenLoss = trades.filter(t => t.tp1Hit && (t.rMultiple as number) < 0);
    console.log(`  tocaron TP1 y terminaron LOSS: ${tp1ThenLoss.length} (${(tp1ThenLoss.length / Math.max(1, trades.length) * 100).toFixed(0)}% de todos)`);
}
process.exit(0);
