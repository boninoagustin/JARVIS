// cleanup_us500.ts — corregir 2 trades US500 "fantasma": orden abortada en cTrader (volumen < mínimo)
// pero el bot los contabilizó como LOSS y disparó el killswitch. Se marcan SKIP + se documenta.
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const FANTASMAS = [
  { id: 'XSHTRC', hora: '02:55 ART' },
  { id: 'W9ZWOE', hora: '08:10 ART' },
];

async function main() {
  for (const f of FANTASMAS) {
    const ref = db.collection('trade_journal').doc(f.id);
    const snap = await ref.get();
    if (!snap.exists) { console.log(`${f.id}: NO existe`); continue; }
    const x = snap.data()!;
    await ref.update({
      result: 'SKIP',
      duplicated: false,
      skipReason: `Orden abortada en cTrader (volumen < mínimo del broker). Nunca se abrió posición.`,
      ctraderStatus: 'ABORTED',
      ctraderError: 'Volumen requerido exacto menor al mínimo del broker (US500)',
      rMultiple: 0,
      cleanedAt: Date.now(),
    });
    console.log(`✅ ${f.id} (${f.hora}): result=${x.result} → SKIP, rMultiple=${x.rMultiple} → 0`);
  }
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
