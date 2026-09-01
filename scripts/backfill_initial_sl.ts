// backfill_initial_sl.ts — backfill de initialSlPrice en active_trades desde el journal.
// El journal conserva el SL estructural ORIGINAL (nunca se re-escribe con el SL vigente);
// sin este campo el PnL (R) del panel se calcula contra el SL movido (BE/trailing) y explota.
import admin from 'firebase-admin';
import fs from 'fs';

const serviceAccount = JSON.parse(fs.readFileSync('./service-account.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
    const snap = await db.collection('active_trades').get();
    let fixed = 0;
    for (const doc of snap.docs) {
        const d = doc.data();
        if (d.initialSlPrice != null || d.originalSlPrice != null) continue;
        const ticker = d.ticker;
        if (!ticker) continue;
        // Fuente 1: journal por tradeId
        const j1 = await db.collection('trade_journal').doc(doc.id).get();
        let sl: number | null = null;
        if (j1.exists && j1.data()?.slPrice != null) {
            sl = Number(j1.data()!.slPrice);
        }
        if (sl == null || !Number.isFinite(sl)) {
            // Fuente 2: journal por ctraderPositionId
            const q = await db.collection('trade_journal').where('ctraderPositionId', '==', String(d.ctraderPositionId ?? '')).limit(1).get();
            for (const jd of q.docs) {
                if (jd.data().slPrice != null) { sl = Number(jd.data().slPrice); break; }
            }
        }
        if (sl != null && Number.isFinite(sl) && sl > 0) {
            await doc.ref.update({ initialSlPrice: sl });
            console.log(`✅ ${doc.id} (${ticker}): initialSlPrice = ${sl} ← journal`);
            fixed++;
        } else {
            console.log(`⚠️ ${doc.id} (${ticker}): sin SL estructural en el journal — salteado (usará slPrice vigente)`);
        }
    }
    console.log(`\nBackfill: ${fixed} docs actualizados. El bot los toma por onSnapshot en segundos.`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
