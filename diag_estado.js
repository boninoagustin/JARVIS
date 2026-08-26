import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json','utf8'));
if (admin.apps.length===0) admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
db.settings({ignoreUndefinedProperties:true});
async function main(){
  // active_trades abiertos
  const at = await db.collection('active_trades').get();
  console.log('=== active_trades ===');
  for(const d of at.docs){ const x=d.data(); console.log(d.id, '|', x.ticker, x.direction, '| posID=', x.ctraderPositionId, '| journalId=', x.journalId); }
  // trades del journal sin result (abiertos)
  const s = await db.collection('trade_journal').get();
  console.log('\n=== journal trades SIN result (abiertos) ===');
  for(const d of s.docs){ const x=d.data(); if(!x.result){ console.log(d.id, '|', x.ticker, x.direction, '| posID=', x.ctraderPositionId, '| adopted=', x.adopted); } }
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
