// ¿Cuánto rescata el ML gate walk-forward a los perdedores? (sep-2026)
// Misma config base, con/sin mlGate (modelo de producción + mtime como trainedAt).
// Uso: npx tsx scripts/diag_ml_gate.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import type { LogEntry } from '../jarvis-os/src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', 'logs');
const MODELS_DIR = path.join(__dirname, '..', 'scripts', 'hyperopt', 'models');

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

const mkConfig = (ticker: string, mlGate?: any) => {
    const sessions: any = {};
    for (const s of ['ASIA', 'LONDON', 'NY', 'OFF']) {
        sessions[s] = {};
        for (const t of ['choch5m', 'bos5m', 'choch15m', 'bos15m']) sessions[s][t] = { enabled: true, minScore: 4 };
    }
    const cfg: any = { ticker, entryTrigger: 'SMART', minBuyPoints: 4, minSellPoints: 4,
        slBufferPercent: 0.1, fixedRR: 2.0, oteEntryPercent: 50,
        spreadPips: 0, commissionPerLot: 0, sessions, enabled: true };
    if (mlGate) cfg.mlGate = mlGate;
    return cfg;
};

for (const ticker of ['EURUSD', 'GBPJPY']) {
    const logs = loadLogs(ticker);
    const prepared: LogEntry[] = await prepareEntries(logs);
    const modelPath = path.join(MODELS_DIR, `ml_model_${ticker}.json`);
    const mlGate = fs.existsSync(modelPath) ? { enabled: true, modelPath, trainedAt: fs.statSync(modelPath).mtimeMs } : undefined;

    const resOff = runBacktest(logs, mkConfig(ticker), undefined, prepared);
    const resOn = runBacktest(logs, mkConfig(ticker, mlGate), undefined, prepared);

    const stats = (r: any) => {
        const ts = r.trades.filter((t: any) => Number.isFinite(t.rMultiple));
        const sum = ts.reduce((s: number, t: any) => s + t.rMultiple, 0);
        const w = ts.filter((t: any) => t.rMultiple > 0).length;
        return { n: ts.length, r: +sum.toFixed(1), exp: +(sum / Math.max(1, ts.length)).toFixed(3), wr: +(w / Math.max(1, ts.length) * 100).toFixed(0) };
    };
    console.log(`${ticker}:`);
    console.log(`  SIN gate ML → ${JSON.stringify(stats(resOff))}`);
    console.log(`  CON gate ML → ${JSON.stringify(stats(resOn))}`);
}
process.exit(0);
