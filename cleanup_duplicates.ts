// cleanup_duplicates.ts — marcar trades duplicados del incidente (bug fallback MARKET).
// NO borra: marca result='SKIP' + duplicated=true para que el diario los excluya.
// Duplicadas (orden MARKET de fallback): O0UUZ7 (EURUSD, posID 284437471), 0RR8QS (GBPUSD, posID 284438142).
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const DUPLICADOS = [
  { id: 'O0UUZ7', posID: '284437471', par: 'EURUSD' },
  { id: '0RR8QS', posID: '284438142', par: 'GBPUSD' },
];

async function main() {
  for (const d of DUPLICADOS) {
    const ref = db.collection('trade_journal').doc(d.id);
    const snap = await ref.get();
    if (!snap.exists) { console.log(`${d.id}: NO existe, skip`); continue; }
    const x = snap.data()!;
    await ref.update({
      result: 'SKIP',
      duplicated: true,
      skipReason: `orden duplicada por bug fallback MARKET (posID ${d.posID}, ${d.par})`,
      cleanedAt: Date.now(),
    });
    console.log(`✅ ${d.id} (${d.par}, posID ${d.posID}): result=${x.result} → SKIP (duplicada)`);
  }
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
