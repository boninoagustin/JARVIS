// Refuerza el apagado de gatillos perdedores (sep-2026): minScore=99 (apagado efectivo en SMART).
// Contexto: en modo SMART el enabled:false NO frena la OTE (AlphaModel L347-349 sobrescribe
// oteEnabled=true) — pero el minScore del gatillo SÍ aplica (totalPoints < oteMinScore → muerte).
// minScore 99 = inalcanzable (max ~50 pts). Aplica a los 7 perdedores marcados.
// Backup local previo. Uso: npx tsx scripts/apply_loser_minscore.ts
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
        writeFileSync(`${backupDir}/asset_configs_${ticker}_${stamp}_pre_min99.json`, JSON.stringify(prev, null, 2));

        const sessions = JSON.parse(JSON.stringify(prev.sessions || {}));
        let touched = 0;
        for (const [sess, trigsOfSess] of Object.entries(sessions as Record<string, any>)) {
            for (const trig of trigs) {
                const block = (trigsOfSess && trigsOfSess[trig]) || null;
                if (!block) { trigsOfSess[trig] = { enabled: false, minScore: 99 }; touched++; continue; }
                if (block.minScore !== 99 || block.enabled !== false) {
                    trigsOfSess[trig] = { ...block, enabled: false, minScore: 99 };
                    touched++;
                }
            }
        }
        await ref.update({
            sessions,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: "hermes-apply-loser-min99",
        });
        console.log(`${ticker}: ✅ minScore=99 + enabled=false en ${trigs.join(", ")} (${touched} bloques)`);
    }
    process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
