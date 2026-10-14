// Diagnóstico del motor por activo (sep-2026): ¿por qué EURUSD/GBPJPY pierden y XAUUSD gana?
// Desglose de trades del backtest por triggerType × sesión (hora ARG) × resultado,
// con la MISMA config base en los 3 activos (aisla la variable "activo").
// Uso: npx tsx scripts/diag_engine_branch.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import type { LogEntry } from '../jarvis-os/src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', 'logs');
const TICKERS = ['EURUSD', 'GBPJPY', 'XAUUSD']; // perdedores + referencia ganadora

function sessionFromTs(ts: number): string {
    const d = new Date(ts);
    const arH = (d.getUTCHours() - 3 + 24) % 24;
    const dec = arH + d.getUTCMinutes() / 60;
    if (dec >= 21 || dec < 4) return 'OFF';
    if (dec >= 4 && dec < 10.5) return 'ASIA';
    if (dec >= 10.5 && dec < 17) return 'LONDON';
    return 'NY';
}

function loadLogs(ticker: string): Map<string, string[]> {
    const tickerDir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    if (!fs.existsSync(tickerDir)) return logs;
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

for (const ticker of TICKERS) {
    const logs = loadLogs(ticker);
    const prepared: LogEntry[] = await prepareEntries(logs);
    const res = runBacktest(logs, mkConfig(ticker) as any, undefined, prepared);
    const trades = res.trades.filter(t => Number.isFinite(t.rMultiple));

    interface Cell { n: number; w: number; r: number; tp1: number; }
    const byTrig = new Map<string, Cell>();
    const bySess = new Map<string, Cell>();
    const byResult: Record<string, number> = {};
    let totR = 0, slN = 0, beN = 0, roiN = 0;
    for (const t of trades) {
        const r = t.rMultiple as number;
        const trig = t.triggerType || '?';
        const sess = sessionFromTs(t.timestamp);
        const cell = (m: Map<string, Cell>, k: string) => { const a = m.get(k) || { n: 0, w: 0, r: 0, tp1: 0 }; a.n++; a.r += r; if (r > 0) a.w++; if (t.tp1Hit) a.tp1++; m.set(k, a); return a; };
        cell(byTrig, trig); cell(bySess, sess);
        byResult[t.result || '?'] = (byResult[t.result || '?'] || 0) + 1;
        totR += r;
        if (t.result === 'LOSS') slN++;
        if (t.result === 'BE') beN++;
        if (t.roiDecayApplied) roiN++;
    }
    console.log(`\n════ ${ticker} — ${trades.length} trades | ΣR ${totR >= 0 ? '+' : ''}${totR.toFixed(1)} | exp ${(totR / Math.max(1, trades.length)).toFixed(2)}R/t | resultados: ${JSON.stringify(byResult)}`);
    console.log(`  por GATILLO:`);
    for (const [k, v] of [...byTrig.entries()].sort((a, b) => b[1].r - a[1].r)) {
        console.log(`    ${k.padEnd(12)} n=${String(v.n).padEnd(4)} WR=${(v.w / v.n * 100).toFixed(0).padStart(3)}% R=${v.r >= 0 ? '+' : ''}${v.r.toFixed(1).padStart(6)} tp1Hit=${(v.tp1 / v.n * 100).toFixed(0).padStart(3)}%`);
    }
    console.log(`  por SESION:`);
    for (const [k, v] of [...bySess.entries()].sort((a, b) => b[1].r - a[1].r)) {
        console.log(`    ${k.padEnd(7)} n=${String(v.n).padEnd(4)} WR=${(v.w / v.n * 100).toFixed(0).padStart(3)}% R=${v.r >= 0 ? '+' : ''}${v.r.toFixed(1).padStart(6)}`);
    }
    console.log(`  cierres: SL=${slN} BE=${beN} ROI-decay=${roiN}`);
}
process.exit(0);
