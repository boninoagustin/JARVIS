// Sizing A/B (sep-2026): motor real, walk-forward por activo.
// Calibra factor de SESIÓN con la 1ª mitad de trades del backtest (por activo),
// evalúa en la 2ª mitad. Compara baseline (factor 1) vs sizing (clamp 0.4..1.6).
// Salida: consola + scripts/periodic_opt/reports/sizing_ab.json (+ secuencias para MC).
// Uso: npx tsx scripts/sizing_ab_backtest.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import type { LogEntry } from '../jarvis-os/src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', 'logs');

const TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'USDCAD', 'NZDUSD', 'USOIL', 'BTCUSD'];
const MIN_N_CAL = 8;
const K = 0.5;
const FLOOR = 0.4, CAP = 1.6;

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
    if (!fs.existsSync(tickerDir)) return new Map();
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
    return {
        ticker, entryTrigger: 'SMART', minBuyPoints: 4, minSellPoints: 4,
        slBufferPercent: 0.1, fixedRR: 2.0, oteEntryPercent: 50,
        spreadPips: 0, commissionPerLot: 0, sessions, enabled: true,
    };
};

function maxDD(seq: number[]): number {
    let peak = 0, dd = 0;
    for (const x of seq) {
        peak = Math.max(peak, x);
        dd = Math.min(dd, x - peak);
    }
    return dd;
}

const report: any = { generatedAt: new Date().toISOString(), perTicker: {}, totals: {} };
let totBaseR = 0, totSizR = 0, totBaseN = 0, totSizN = 0;
let allBaseSeq: number[] = [], allSizSeq: number[] = [];

for (const ticker of TICKERS) {
    const logs = loadLogs(ticker);
    if (!logs.has('M5') && !logs.has('M15')) { console.log(`${ticker}: sin CSVs — skip`); continue; }
    const prepared: LogEntry[] = await prepareEntries(logs);
    const res = runBacktest(logs, mkConfig(ticker) as any, undefined, prepared);
    const trades = res.trades
        .filter(t => Number.isFinite(t.rMultiple))
        .map(t => ({ r: t.rMultiple as number, ts: t.timestamp, sess: sessionFromTs(t.timestamp) }))
        .sort((a, b) => a.ts - b.ts);
    if (trades.length < 20) { console.log(`${ticker}: solo ${trades.length} trades — skip (muestra insuficiente)`); continue; }

    // Walk-forward: calibrar con la 1ª mitad
    const half = Math.floor(trades.length / 2);
    const cal = trades.slice(0, half), evl = trades.slice(half);
    const bySess = new Map<string, { n: number; r: number }>();
    for (const t of cal) {
        const a = bySess.get(t.sess) || { n: 0, r: 0 };
        a.n++; a.r += t.r;
        bySess.set(t.sess, a);
    }
    const factors: Record<string, number> = {};
    for (const [s, v] of bySess) {
        factors[s] = v.n >= MIN_N_CAL ? Math.min(CAP, Math.max(FLOOR, 1 + K * (v.r / v.n))) : 1;
    }
    const sessOrder = ['ASIA', 'LONDON', 'NY', 'OFF'];
    const baseR = evl.reduce((s, t) => s + t.r, 0);
    const sizR = evl.reduce((s, t) => s + t.r * (factors[t.sess] ?? 1), 0);
    let eqB = 0, eqS = 0;
    const baseSeq: number[] = [], sizSeq: number[] = [];
    for (const t of evl) { eqB += t.r; eqS += t.r * (factors[t.sess] ?? 1); baseSeq.push(+eqB.toFixed(2)); sizSeq.push(+eqS.toFixed(2)); }
    const ddBase = maxDD(baseSeq), ddSiz = maxDD(sizSeq);

    report.perTicker[ticker] = {
        nCal: cal.length, nEvl: evl.length,
        factors: Object.fromEntries(sessOrder.map(s => [s, +(factors[s] ?? 1).toFixed(2)])),
        baseR: +baseR.toFixed(2), sizR: +sizR.toFixed(2),
        ddBase: +ddBase.toFixed(2), ddSiz: +ddSiz.toFixed(2),
    };
    totBaseR += baseR; totSizR += sizR; totBaseN += evl.length; totSizN += evl.length;
    allBaseSeq.push(...baseSeq); allSizSeq.push(...sizSeq);
    console.log(`${ticker.padEnd(7)} nCal=${String(cal.length).padEnd(4)} nEvl=${String(evl.length).padEnd(4)} | base ${baseR >= 0 ? '+' : ''}${baseR.toFixed(1)}R (DD ${ddBase.toFixed(1)}) | sizing ${sizR >= 0 ? '+' : ''}${sizR.toFixed(1)}R (DD ${ddSiz.toFixed(1)}) | ${sessOrder.map(s => `${s}=${(factors[s] ?? 1).toFixed(2)}`).join(' ')}`);
}

report.totals = {
    baseR: +totBaseR.toFixed(2), sizR: +totSizR.toFixed(2),
    baseDD: +maxDD(allBaseSeq).toFixed(2), sizDD: +maxDD(allSizSeq).toFixed(2),
    n: totBaseN,
    deltaR: +(totSizR - totBaseR).toFixed(2),
    deltaDD: +(maxDD(allSizSeq) - maxDD(allBaseSeq)).toFixed(2),
};
console.log('');
console.log(`═══ TOTAL 2ª MITAD (${totBaseN} trades) ═══`);
console.log(`baseline: ${totBaseR >= 0 ? '+' : ''}${totBaseR.toFixed(1)}R | maxDD ${maxDD(allBaseSeq).toFixed(1)}R`);
console.log(`sizing:   ${totSizR >= 0 ? '+' : ''}${totSizR.toFixed(1)}R | maxDD ${maxDD(allSizSeq).toFixed(1)}R`);
console.log(`ΔPnL ${totSizR - totBaseR >= 0 ? '+' : ''}${(totSizR - totBaseR).toFixed(1)}R | ΔDD ${(maxDD(allSizSeq) - maxDD(allBaseSeq)).toFixed(1)}R`);

// Secuencias para MC
const mcOut = {
    base: allBaseSeq.map((_, i) => ({ rMultiple: i === 0 ? allBaseSeq[0] : allBaseSeq[i] - allBaseSeq[i - 1], timestamp: i })),
    sizing: allSizSeq.map((_, i) => ({ rMultiple: i === 0 ? allSizSeq[0] : allSizSeq[i] - allSizSeq[i - 1], timestamp: i })),
};
fs.mkdirSync(path.resolve('scripts/periodic_opt/reports'), { recursive: true });
fs.writeFileSync(path.resolve('scripts/periodic_opt/reports/sizing_ab.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.resolve('scripts/periodic_opt/reports/sizing_mc_base.json'), JSON.stringify(mcOut.base, null, 2));
fs.writeFileSync(path.resolve('scripts/periodic_opt/reports/sizing_mc_sizing.json'), JSON.stringify(mcOut.sizing, null, 2));
console.log('💾 sizing_ab.json + sizing_mc_*.json escritos');
process.exit(0);
