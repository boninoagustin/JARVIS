import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const snap = await db.collection('active_trades').get();
console.log('active_trades docs:', snap.size);
for (const d of snap.docs) {
  console.log('\n===', d.id, '===');
  const x = d.data();
  console.log(JSON.stringify({ticker:x.ticker, dir:x.direction, entry:x.entryPrice, sl:x.slPrice, initialSl:x.initialSlPrice, tp1:x.tp1Price, tp2:x.tp2Price, posID:x.ctraderPositionId, adopted:x.adopted, mgmt:x.mgmtOverrides, tp1Hit:x.tp1Hit, slHalfwayHit:x.slHalfwayHit, roiDecay:x.roiDecayApplied}, null, 1));
}
process.exit(0);
