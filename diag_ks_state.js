import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json','utf8'));
if (admin.apps.length===0) admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
db.settings({ignoreUndefinedProperties:true});
async function main(){
  const s = await db.collection('state').get();
  for(const d of s.docs){
    const x=d.data();
    const ks = x.globalKillswitches || x.killswitches;
    if(ks && Object.keys(ks).length) console.log(d.id, '→', JSON.stringify(ks));
    if(x.globalPortfolioKillswitchUntil) console.log(d.id, '→ globalPortfolioKillswitchUntil=', x.globalPortfolioKillswitchUntil, new Date(x.globalPortfolioKillswitchUntil).toISOString());
  }
  // buscar en otras colecciones
  const c2 = await db.collection('app_settings').get();
  for(const d of c2.docs){ const x=d.data(); if(JSON.stringify(x).toLowerCase().includes('killswitch')) console.log('app_settings', d.id, '→', JSON.stringify(x).slice(0,300)); }
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
