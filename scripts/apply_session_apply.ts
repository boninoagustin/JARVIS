// Aplica session_apply de los reports RECOMMEND a asset_configs en Firestore.
// Merge gatillo-por-gatillo (preserva todo lo no propuesto), backup local del doc previo,
// filtra campos null de la propuesta (el zod del bot rechaza null en minimal_roi etc).
// El bot aplica en caliente vía onSnapshot (sin restart).
// Uso: npx tsx scripts/apply_session_apply.ts GBPUSD [AUDCAD NZDUSD...]
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const TICKERS = process.argv.slice(2);

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const backupDir = "/opt/JARVIS/backups";
    mkdirSync(backupDir, { recursive: true });

    for (const ticker of TICKERS) {
        const rep = JSON.parse(readFileSync(`/opt/JARVIS/scripts/periodic_opt/reports/${ticker}.json`, "utf8"));
        const sa = rep.session_apply;
        if (!sa || typeof sa !== "object") {
            console.log(`${ticker}: sin session_apply en el reporte — skip`);
            continue;
        }
        const ref = db.collection("asset_configs").doc(ticker);
        const doc = await ref.get();
        if (!doc.exists) {
            console.log(`${ticker}: doc NO existe — aborto (no crear docs nuevos)`);
            continue;
        }
        const prev = doc.data() || {};

        // Backup local completo
        const bpath = `${backupDir}/asset_configs_${ticker}_${stamp}.json`;
        writeFileSync(bpath, JSON.stringify(prev, null, 2));
        console.log(`${ticker}: backup → ${bpath}`);

        // Merge gatillo-por-gatillo, filtrando null/undefined de la propuesta
        const sessions = JSON.parse(JSON.stringify(prev.sessions || {}));
        let appliedBlocks = 0, skippedNull = 0;
        const clean = (o: any) => {
            const out: any = {};
            for (const [k, v] of Object.entries(o)) {
                if (v === null || v === undefined) { skippedNull++; continue; }
                out[k] = v;
            }
            return out;
        };
        for (const [sess, triggers] of Object.entries(sa as Record<string, any>)) {
            if (!sessions[sess]) sessions[sess] = {};
            for (const [trig, fields] of Object.entries(triggers || {})) {
                const cleaned = clean(fields);
                sessions[sess][trig] = { ...(sessions[sess][trig] || {}), ...cleaned };
                appliedBlocks++;
            }
        }

        await ref.update({
            sessions,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: "hermes-apply-session-apply",
        });
        console.log(`${ticker}: ✅ ${appliedBlocks} bloques mergeados (${skippedNull} campos null filtrados)`);

        // Verificación post-escritura
        const after = (await ref.get()).data() || {};
        const ok = JSON.stringify(after.sessions) === JSON.stringify(sessions);
        console.log(`${ticker}: verificación post-escritura: ${ok ? "OK ✓" : "⚠️ MISMATCH"}`);
    }
    process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
