// Inspección de asset_configs (sep-2026): estado actual de sessions de XAUUSD y USDJPY
// + diff contra session_apply de los reports RECOMMEND de la corrida nocturna.
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync } from "node:fs";

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();

    for (const ticker of ["XAUUSD", "USDJPY"]) {
        const doc = await db.collection("asset_configs").doc(ticker).get();
        console.log(`\n════ ${ticker} ════`);
        if (!doc.exists) { console.log("NO EXISTE el doc asset_configs"); continue; }
        const d = doc.data() || {};
        console.log("campos top-level:", Object.keys(d).join(", "));
        const sess = d.sessions || {};
        console.log("sesiones:", Object.keys(sess).join(", "));
        for (const [sk, sv] of Object.entries(sess as Record<string, any>)) {
            console.log(`  ${sk}:`, Object.keys(sv || {}).join(","));
        }
        // Report nocturno
        try {
            const rep = JSON.parse(readFileSync(`/opt/JARVIS/scripts/periodic_opt/reports/${ticker}.json`, "utf8"));
            const sa = rep.session_apply || {};
            console.log("  → session_apply propone sesiones:", Object.keys(sa).join(", "));
            for (const [sk, sv] of Object.entries(sa as Record<string, any>)) {
                for (const [tk, tv] of Object.entries(sv || {})) {
                    const cur = (sess as any)[sk]?.[tk] || {};
                    const changed: string[] = [];
                    for (const [fk, fv] of Object.entries(tv as any)) {
                        if (JSON.stringify(cur[fk]) !== JSON.stringify(fv)) changed.push(`${fk}: ${JSON.stringify(cur[fk])} → ${JSON.stringify(fv)}`);
                    }
                    console.log(`    ${sk}.${tk} ${changed.length ? "Δ " + changed.join(" | ") : "(sin cambios)"}`);
                }
            }
        } catch (e: any) {
            console.log("  report error:", e.message);
        }
    }
    process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
