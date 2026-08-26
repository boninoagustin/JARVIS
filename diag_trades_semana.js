import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json','utf8'));
if (admin.apps.length===0) admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
db.settings({ignoreUndefinedProperties:true});
async function main(){
  const s = await db.collection('trade_journal').get();
  const byTicker = {};
  let total = 0;
  for(const d of s.docs){
    const x = d.data();
    const t = (x.ticker||'?').toUpperCase();
    const r = x.result;
    // solo trades cerrados con resultado definido (WIN/LOSS/BREAKEVEN)
    if(!['WIN','LOSS','BREAKEVEN'].includes(r)) continue;
    if(!byTicker[t]) byTicker[t] = {n:0, ts_min:Infinity, ts_max:0};
    byTicker[t].n++;
    total++;
    const ts = x.closedAt || x.timestamp || 0;
    if(ts < byTicker[t].ts_min) byTicker[t].ts_min = ts;
    if(ts > byTicker[t].ts_max) byTicker[t].ts_max = ts;
  }
  const now = Date.now();
  const week = 7*24*3600*1000;
  console.log('=== trades CERRADOS por activo (total) ===');
  for(const [t,v] of Object.entries(byTicker).sort((a,b)=>b[1].n-a[1].n)){
    const spanDays = (v.ts_max - v.ts_min)/86400000;
    const rateWeek = spanDays>0 ? (v.n/spanDays)*7 : 0;
    console.log(`${t.padEnd(8)} ${String(v.n).padStart(3)} trades | span ${spanDays.toFixed(1)} días | ~${rateWeek.toFixed(1)} trades/semana`);
  }
  console.log(`\nTOTAL cerrados: ${total}`);
  console.log('\n=== ¿cuántos se cerraron en los ÚLTIMOS 7 días? ===');
  for(const [t,v] of Object.entries(byTicker).sort((a,b)=>b[1].n-a[1].n)){
    const s2 = await db.collection('trade_journal').where('ticker','==',t).get();
    let recent = 0;
    for(const d of s2.docs){
      const x=d.data();
      if(!['WIN','LOSS','BREAKEVEN'].includes(x.result)) continue;
      const ts = x.closedAt || x.timestamp || 0;
      if(now - ts < week) recent++;
    }
    console.log(`${t.padEnd(8)} ${String(recent).padStart(3)} cerrados últimos 7d`);
  }
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
