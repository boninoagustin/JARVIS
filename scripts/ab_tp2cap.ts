// A/B cap TP2 (30-sep-2026): BASE (ADR viejo 10 activos) vs NUEVO (ADR 47 activos).
// Motor REAL (backtestEngine) con config de PRODUCCIÓN (asset_configs Firestore).
// Uso: npx tsx scripts/ab_tp2cap.ts  (se corre 2 veces, una por cada versión de tp2Cap.ts)
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

function loadLogs(ticker: string): Map<string, string[]> {
    const dir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    for (const tf of ['M5', 'M15']) {
        const f = [path.join(dir, `pine-logs-SMC Master_${tf}.csv`)].find(c => fs.existsSync(c));
        if (f) logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
    }
    return logs;
}

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();

    const tickers = ['USOIL', 'NL25', 'FRA40', 'ITALY40', 'NZDUSD', 'USDJPY', 'EURUSD', 'XPTUSD', 'GBPJPY', 'XAUUSD'];
    for (const ticker of tickers) {
        const docSnap = await db.collection("asset_configs").doc(ticker).get();
        const doc = docSnap.data() || {};
        const baseCfg: any = {
            ticker, entryTrigger: (doc as any).entryTrigger || 'SMART',
            minBuyPoints: (doc as any).minPointsForBuy ?? 4, minSellPoints: (doc as any).minPointsForSell ?? 4,
            slBufferPercent: (doc as any).slBufferPercent ?? 0.1, fixedRR: (doc as any).fixedRR ?? 2.0,
            oteEntryPercent: (doc as any).oteEntryPercent ?? 50,
            spreadPips: 0, commissionPerLot: 0, sessions: (doc as any).sessions || {}, enabled: true,
        };
        const prepared: LogEntry[] = await prepareEntries(loadLogs(ticker));
        const res = runBacktest(loadLogs(ticker), baseCfg, undefined, prepared);
        const ts = res.trades.filter(t => Number.isFinite(t.rMultiple));
        const sum = ts.reduce((s, t) => s + (t.rMultiple as number), 0);
        const wins = ts.filter(t => (t.rMultiple as number) > 0);
        const winAvg = wins.length ? wins.reduce((s, t) => s + (t.rMultiple as number), 0) / wins.length : 0;
        const tp2Hit = ts.filter(t => (t as any).resultTp2 === 'WIN').length;
        console.log(`${ticker}: n=${ts.length} ΣR=${sum >= 0 ? '+' : ''}${sum.toFixed(1)} exp=${(sum / Math.max(1, ts.length)).toFixed(2)}R/t WR=${(wins.length / Math.max(1, ts.length) * 100).toFixed(0)}% winMedio=${winAvg.toFixed(2)}R tp2Hit=${tp2Hit}`);
    }
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
