// Limpieza puntual post-fix breakeven (ago-2026) — ONE-SHOT.
// 1) Borrar gemelos zombie de active_trades (sin ctraderPositionId):
//    - 9DMR2C  (USOIL, duplicado de ET86U1 que SÍ tiene posID 284987130)
//    - IXDT52  (USDJPY, duplicado de 0INVS9 que SÍ tiene posID 284987105)
// 2) Borrar journal duplicado RNES8A (duplicateOf=SCFTZQ; el keeper tiene el WIN real).
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
  const zombies = ['9DMR2C', 'IXDT52'];
  for (const id of zombies) {
    const d = await db.collection('active_trades').doc(id).get();
    if (!d.exists) { console.log(`${id}: no existe, skip`); continue; }
    const x = d.data();
    if (x?.ctraderPositionId) {
      console.log(`⛔ ABORT ${id}: ahora TIENE posID=${x.ctraderPositionId} — no es zombie, no se borra.`);
      continue;
    }
    await db.collection('active_trades').doc(id).delete();
    console.log(`🗑️ Borrado zombie active_trades/${id} (${x?.ticker} ${x?.direction}, journal=${x?.journalId})`);
  }

  const r = await db.collection('trade_journal').doc('RNES8A').get();
  if (r.exists) {
    await db.collection('trade_journal').doc('RNES8A').delete();
    console.log('🗑️ Borrado journal duplicado RNES8A (keeper SCFTZQ ya tiene WIN)');
  } else {
    console.log('RNES8A ya no existe');
  }

  // Verificación final
  const at = await db.collection('active_trades').get();
  console.log('\n=== active_trades DESPUÉS ===');
  for (const d of at.docs) {
    const x = d.data();
    console.log(d.id, '|', x.ticker, x.direction, '| posID=', x.ctraderPositionId, '| journalId=', x.journalId);
  }
  const js = await db.collection('trade_journal').get();
  console.log('\n=== journals abiertos DESPUÉS ===');
  for (const d of js.docs) {
    const x = d.data();
    if (!x.result && x.mode !== 'backtesting') {
      console.log(d.id, '|', x.ticker, x.direction, '| posID=', x.ctraderPositionId);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
