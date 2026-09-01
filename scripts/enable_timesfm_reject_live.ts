// enable_timesfm_reject_live.ts — TimesFM en vivo SOLO-REJECT en los 10 activos del roster.
// timesfm = {enabled:true, dryRun:false, lowConvictionMult:1.0, counterMult:1.0}
// → el REJECT bloquea trades contra el forecast; el REDUCE queda neutralizado (riskMult=1).
// Mergea el bloque timesfm existente (no pisa horizon ni otros campos).
import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];

async function main() {
    for (const t of TICKERS) {
        const ref = db.collection('asset_configs').doc(t);
        const snap = await ref.get();
        if (!snap.exists) { console.log(`⚠️ ${t}: no existe — salteado`); continue; }
        const cur = (snap.data() || {}).timesfm || {};
        const merged = { ...cur, enabled: true, dryRun: false, lowConvictionMult: 1.0, counterMult: 1.0 };
        await ref.update({ timesfm: merged });
        console.log(`✅ ${t}: timesfm = ${JSON.stringify(merged)}`);
    }
    console.log('\nDone. Verificar: audit JSONL con dryRun:false + grep "[TIMESFM" en el log del bot.');
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
