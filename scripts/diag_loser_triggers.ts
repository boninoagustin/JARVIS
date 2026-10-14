// Análisis de gatillos perdedores (sep-2026): corre el motor con la CONFIG DE PRODUCCIÓN
// de cada activo (asset_configs Firestore) y desglosa por gatillo. Marca perdedores
// (n>=10, exp<=-0.15) como candidatos a enabled=false. PROPONE, no aplica.
// Uso: npx tsx scripts/diag_loser_triggers.ts
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import type { LogEntry } from '../jarvis-os/src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', 'logs');
const TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];
const MIN_N = 10;
const EXP_LIMIT = -0.15;

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

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();

    for (const ticker of TICKERS) {
        const doc = await db.collection("asset_configs").doc(ticker).get();
        const logs = loadLogs(ticker);
        if (!doc.exists || !logs.has('M5')) { console.log(`${ticker}: sin doc o sin logs — skip`); continue; }
        const d = doc.data() || {};
        const sessions = d.sessions || {};
        const cfg: any = {
            ticker,
            entryTrigger: d.entryTrigger || 'SMART',
            minBuyPoints: d.minPointsForBuy ?? 4,
            minSellPoints: d.minPointsForSell ?? 4,
            slBufferPercent: d.slBufferPercent ?? 0.1,
            fixedRR: d.fixedRR ?? 2.0,
            oteEntryPercent: d.oteEntryPercent ?? 50,
            spreadPips: 0, commissionPerLot: 0,
            sessions, enabled: true,
        };
        const prepared: LogEntry[] = await prepareEntries(logs);
        const res = runBacktest(logs, cfg, undefined, prepared);
        const trades = res.trades.filter(t => Number.isFinite(t.rMultiple));
        const byTrig = new Map<string, { n: number; r: number; w: number }>();
        for (const t of trades) {
            const trig = t.triggerType || '?';
            const a = byTrig.get(trig) || { n: 0, r: 0, w: 0 };
            a.n++; a.r += t.rMultiple as number; if ((t.rMultiple as number) > 0) a.w++;
            byTrig.set(trig, a);
        }
        const losers: string[] = [];
        const detail: string[] = [];
        for (const [trig, v] of [...byTrig.entries()].sort((a, b) => a[1].r - b[1].r)) {
            const exp = v.r / v.n;
            detail.push(`${trig}:${v.n}t/${exp >= 0 ? '+' : ''}${exp.toFixed(2)}R`);
            if (v.n >= MIN_N && exp <= EXP_LIMIT) losers.push(`${trig} (${v.n}t, ${exp.toFixed(2)}R/t)`);
        }
        const tot = trades.reduce((s, t) => s + (t.rMultiple as number), 0);
        console.log(`${ticker.padEnd(7)} ${String(trades.length).padStart(4)} trades | ΣR ${tot >= 0 ? '+' : ''}${tot.toFixed(1)}${losers.length ? ' | 🔴 PERDEDORES: ' + losers.join(' · ') : ''}`);
        if (process.argv.includes('--detail')) console.log(`          ${detail.join(' · ')}`);
    }
    process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
