import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";
async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();
    for (const ticker of ["NZDUSD", "EURUSD"]) {
        const doc = (await db.collection("asset_configs").doc(ticker).get()).data() || {};
        const s: any = doc.sessions || {};
        console.log(`--- ${ticker} ---`);
        for (const sess of ["ASIA", "LONDON", "NY", "OFF"]) {
            const b = s[sess] || {};
            const o15 = b.oteChoch15m;
            console.log(`  ${sess}.oteChoch15m: ${o15 ? JSON.stringify({ enabled: o15.enabled, minScore: o15.minScore }) : "SIN BLOQUE"}`);
        }
    }
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
