// Distribución de triggerType GER40 post-fix execTrigger (sep-2026)
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";
import fs from 'node:fs';
import path from 'node:path';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
function loadLogs(ticker: string): Map<string, string[]> {
    const dir = path.join('/opt/JARVIS/logs', ticker.toLowerCase(), 'history_exported');
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
    const doc = (await db.collection("asset_configs").doc("GER40").get()).data() || {};
    const cfg: any = { ticker: "GER40", entryTrigger: (doc as any).entryTrigger || 'SMART',
        minBuyPoints: (doc as any).minPointsForBuy ?? 4, minSellPoints: (doc as any).minPointsForSell ?? 4,
        slBufferPercent: (doc as any).slBufferPercent ?? 0.1, fixedRR: (doc as any).fixedRR ?? 2.0,
        oteEntryPercent: (doc as any).oteEntryPercent ?? 50,
        spreadPips: 0, commissionPerLot: 0, sessions: (doc as any).sessions || {}, enabled: true };
    const prepared = await prepareEntries(loadLogs("GER40"));
    const res = runBacktest(loadLogs("GER40"), cfg, undefined, prepared);
    const by: Record<string, { n: number; r: number }> = {};
    for (const t of res.trades) {
        if (!Number.isFinite(t.rMultiple)) continue;
        const k = t.triggerType || '?';
        by[k] = by[k] || { n: 0, r: 0 };
        by[k].n++; by[k].r += t.rMultiple as number;
    }
    console.log("GER40 post-fix (por gatillo real):");
    for (const [k, v] of Object.entries(by).sort((a, b) => b[1].r - a[1].r)) {
        console.log(`  ${k.padEnd(12)} n=${String(v.n).padEnd(3)} R=${v.r >= 0 ? '+' : ''}${v.r.toFixed(1)}`);
    }
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
