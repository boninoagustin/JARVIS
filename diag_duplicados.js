import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json','utf8'));
if (admin.apps.length===0) admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
db.settings({ignoreUndefinedProperties:true});
async function main(){
  const s = await db.collection('trade_journal').get();
  const rows = [];
  for(const d of s.docs){
    const x = d.data();
    rows.push({id:d.id, ticker:x.ticker, dir:x.direction, result:x.result, posID:x.ctraderPositionId, closedAt:x.closedAt, timestamp:x.timestamp, adopted:x.adopted});
  }
  rows.sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
  console.log('=== todos los trades ordenados por timestamp ===');
  for(const r of rows) console.log(`${r.id} | ${r.ticker} ${r.dir} | result=${r.result} | posID=${r.posID} | adopted=${r.adopted} | ts=${r.timestamp}`);
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
