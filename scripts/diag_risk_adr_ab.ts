// A/B del gate de riesgo por ADR (sep-2026, hipótesis de Bon: "con esa regla la mayoría no entra").
// Mide con la config de PRODUCCIÓN de cada activo: qué % de trades tiene risk > umbral×ADR,
// y cuánto aportan esos trades al PnL. Umbrales: 0.5×ADR y 0.6×ADR.
// NO toca nada — solo mide. Uso: npx tsx scripts/diag_risk_adr_ab.ts
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

const ADR: Record<string, number> = {
    EURUSD: 0.00474, GBPUSD: 0.00591, AUDCAD: 0.00458, NZDUSD: 0.00383,
    USDJPY: 1.221, GBPJPY: 0.7785, AUDJPY: 0.54145, XAUUSD: 80.04,
    US500: 76.29, GER40: 191.8,
};

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

    const tot: Record<string, { n: number; r: number; highN: number; highR: number }> = { '0.5': { n: 0, r: 0, highN: 0, highR: 0 }, '0.6': { n: 0, r: 0, highN: 0, highR: 0 } };

    for (const ticker of Object.keys(ADR)) {
        const doc = await db.collection("asset_configs").doc(ticker).get();
        if (!doc.exists) continue;
        const d = doc.data() || {};
        const cfg: any = {
            ticker, entryTrigger: d.entryTrigger || 'SMART',
            minBuyPoints: d.minPointsForBuy ?? 4, minSellPoints: d.minPointsForSell ?? 4,
            slBufferPercent: d.slBufferPercent ?? 0.1, fixedRR: d.fixedRR ?? 2.0,
            oteEntryPercent: d.oteEntryPercent ?? 50,
            spreadPips: 0, commissionPerLot: 0, sessions: d.sessions || {}, enabled: true,
        };
        const logs = loadLogs(ticker);
        if (!logs.has('M5')) continue;
        const prepared: LogEntry[] = await prepareEntries(logs);
        const res = runBacktest(logs, cfg, undefined, prepared);
        const ts = res.trades.filter(t => Number.isFinite(t.rMultiple) && Number.isFinite(t.slPrice) && t.slPrice !== t.entryPrice);
        const adr = ADR[ticker];
        const rows: string[] = [];
        for (const [label, mult] of [['0.5', 0.5], ['0.6', 0.6]] as const) {
            const high = ts.filter(t => Math.abs(t.entryPrice - t.slPrice) > adr * mult);
            const keep = ts.filter(t => Math.abs(t.entryPrice - t.slPrice) <= adr * mult);
            const rAll = ts.reduce((s, t) => s + (t.rMultiple as number), 0);
            const rKeep = keep.reduce((s, t) => s + (t.rMultiple as number), 0);
            const rHigh = high.reduce((s, t) => s + (t.rMultiple as number), 0);
            const expAll = rAll / Math.max(1, ts.length);
            const expKeep = rKeep / Math.max(1, keep.length);
            const pct = (high.length / Math.max(1, ts.length) * 100).toFixed(0);
            rows.push(`  ${label}×ADR: ${high.length}/${ts.length} trades fuera (${pct}%) | ΣR total ${rAll >= 0 ? '+' : ''}${rAll.toFixed(1)} → sin ellos ${rKeep >= 0 ? '+' : ''}${rKeep.toFixed(1)} (fuera aportan ${rHigh >= 0 ? '+' : ''}${rHigh.toFixed(1)}) | exp ${expAll.toFixed(2)} → ${expKeep.toFixed(2)}`);
            tot[label].n += ts.length; tot[label].r += rAll; tot[label].highN += high.length; tot[label].highR += rHigh;
        }
        console.log(`${ticker} (${ts.length}t):`);
        rows.forEach(r => console.log(r));
    }
    console.log('\n══ TOTAL ══');
    for (const [label, v] of Object.entries(tot)) {
        const keepR = v.r - v.highR;
        const keepN = v.n - v.highN;
        console.log(`  ${label}×ADR: ${v.highN}/${v.n} trades fuera (${(v.highN / Math.max(1, v.n) * 100).toFixed(0)}%) | ΣR ${v.r >= 0 ? '+' : ''}${v.r.toFixed(1)} → sin ellos ${keepR >= 0 ? '+' : ''}${keepR.toFixed(1)} | exp ${(v.r / Math.max(1, v.n)).toFixed(2)} → ${(keepR / Math.max(1, keepN)).toFixed(2)}`);
    }
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
