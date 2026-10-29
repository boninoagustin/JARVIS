// Read-only deployment verification. Pure risk module; no live service imports.
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import admin from 'firebase-admin';
import {evaluateGlobalRisk,getFxDayStartMs} from '../../src/engine/PortfolioModel.js';
const out='/opt/JARVIS/audit_results/execution_fix_20261027T033204Z';
admin.initializeApp({credential:admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json','utf8')))});
try {
 const db=admin.firestore();
 const [journal,global,assets,bot,state]=await Promise.all([db.collection('trade_journal').get(),db.doc('asset_configs/GLOBAL').get(),db.collection('asset_configs').get(),db.doc('app_settings/bot_config').get(),db.doc('optimization_config/auto_state').get()]);
 const now=Date.now();const rows=journal.docs.map(d=>({id:d.id,...d.data()}));
 // Exact production session function with only the clock/Intl builtins.
 const file=ts.createSourceFile('trading.ts',fs.readFileSync('/opt/JARVIS/src/db/trading.ts','utf8'),ts.ScriptTarget.ES2022,true);
 const fn=file.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getCurrentSession')!;
 const session=vm.runInNewContext(ts.transpileModule(fn.getText(file)+'\ngetCurrentSession('+now+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{});
 const data=global.data()??{};const config:any={enabled:data.enabled===true,disabledSessions:Array.isArray(data.disabledSessions)?data.disabledSessions:[]};
 for(const key of ['maxDailyLossR','dailyProfitTargetR','maxTradesPerDay','maxConsecutiveLosses','trailingDrawdownR'])config[key]=Number.isFinite(Number(data[key]))?Number(data[key]):0;
 const readonlyDb:any={collection:(name:string)=>{if(name!=='trade_journal')throw new Error('Unexpected collection');return {get:async()=>journal};}};
 const gate=await evaluateGlobalRisk(now,config,0,session,readonlyDb,false);
 const sourceState=state.data()??{};const relevantSources=new Set(['src/engine/OrderSafety.ts','src/services/ctrader.ts','src/services/ctrader_confirmation.ts','src/db/trading.ts']);
 const tracking=Object.fromEntries(Object.entries<any>(sourceState.applied??{}).map(([ticker,entry])=>[ticker,{status:entry.status,keys:Object.keys(entry),followup:entry.followup??null}]));
 const report={captured_at_ms:now,fxDayStartMs:getFxDayStartMs(now),session,config,gate,journalCount:rows.length,assets:Object.fromEntries(assets.docs.map(d=>[d.id,d.data()])),bot:bot.data()??{},tracking};
 fs.writeFileSync(out+'/readiness.json',JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({captured_at_ms:now,session,gate,journalCount:rows.length,autoTrading:report.bot.autoTrading,trackedTickers:Object.keys(tracking)},null,2));
}finally{await admin.app().delete();}
