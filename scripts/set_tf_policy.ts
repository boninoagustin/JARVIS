// set_tf_policy.ts — política de temporalidades: 5m ON / 15m OFF en todas las sesiones.
// Evidencia (A/B 10 tickers, 8 meses): solo-5M (todos los 5m prendidos) = 1010R vs base 519.5R.
import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];
const T5 = ['choch5m', 'bos5m', 'oteChoch5m', 'oteBos5m'];
const T15 = ['choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];
const SESSIONS = ['LONDON', 'NY', 'ASIA', 'OFF', 'ALL'];

async function main() {
    for (const t of TICKERS) {
        const ref = db.collection('asset_configs').doc(t);
        const snap = await ref.get();
        if (!snap.exists) { console.log(`⚠️ ${t}: no existe`); continue; }
        const d = snap.data() || {};
        const sessions = d.sessions || {};
        let on = 0, off = 0;
        for (const sess of Object.keys(sessions)) {
            if (!SESSIONS.includes(sess)) continue;
            const trigs = sessions[sess] || {};
            for (const g of T5) {
                if (trigs[g]) { trigs[g].enabled = true; on++; }
            }
            for (const g of T15) {
                if (trigs[g]) { trigs[g].enabled = false; off++; }
            }
        }
        await ref.update({ sessions });
        console.log(`✅ ${t}: 5m ON (${on}), 15m OFF (${off})`);
    }
    console.log('\nDone. Verificar: base ≈ solo5m en only_tf_ab.ts.');
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
