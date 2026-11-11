/** Read-only production roster/config snapshot for ML candidate collection. */
import fs from 'node:fs';
import admin from 'firebase-admin';
import {mapAssetConfig} from './periodic_opt/selection_context.js';
if (!admin.apps.length) admin.initializeApp({credential:admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json','utf8')))});
const db=admin.firestore();
const [roster,configs]=await Promise.all([db.doc('optimization_config/active_tickers').get(),db.collection('asset_configs').get()]);
const snapshots=new Map(configs.docs.filter(d=>/^[A-Z0-9]+$/.test(d.id)&&d.id!=='GLOBAL').map(d=>[d.id,d.data()]));
const tickers=[...new Set([...(roster.data()?.tickers??[]),...snapshots.keys()])].filter(t=>typeof t==='string'&&/^[A-Z0-9]+$/.test(t)).sort();
const assets:Record<string,any>={};
for(const ticker of tickers){
 const raw=snapshots.get(ticker);
 const trade=raw?.enabled===true&&!String(raw?.disabledReason??'').trim();
 const config=raw?mapAssetConfig(ticker,raw):null;
 if(config){delete config.mlGate;config.mlGateEnabled=false;delete config.mlGateDeployment;}
 assets[ticker]={trade,hasConfig:!!raw,config};
}
await new Promise<void>((resolve,reject)=>process.stdout.write(JSON.stringify({assets}),error=>error?reject(error):resolve()));
process.exit(0);
