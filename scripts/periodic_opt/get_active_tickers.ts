// get_active_tickers.ts — lee optimization_config/active_tickers de Firestore.
// Si el doc no existe o la lista está vacía, devuelve el fallback (TICKERS_ALL clásico).
// Uso: npx tsx scripts/periodic_opt/get_active_tickers.ts → imprime JSON {"tickers":[...]}
import { readFileSync } from 'node:fs';
import adminModule from 'firebase-admin';
const admin: any = (adminModule as any).default ?? adminModule;
const sa = JSON.parse(readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const FALLBACK = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40', 'JP225'];

async function main() {
    try {
        const snap = await db.collection('optimization_config').doc('active_tickers').get();
        const data = snap.exists ? snap.data() || {} : {};
        const list = Array.isArray(data.tickers) ? data.tickers.filter((t: any) => typeof t === 'string' && t.length > 0) : [];
        const tickers = list.length ? list : FALLBACK;
        console.log(JSON.stringify({ tickers, source: list.length ? 'firestore' : 'fallback' }));
    } catch (e: any) {
        console.log(JSON.stringify({ tickers: FALLBACK, source: 'fallback', error: String(e?.message || e).slice(0, 120) }));
    }
    process.exit(0);
}
main();
