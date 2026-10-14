// Aplica el trigger-state del paso 8 (reports/loser_triggers_proposal.json) a Firestore:
//   disables → minScore=99 en todos los bloques de sesión del gatillo (crea si falta)
//   enables  → minScore=4 + enabled:true en todos los bloques (crea si falta)
// Backup local del doc previo por activo en backups/. Uso: npx tsx scripts/apply_trigger_state.ts
import * as adminModule from "firebase-admin";
const admin: any = (adminModule as any).default ?? adminModule;
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const TRIGGERS = ['choch5m', 'bos5m', 'choch15m', 'bos15m', 'oteChoch5m', 'oteBos5m', 'oteChoch15m', 'oteBos15m'];
const SESSIONS = ['ASIA', 'LONDON', 'NY', 'OFF'];

async function main() {
    const key = JSON.parse(readFileSync("/opt/JARVIS/firebase-key.json", "utf8"));
    if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(key) });
    const db = admin.firestore();
    const st = JSON.parse(readFileSync("/opt/JARVIS/scripts/periodic_opt/reports/loser_triggers_proposal.json", "utf8"));

    const jobs: { ticker: string; trigger: string; action: 'off' | 'on' }[] = [];
    // Exclusión manual: gatillos con señal conflictiva (producción pierde, sonda gana)
    // 🆕 11-sep-2026: AUDJPY.oteChoch15m ya NO está excluido — política solo-5M derogada
    // (Bon aprobó gatillo-por-gatillo tras medir los 15m ganadores).
    const EXCLUDE = new Set(['GBPJPY:oteBos5m']);
    for (const p of st.disables || []) jobs.push({ ticker: p.ticker, trigger: p.trigger, action: 'off' });
    for (const p of st.enables || []) {
        if (EXCLUDE.has(`${p.ticker}:${p.trigger}`)) { console.log(`⏭ excluido (conflicto): ${p.ticker}.${p.trigger}`); continue; }
        jobs.push({ ticker: p.ticker, trigger: p.trigger, action: 'on' });
    }
    if (!jobs.length) { console.log("nada que aplicar"); process.exit(0); }

    const byTicker = new Map<string, typeof jobs>();
    for (const j of jobs) {
        if (!byTicker.has(j.ticker)) byTicker.set(j.ticker, []);
        byTicker.get(j.ticker)!.push(j);
    }

    for (const [ticker, jj] of byTicker) {
        const ref = db.collection("asset_configs").doc(ticker);
        const doc = await ref.get();
        if (!doc.exists) { console.log(`⚠ ${ticker}: doc no existe`); continue; }
        const d = JSON.parse(JSON.stringify(doc.data() || {}));
        mkdirSync("/opt/JARVIS/backups", { recursive: true });
        const bkp = `/opt/JARVIS/backups/asset_configs_${ticker}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
        writeFileSync(bkp, JSON.stringify(d, null, 2));

        d.sessions = d.sessions || {};
        for (const j of jj) {
            if (!TRIGGERS.includes(j.trigger)) { console.log(`⚠ ${ticker}: gatillo desconocido ${j.trigger}`); continue; }
            for (const s of SESSIONS) {
                d.sessions[s] = d.sessions[s] || {};
                if (!d.sessions[s][j.trigger]) {
                    d.sessions[s][j.trigger] = { enabled: j.action === 'on', minScore: j.action === 'off' ? 99 : 4 };
                } else {
                    // 10-sep: apagado = enabled:false + minScore:99 (panel coherente + llave OTE efectiva);
                    // activado = enabled:true + minScore:4.
                    d.sessions[s][j.trigger].minScore = j.action === 'off' ? 99 : 4;
                    d.sessions[s][j.trigger].enabled = j.action === 'on';
                }
            }
        }
        await ref.set(d, { merge: true });
        console.log(`${ticker}: ${jj.map(j => `${j.action === 'off' ? '🔴' : '🟢'} ${j.trigger}`).join(' · ')} | backup ${path.basename(bkp)}`);
    }
    console.log("done");
    process.exit(0);
}
main().catch(e => { console.error("ERR", e.message); process.exit(1); });
