import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
async function main() {
  for (const id of ['ALDQAU','AG2E76','YJ36PH','ORH4Y1','9UFDDD','64I1X2','8XGXAK','BI4OIO','YXLS67']) {
    const d = await db.collection('trade_journal').doc(id).get();
    if (!d.exists) { console.log(id + ': NO EXISTE'); continue; }
    const x = d.data();
    const keys = ['result','rMultiple','pnl','ctrader_real_pnl','status','slHit','tp1Hit','tp2Hit','closedAt','reconciled','adopted','entryPrice','slPrice','tp1Price','tp2Price','direction','ticker','ctraderPositionId','ctraderLots','timestamp'];
    const o = {};
    for (const k of keys) if (x[k] !== undefined) o[k] = x[k];
    console.log(id + ': ' + JSON.stringify(o));
  }
  process.exit(0);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
