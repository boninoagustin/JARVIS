// apply_15m_policy.ts (11-sep-2026, OK Bon) — política gatillo-por-gatillo:
// ENCENDER: AUDJPY.oteChoch15m (+0.576R/t, n=20), XAUUSD.oteChoch15m (+0.167R/t, n=25)
// APAGAR:   USDJPY.oteBos15m (perdedor encendido: prod -0.562, sonda -0.493, n=4)
// Backup del doc previo por activo en backups/. Uso: npx tsx scripts/apply_15m_policy.ts
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CHANGES: { ticker: string; trigger: string; action: 'on' | 'off' }[] = [
    { ticker: 'AUDJPY', trigger: 'oteChoch15m', action: 'on' },
    { ticker: 'XAUUSD', trigger: 'oteChoch15m', action: 'on' },
    { ticker: 'USDJPY', trigger: 'oteBos15m', action: 'off' },
];
const SESSIONS = ['ASIA', 'LONDON', 'NY', 'OFF'];

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();

    for (const c of CHANGES) {
        const ref = db.collection("asset_configs").doc(c.ticker);
        const doc = await ref.get();
        if (!doc.exists) { console.log(`⚠ ${c.ticker}: doc no existe`); continue; }
        const d = JSON.parse(JSON.stringify(doc.data() || {}));
        mkdirSync("/opt/JARVIS/backups", { recursive: true });
        const bkp = `/opt/JARVIS/backups/asset_configs_${c.ticker}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
        writeFileSync(bkp, JSON.stringify(d, null, 2));

        d.sessions = d.sessions || {};
        for (const s of SESSIONS) {
            d.sessions[s] = d.sessions[s] || {};
            d.sessions[s][c.trigger] = c.action === 'on'
                ? { enabled: true, minScore: 4 }
                : { enabled: false, minScore: 99 };
        }
        await ref.set(d, { merge: true });
        console.log(`${c.action === 'on' ? '🟢 ENCENDER' : '🔴 APAGAR'} ${c.ticker}.${c.trigger} | backup ${bkp.split('/').pop()}`);
    }
    console.log("done");
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
