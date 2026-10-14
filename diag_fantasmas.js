import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const fmt = (t) => t ? new Date(t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—';
// active_trades completo con timestamps
const at = await db.collection('active_trades').get();
console.log('=== active_trades (', at.size, ') ===');
for (const d of at.docs) {
  const x = d.data();
  console.log(JSON.stringify({id: d.id, ticker: x.ticker, dir: x.direction, entry: x.entryPrice, posID: x.ctraderPositionId ?? '—', ts: fmt(x.timestamp), adopted: x.adopted ?? false, journalId: x.journalId ?? '—', isBacktest: x.isBacktest ?? false}));
}
// journals abiertos (sin result)
const j = await db.collection('trade_journal').where('result', '==', null).get();
console.log('\n=== trade_journal abiertos (', j.size, ') ===');
for (const d of j.docs) {
  const x = d.data();
  console.log(JSON.stringify({id: d.id, ticker: x.ticker, dir: x.direction, entry: x.entryPrice, posID: x.ctraderPositionId ?? '—', ts: fmt(x.timestamp), adopted: x.adopted ?? false}));
}
process.exit(0);
