// Nivel de entrada OTE por activo (sep-2026): distribución de oteEntryUsed (50/62/79) y exp
// por nivel, para EURUSD (pierde) vs XAUUSD (gana). Config base idéntica.
// Uso: npx tsx scripts/diag_ote_entry_level.ts
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

for (const ticker of ['EURUSD', 'XAUUSD', 'GBPJPY']) {
    const logs = loadLogs(ticker);
    const prepared: LogEntry[] = await prepareEntries(logs);
    const res = runBacktest(logs, mkConfig(ticker) as any, undefined, prepared);
    const ote = res.trades.filter(t => Number.isFinite(t.rMultiple) && (t.triggerType || '').startsWith('ote'));
    const byLevel = new Map<string, { n: number; r: number }>();
    for (const t of ote) {
        const lvl = t.oteEntryUsed !== undefined ? String(t.oteEntryUsed) : 'n/a';
        const a = byLevel.get(lvl) || { n: 0, r: 0 };
        a.n++; a.r += t.rMultiple as number;
        byLevel.set(lvl, a);
    }
    console.log(`${ticker}: ${ote.length} trades OTE — exp por nivel de entrada (oteEntryUsed):`);
    for (const [lvl, v] of [...byLevel.entries()].sort()) {
        console.log(`    ${lvl.padEnd(6)} n=${String(v.n).padEnd(3)} ΣR=${v.r >= 0 ? '+' : ''}${v.r.toFixed(1)} exp=${(v.r / v.n).toFixed(2)}R/t`);
    }
}
process.exit(0);
