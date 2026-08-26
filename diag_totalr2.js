import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json','utf8'));
if (admin.apps.length===0) admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
db.settings({ignoreUndefinedProperties:true});
async function main(){
  const s = await db.collection('trade_journal').get();
  // Replicar EXACTAMENTE la lógica del frontend: filter ctraderStatus===EXECUTED, result!==SKIP
  let total = 0;
  const rows = [];
  for(const d of s.docs){
    const x = d.data();
    const status = x.ctraderStatus ?? '(sin status)';
    if (status !== 'EXECUTED') { rows.push(`${d.id} ${x.ticker} [${status}] EXCLUIDO`); continue; }
    if (!x.result || x.result === 'SKIP') { rows.push(`${d.id} ${x.ticker} [SKIP/sin result] EXCLUIDO`); continue; }
    const r = x.rMultiple ?? 0;
    total += r;
    rows.push(`${d.id} ${x.ticker} ${x.result} r=${r}`);
  }
  console.log(rows.join('\n'));
  console.log('\n=== TOTAL (EXECUTED, no-SKIP) =', total.toFixed(2), 'R ===');
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
