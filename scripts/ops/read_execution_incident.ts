// Read-only incident capture. No imports from trading/broker modules.
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
const out='/opt/JARVIS/audit_results/execution_incident_20261027';
fs.mkdirSync(out,{recursive:true});
admin.initializeApp({credential:admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json','utf8')))});
const db=admin.firestore();
try {
 const now=Date.now(),from=now-48*3600000;
 const [journal,metrics,active,account,bot,configs]=await Promise.all([
  db.collection('trade_journal').where('timestamp','>=',from).orderBy('timestamp','desc').get(),
  db.collection('execution_metrics').where('timestamp','>=',from).orderBy('timestamp','desc').get(),
  db.collection('active_trades').get(),db.doc('system/account_state').get(),
  db.doc('app_settings/bot_config').get(),db.collection('asset_configs').get()
 ]);
 const snapshot={captured_at_ms:now,from_ms:from,journal:journal.docs.map(d=>({id:d.id,...d.data()})),metrics:metrics.docs.map(d=>({id:d.id,...d.data()})),active:active.docs.map(d=>({id:d.id,...d.data()})),account:account.data()??{},bot:bot.data()??{},assets:Object.fromEntries(configs.docs.map(d=>[d.id,d.data()]))};
 fs.writeFileSync(path.join(out,`snapshot_${now}.json`),JSON.stringify(snapshot,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({captured_at_ms:now,count:journal.size,rows:snapshot.journal.map((d:any)=>({id:d.id,ticker:d.ticker,timestamp:d.timestamp,iso:new Date(d.timestamp).toISOString(),mode:d.mode,result:d.result,status:d.ctraderStatus,error:d.ctraderError,skipReason:d.skipReason,position:d.ctraderPositionId,entry:d.entryPrice,sl:d.slPrice,tp1:d.tp1Price,tp2:d.tp2Price})),metrics:snapshot.metrics,active:snapshot.active,account:snapshot.account,autoTrading:snapshot.bot.autoTrading},null,2));
}finally{await admin.app().delete();}
