/**
 * Exporta la colección trade_journal de Firestore a logs/trade_journal_export.json
 * para análisis offline (scripts/analyze_event_edge.py).
 *
 * Uso: npx tsx scripts/export_trade_journal.ts
 */
import admin from 'firebase-admin';
import fs from 'fs';

const credPath = './service-account.json';
if (!fs.existsSync(credPath)) {
    console.error('❌ service-account.json not found!');
    process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));

if (admin.apps.length === 0) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function run() {
    const snap = await db.collection('trade_journal').get();
    const trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Convertir Timestamps de Firestore a ms para serialización limpia
    const clean = JSON.parse(JSON.stringify(trades, (_k, v) =>
        (v && typeof v === 'object' && typeof v.toMillis === 'function') ? v.toMillis() : v
    ));
    const out = 'logs/trade_journal_export.json';
    fs.writeFileSync(out, JSON.stringify(clean, null, 2));
    console.log(`✅ Exportados ${clean.length} trades a ${out}`);
    const closed = clean.filter((t: any) => t.result === 'WIN' || t.result === 'LOSS');
    console.log(`   Cerrados con resultado (WIN/LOSS): ${closed.length}`);
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
