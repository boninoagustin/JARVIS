// push_reports.js — sube reports/*.json a Firestore (opt_reports/{ticker}).
// Uso: npx tsx scripts/periodic_opt/push_reports.js
import { readFileSync, readdirSync } from 'node:fs';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const sa = JSON.parse(readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
    const dir = '/opt/JARVIS/scripts/periodic_opt/reports';
    // 🆕 21-sep-2026: subir SOLO reportes de ticker (^[A-Z][A-Z0-9]*\.json$) + los dos docs
    // especiales que el panel consume (ASSET_SCOUT, LOSER_TRIGGERS_PROPOSAL). Antes se subía
    // TODO (current_sessions_*, trigger_tune_*, sizing_*, prev_*, parity_*) y el panel
    // renderizaba tarjetas fantasma duplicadas (esos archivos traen ticker adentro).
    const files = readdirSync(dir).filter(f => {
        const base = f.replace('.json', '');
        return /^[A-Z][A-Z0-9]*$/.test(base)
            || f === 'asset_scout.json'
            || f === 'loser_triggers_proposal.json';
    });
    if (files.length === 0) { console.log('sin reportes para subir'); process.exit(0); }
    for (const f of files) {
        const ticker = f.replace('.json', '').toUpperCase();
        const report = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
        // 🛡️ sep-2026: Firestore rechaza arrays/null — los dumps MC (sizing_mc_*.json)
        // son arrays y rompían el push completo (el loop no tenía try/catch por archivo).
        if (!report || typeof report !== 'object' || Array.isArray(report)) {
            console.log(`⏭ ${f} omitido (no es objeto — dump temporal, no es reporte)`);
            continue;
        }
        // 🛡️ 13-sep-2026: set() completo pisaba appliedAt/appliedBy/new_trades cuando Bon
        // ya había aplicado el reporte y un re-push del MISMO reporte (mismo timestamp)
        // lo re-escribía → el panel perdía el badge "✓ APLICADA". Fix: preservar el
        // marcador si el doc actual tiene el MISMO timestamp (mismo reporte). Si el
        // timestamp difiere es un reporte NUEVO → no preservar (volver a decidir).
        const ref = db.collection('opt_reports').doc(ticker);
        let payload = { ...report };
        try {
            const prevSnap = await ref.get();
            if (prevSnap.exists) {
                const prev = prevSnap.data() || {};
                if (prev.timestamp === report.timestamp && prev.appliedAt !== undefined) {
                    payload.appliedAt = prev.appliedAt;
                    payload.appliedBy = prev.appliedBy;
                    if (prev.new_trades !== undefined) payload.new_trades = prev.new_trades;
                    console.log(`✓ opt_reports/${ticker} → status ${report.status} (preservando aplicado)`);
                } else {
                    console.log(`✓ opt_reports/${ticker} → status ${report.status}`);
                }
            } else {
                console.log(`✓ opt_reports/${ticker} → status ${report.status} (nuevo)`);
            }
        } catch (e) {
            console.log(`✓ opt_reports/${ticker} → status ${report.status} (sin doc previo)`);
        }
        await ref.set(payload);
    }
    process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
