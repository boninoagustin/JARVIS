import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
async function main() {
  for (const id of ['YJ36PH', 'AG2E76', 'ORH4Y1']) {
    const d = await db.collection('trade_journal').doc(id).get();
    console.log('===== ' + id + ' =====');
    console.log(JSON.stringify(d.data(), null, 2));
  }
  // active_trades actuales
  const at = await db.collection('active_trades').get();
  console.log('\n===== active_trades (' + at.size + ') =====');
  for (const d of at.docs) {
    const x = d.data();
    console.log(d.id, '|', x.ticker, '|', x.direction, '| posID=' + (x.ctraderPositionId ?? '?'), '| tp1Hit=' + (x.tp1Hit ?? false), '| slPrice=' + x.slPrice, '| entry=' + x.entryPrice);
  }
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
