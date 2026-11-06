/**
 * Preserva el journal de trades en un archivo JSONL local (acumulativo).
 * A diferencia de export_trade_journal.ts (sobrescribe), este MERGEA por id:
 * - solo trades CERRADOS (WIN/LOSS) con su rMultiple final.
 * - un trade ya guardado se actualiza si cambió su estado.
 * Idempotente: se puede correr cada pocas horas sin duplicar.
 *
 * Uso: npx tsx scripts/export_trade_journal_append.ts
 */
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const CRED = '/opt/JARVIS/service-account.json';
const OUT = '/opt/JARVIS/logs/market_intel/trades.jsonl';

if (!fs.existsSync(CRED)) {
    console.error('❌ service-account.json no encontrado');
    process.exit(1);
}
if (admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(CRED, 'utf8'))) });
}
const db = admin.firestore();

async function run() {
    const snap = await db.collection('trade_journal').get();
    const closed = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .filter(t => t.result === 'WIN' || t.result === 'LOSS');

    // limpiar Timestamps de Firestore a ms
    const clean = JSON.parse(JSON.stringify(closed, (_k, v) =>
        (v && typeof v === 'object' && typeof v.toMillis === 'function') ? v.toMillis() : v
    ));

    // merge por id: el estado nuevo pisa al viejo
    const map = new Map<string, any>();
    if (fs.existsSync(OUT)) {
        for (const line of fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean)) {
            try { const o = JSON.parse(line); if (o.id) map.set(o.id, o); } catch { /* skip */ }
        }
    }
    for (const t of clean) map.set(t.id, t);

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const lines = [...map.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    fs.writeFileSync(OUT, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    console.log(`[TRADE-EXPORT] ${map.size} trades cerrados preservados (colección actual: ${closed.length})`);
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
