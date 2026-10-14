// A/B de longitud de TP (sep-2026, hipótesis de Bon: "los TP son muy largos y los wins no llegan").
// Para EURUSD/GBPJPY/XAUUSD con la config de PRODUCCIÓN real:
//   A = tal cual | B = tp2 por gatillo ×0.6 (TP más cortos) | C = tp1StructuralMinRR 1.0 (TP1 menos exigente)
// Mide ΣR, exp, WR, win medio. Uso: npx tsx scripts/diag_tp_ab.ts
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

function scaleSessions(sessions: any, mode: 'A' | 'B' | 'C'): any {
    const out = JSON.parse(JSON.stringify(sessions));
    for (const sess of Object.values(out) as any[]) {
        for (const [key, blk] of Object.entries(sess as any)) {
            if (!blk || typeof blk !== 'object') continue;
            if (mode === 'B' && typeof blk.tp2 === 'number' && blk.tp2 > 1) blk.tp2 = +(blk.tp2 * 0.6).toFixed(2);
            if (mode === 'C' && blk.tp1StructuralMinRR !== undefined) blk.tp1StructuralMinRR = 1.0;
        }
    }
    return out;
}

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();

    for (const ticker of ['EURUSD', 'GBPJPY', 'XAUUSD']) {
        const doc = (await db.collection("asset_configs").doc(ticker).get()).data() || {};
        const baseCfg: any = {
            ticker, entryTrigger: (doc as any).entryTrigger || 'SMART',
            minBuyPoints: (doc as any).minPointsForBuy ?? 4, minSellPoints: (doc as any).minPointsForSell ?? 4,
            slBufferPercent: (doc as any).slBufferPercent ?? 0.1, fixedRR: (doc as any).fixedRR ?? 2.0,
            oteEntryPercent: (doc as any).oteEntryPercent ?? 50,
            spreadPips: 0, commissionPerLot: 0, sessions: (doc as any).sessions || {}, enabled: true,
        };
        const prepared: LogEntry[] = await prepareEntries(loadLogs(ticker));
        const rows: string[] = [];
        for (const mode of ['A', 'B', 'C'] as const) {
            const cfg = { ...baseCfg, sessions: scaleSessions(baseCfg.sessions, mode) };
            const res = runBacktest(loadLogs(ticker), cfg, undefined, prepared);
            const ts = res.trades.filter(t => Number.isFinite(t.rMultiple));
            const sum = ts.reduce((s, t) => s + (t.rMultiple as number), 0);
            const wins = ts.filter(t => (t.rMultiple as number) > 0);
            const winAvg = wins.length ? wins.reduce((s, t) => s + (t.rMultiple as number), 0) / wins.length : 0;
            const tp2Hit = ts.filter(t => t.resultTp2 === 'WIN').length;
            rows.push(`${mode}: n=${ts.length} ΣR=${sum >= 0 ? '+' : ''}${sum.toFixed(1)} exp=${(sum / Math.max(1, ts.length)).toFixed(2)} WR=${(wins.length / Math.max(1, ts.length) * 100).toFixed(0)}% winMedio=${winAvg.toFixed(2)}R tp2Hit=${tp2Hit}`);
        }
        console.log(`${ticker}:`);
        rows.forEach(r => console.log(`  ${r}`));
    }
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
