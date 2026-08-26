import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
async function main() {
  const at = await db.collection('active_trades').get();
  console.log('=== active_trades (' + at.size + ') ===');
  for (const d of at.docs) {
    const x = d.data();
    console.log(JSON.stringify({ id: d.id, ticker: x.ticker, dir: x.direction, journalId: x.journalId ?? '(sin journalId)', tradeId: x.tradeId ?? '(sin)', posID: x.ctraderPositionId ?? '(sin)', tp1Hit: x.tp1Hit ?? false, slPrice: x.slPrice, entry: x.entryPrice, originalSlPrice: x.originalSlPrice }, null, 0));
  }
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
