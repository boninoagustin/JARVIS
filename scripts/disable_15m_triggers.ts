// disable_15m_triggers.ts — desactiva los 4 gatillos 15m en todas las sesiones de los 10 activos.
// Evidencia (A/B temporalidades, 8 meses): solo-5M +490R vs base, solo-15M −193R.
// El per_trigger_tune del domingo los excluye (patch aparte) para que no los reactive.
import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];
const T15 = ['choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];

async function main() {
    for (const t of TICKERS) {
        const ref = db.collection('asset_configs').doc(t);
        const snap = await ref.get();
        if (!snap.exists) { console.log(`⚠️ ${t}: no existe`); continue; }
        const d = snap.data() || {};
        const sessions = d.sessions || {};
        let disabled = 0;
        for (const [sess, trigs0] of Object.entries(sessions)) {
            const trigs: any = trigs0 || {};
            for (const g of T15) {
                if (trigs[g] && trigs[g].enabled === true) {
                    trigs[g].enabled = false;
                    disabled++;
                }
            }
        }
        await ref.update({ sessions });
        console.log(`✅ ${t}: ${disabled} gatillos 15m desactivados`);
    }
    console.log('\nDone. El bot los toma por onSnapshot; verificar con backtest (base ≈ solo5m).');
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
