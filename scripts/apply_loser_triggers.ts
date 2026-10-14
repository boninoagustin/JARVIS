// Apaga gatillos perdedores (sep-2026, aprobado por Bon): enabled=false en TODAS las sesiones
// para los 7 gatillos marcados por diag_loser_triggers (n>=10, exp<=-0.15, config de producción).
// Merge quirúrgico: solo toca esos gatillos, backup local del doc previo. Uso: npx tsx scripts/apply_loser_triggers.ts
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const LOSERS: Record<string, string[]> = {
    EURUSD: ["oteChoch15m"],
    AUDCAD: ["oteBos5m", "oteBos15m"],
    US500: ["oteChoch15m"],
    NZDUSD: ["oteChoch15m"],
    GBPJPY: ["oteBos5m"],
    GER40: ["oteBos15m"],
};

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const backupDir = "/opt/JARVIS/backups";
    mkdirSync(backupDir, { recursive: true });

    for (const [ticker, trigs] of Object.entries(LOSERS)) {
        const ref = db.collection("asset_configs").doc(ticker);
        const doc = await ref.get();
        if (!doc.exists) { console.log(`${ticker}: doc no existe — skip`); continue; }
        const prev = doc.data() || {};
        writeFileSync(`${backupDir}/asset_configs_${ticker}_${stamp}_pre_losers.json`, JSON.stringify(prev, null, 2));

        const sessions = JSON.parse(JSON.stringify(prev.sessions || {}));
        let touched = 0;
        for (const [sess, trigsOfSess] of Object.entries(sessions as Record<string, any>)) {
            for (const trig of trigs) {
                if (trigsOfSess && trigsOfSess[trig] && trigsOfSess[trig].enabled !== false) {
                    trigsOfSess[trig] = { ...trigsOfSess[trig], enabled: false };
                    touched++;
                }
            }
        }
        if (touched === 0) { console.log(`${ticker}: nada que apagar (ya estaban off)`); continue; }
        await ref.update({
            sessions,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: "hermes-apply-loser-triggers",
        });
        console.log(`${ticker}: ✅ ${touched} bloques apagados (${trigs.join(", ")}) | backup: ${backupDir}/asset_configs_${ticker}_${stamp}_pre_losers.json`);
    }
    process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
