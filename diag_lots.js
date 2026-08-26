import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json','utf8'));
if (admin.apps.length===0) admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
db.settings({ignoreUndefinedProperties:true});
async function main(){
  const s = await db.collection('trade_journal').get();
  for(const d of s.docs){ const x=d.data(); if(x.ctraderLots!==undefined){ console.log(d.id, 'ctraderLots=', x.ctraderLots, '| ticker=', x.ticker, '| pnl_real=', x.ctrader_real_pnl, '| rMultiple=', x.rMultiple); } }
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
