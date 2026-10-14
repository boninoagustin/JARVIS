// ¿Por qué camino entran los trades oteBos15m de GER40 pese al minScore=99? (sep-2026)
// Muestra eventos de cada trade del gatillo + de dónde salió (flujo principal vs fireNow).
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';

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
    const doc = (await db.collection("asset_configs").doc("GER40").get()).data() || {};
    console.log("GER40 sessions.ALL:", JSON.stringify((doc as any).sessions?.ALL?.oteBos15m ?? "sin bloque ALL"));
    console.log("GER40 sessions.LONDON:", JSON.stringify((doc as any).sessions?.LONDON?.oteBos15m ?? "sin bloque"));
    console.log("GER40 sessions.NY:", JSON.stringify((doc as any).sessions?.NY?.oteBos15m ?? "sin bloque"));
    console.log("GER40 sessions.ASIA:", JSON.stringify((doc as any).sessions?.ASIA?.oteBos15m ?? "sin bloque"));
    console.log("GER40 sessions.OFF:", JSON.stringify((doc as any).sessions?.OFF?.oteBos15m ?? "sin bloque"));

    const cfg: any = {
        ticker: "GER40", entryTrigger: (doc as any).entryTrigger || 'SMART',
        minBuyPoints: (doc as any).minPointsForBuy ?? 4, minSellPoints: (doc as any).minPointsForSell ?? 4,
        slBufferPercent: (doc as any).slBufferPercent ?? 0.1, fixedRR: (doc as any).fixedRR ?? 2.0,
        oteEntryPercent: (doc as any).oteEntryPercent ?? 50,
        spreadPips: 0, commissionPerLot: 0, sessions: (doc as any).sessions || {}, enabled: true,
    };
    const prepared = await prepareEntries(loadLogs("GER40"));
    const res = runBacktest(loadLogs("GER40"), cfg, undefined, prepared);
    const targets = res.trades.filter(t => t.triggerType === 'oteBos15m');
    console.log(`trades oteBos15m: ${targets.length}`);
    for (const t of targets.slice(0, 6)) {
        const evs = (t.events || []).slice(-6).join(" | ");
        console.log(`  ${new Date(t.timestamp).toISOString().slice(0,16)} pts=${t.points} r=${t.rMultiple?.toFixed(2)} evs: ${evs}`);
    }
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
