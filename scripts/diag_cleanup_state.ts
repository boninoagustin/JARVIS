// Limpieza puntual post-fix breakeven (ago-2026):
// 1) Borrar gemelos zombie de active_trades (sin ctraderPositionId, duplicados de posiciones vivas).
// 2) Inspeccionar RNES8A para resolverlo.
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function main() {
  // 1) Ver el estado actual antes de tocar nada
  const at = await db.collection('active_trades').get();
  console.log('=== active_trades ANTES ===');
  for (const d of at.docs) {
    const x = d.data();
    console.log(d.id, '|', x.ticker, x.direction, '| posID=', x.ctraderPositionId, '| journalId=', x.journalId);
  }

  // 2) RNES8A: ver qué contiene
  const r = await db.collection('trade_journal').doc('RNES8A').get();
  if (r.exists) {
    console.log('\n=== RNES8A doc ===');
    console.log(JSON.stringify(r.data(), null, 2).slice(0, 1500));
  } else {
    console.log('\nRNES8A no existe');
  }

  // 3) Journals abiertos sin posID (para ver si hay más zombies)
  const js = await db.collection('trade_journal').get();
  console.log('\n=== journals abiertos (result=null) ===');
  for (const d of js.docs) {
    const x = d.data();
    if (!x.result && x.mode !== 'backtesting') {
      console.log(d.id, '|', x.ticker, x.direction, '| posID=', x.ctraderPositionId, '| adopted=', x.adopted, '| entry=', x.entryPrice, '| ts=', x.timestamp, '| grade=', x.grade);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
