// enable_correlation_live.ts — activa el bloqueo real del filtro de correlación
// escribe asset_configs/{TICKER}.correlationFilter = {shadow:false} (defaults para el resto).
import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Los 10 activos del roster vivo (los 3 en killswitch NO)
const TICKERS = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];

async function main() {
    for (const t of TICKERS) {
        const ref = db.collection('asset_configs').doc(t);
        const snap = await ref.get();
        if (!snap.exists) { console.log(`⚠️ ${t}: no existe, salteado`); continue; }
        await ref.update({ correlationFilter: { shadow: false } });
        console.log(`✅ ${t}: correlationFilter = {shadow:false} (bloqueo real ACTIVO)`);
    }
    console.log('\nDone. Verificar con: grep "CORRELATION" ~/.pm2/logs/JARVIS-out.log | tail');
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
