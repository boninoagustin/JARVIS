import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as risk from '../../src/engine/TradeRisk.js';
import * as portfolio from '../../src/engine/PortfolioModel.js';
import { commitTradeCloseAccounting } from '../../src/engine/TradeAccountingPersistence.js';

// Execute production AST functions/branches; imports are allowlisted offline boundaries.
const source = fs.readFileSync(process.env.LIFECYCLE_SOURCE ?? 'src/db/trading.ts', 'utf8');
const ast = ts.createSourceFile('trading.ts', source, ts.ScriptTarget.Latest, true);
function nodes(predicate: (n: ts.Node) => boolean): ts.Node[] {
 const found: ts.Node[]=[]; const visit=(n:ts.Node)=>{if(predicate(n))found.push(n);ts.forEachChild(n,visit);};visit(ast);return found;
}
function fn(name:string):string {const n=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(n,name);return n.getText(ast);}
const quiet={log(){},warn(){},error(){}};
const now=Date.parse('2026-10-22T15:00:00Z');
function sandbox(body:string, overrides:Record<string,any>={}) {
 const trades=new Map<string,any>(), writes:any[]=[], deleted:string[]=[];
 const collections=new Map<string,Map<string,any>>();
 let reject=false, gate:Promise<void>|undefined;
 const db:any={collection:(collection:string)=>{
  const rows=collections.get(collection)??new Map();collections.set(collection,rows);
  const doc=(id:string):any=>({get:async()=>({data:()=>rows.get(id),ref:doc(id)}),
   set:async(fields:any)=>{writes.push({collection,id,fields});if(reject)throw Error('offline journal rejected');if(gate)await gate;rows.set(id,{...rows.get(id),...fields});},
   update:async(fields:any)=>{writes.push({collection,id,fields});if(reject)throw Error('offline journal rejected');if(gate)await gate;rows.set(id,{...rows.get(id),...fields});},
   delete:async()=>{deleted.push(`${collection}:${id}`);rows.delete(id);}});
  const query=(filters:any[]=[]):any=>({where:(key:string,_op:string,value:any)=>query([...filters,[key,value]]),limit:()=>query(filters),get:async()=>({docs:[...rows].filter(([,v])=>filters.every(([k,x])=>v[k]===x)).map(([id,v])=>({id,data:()=>v,ref:doc(id)}))}),doc});return query();
 }};
 const broker:any={isCTraderReady:()=>true,getOpenPositions:async()=>[],getDealsByPosition:async()=>[],getVerifiedAccountCurrency:()=> 'EUR',closePosition:async()=>true};
 const context:any={exports:{},console:quiet,...risk,...portfolio,commitTradeCloseAccounting,Date:class extends Date{static now(){return now;}},Object,structuredClone,
  db,globalState:{activeTrades:trades},store:{activeTrades:trades},rolloverDWideMap:new Map(),rolloverTriageRecords:new Map(),lastReconcileTs:0,
  loadRolloverJournalPending:async()=>true,rehydrateRolloverPending(){},capTp2Price:(_t:any,_d:any,_e:any,_s:any,p:any)=>p,validateExecutionInstrument:()=>false,
  setTimeout:(cb:any)=>{cb();return 1;},sendTelegramAlert:async()=>{},...overrides};
 context.require=(id:string)=>id.includes('memory')?{db:context.db}:id.includes('ctrader')?broker:(()=>{throw Error('Unexpected offline import '+id);})();
 vm.runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 return {api:context.exports,context,trades,writes,deleted,collections,broker,setReject:(v:boolean)=>{reject=v;},setGate:(v:Promise<void>|undefined)=>{gate=v;}};
}
const cases:Record<string,()=>Promise<void>>={};
cases.orphans=async()=>{
 const h=sandbox(fn('reconcileCTraderPositions')+'\n'+fn('canExpireOrphanTrade')+'\nexports.expire=canExpireOrphanTrade;');
 for(const [id,flags] of Object.entries({uncertain:{executionUncertain:true},incident:{executionIncidentPending:true},accounting:{closeAccountingPending:true},fill:{executionFillUnverified:true},open:{ctraderPositionId:'P1'},ordinary:{}}))
  h.trades.set(id,{tradeId:id,ticker:'EURUSD',timestamp:1,...flags});
 await h.api.reconcileCTraderPositions();
 for(const id of ['uncertain','incident','accounting','fill'])assert.equal(h.trades.has(id),true,`2h cleanup must retain ${id}`);
 assert.equal(h.writes.some(w=>w.fields.ctraderStatus==='ABORTED'),false,'age is not evidence of no execution');
 for(const id of ['uncertain','incident','accounting','fill','open'])assert.equal(h.api.expire(id,now),false,`7day cleanup must retain ${id}`);
 assert.equal(h.api.expire('ordinary',now),true,'ordinary stale signal may expire');
 assert.equal(h.api.expire('ordinary',1000),false);
};
const snapshot=risk.createTradeRiskSnapshot({ticker:'EURUSD',direction:'BUY',currency:'EUR',entryPrice:1.1,initialSlPrice:1.09,filledVolumeCents:10000,quoteToAccountRate:.9,capturedAtMs:now-10000})!;
cases.fill=async()=>{
 const h=sandbox(fn('updateTradePositionId'));
 const trade:any={tradeId:'T1',ticker:'EURUSD',direction:'BUY',entryPrice:1.2,slPrice:1.19,initialSlPrice:1.19,originalSlPrice:1.19};h.trades.set('T1',trade);
 await h.api.updateTradePositionId('T1','P1',snapshot);
 for(const [key,value]of Object.entries({entryPrice:1.1,initialSlPrice:1.09,originalSlPrice:1.09,slPrice:1.09,accountCurrency:'EUR',riskAmountAccount:snapshot.riskAmountAccount,riskAccountingProvenance:'broker_fill'}))assert.equal(trade[key],value,`verified fill normalizes ${key}`);
 assert.ok(Object.isFrozen(trade.riskSnapshot));
 trade.slPrice=1.105;trade.tp1Hit=true;
 await h.api.updateTradePositionId('T1','P1',{...snapshot,initialSlPrice:1.08});
 assert.equal(trade.slPrice,1.105,'repeat link cannot undo trailing protection');assert.equal(trade.initialSlPrice,1.09);
 assert.equal(h.writes.at(-1).fields.riskAmountAccount,snapshot.riskAmountAccount,'monetary denominator durable with fill');
};
cases.adoption=async()=>{
 const h=sandbox(fn('reconcileCTraderPositions'));
 h.collections.set('trade_journal',new Map([['J1',{ticker:'EURUSD',direction:'BUY',result:null,ctraderPositionId:'P1',riskSnapshot:{...snapshot},accountCurrency:'EUR',riskAmountAccount:snapshot.riskAmountAccount,riskAccountingStatus:'VERIFIED',riskAccountingProvenance:'broker_fill',initialSlPrice:1.09,originalSlPrice:1.09}]]));
 h.broker.getOpenPositions=async()=>[{positionId:'P1',symbolName:'EURUSD',price:1.1,stopLoss:1.105,takeProfit:1.2,tradeData:{tradeSide:1,openPrice:1.1,openTimestamp:now-100000,label:'J1'}}];
 await h.api.reconcileCTraderPositions();
 const trade=h.trades.get('J1');assert.ok(trade,'adopt existing matching journal identity');
 for(const [key,value]of Object.entries({entryPrice:1.1,slPrice:1.105,initialSlPrice:1.09,originalSlPrice:1.09,accountCurrency:'EUR',riskAmountAccount:snapshot.riskAmountAccount,riskAccountingStatus:'VERIFIED',riskAccountingProvenance:'broker_fill'}))assert.equal(trade[key],value,`adoption restores ${key}`);
 assert.ok(Object.isFrozen(trade.riskSnapshot));assert.equal(portfolio.hasPendingExecutionIncident(trade),false,'valid adopted open remains tradable');
 assert.equal(h.writes.find(w=>w.collection==='active_trades')?.fields.riskSnapshot?.initialSlPrice,1.09);
};
cases.autoHold=async()=>{
 const declaration=nodes(n=>ts.isVariableDeclaration(n)&&n.name.getText(ast)==='recheckKillswitchesBeforeExecution')[0] as ts.VariableDeclaration;assert.ok(declaration);
 const helpers=['hasUnresolvedExecutionIncidents','recheckLiveExecutionRisk'].filter(name=>source.includes(`function ${name}(`)).map(fn).join('\n');
 const h=sandbox(helpers+`\nexports.preflight=${declaration.initializer!.getText(ast)};`,{ticker:'EURUSD',isBacktest:false,oteData:{},nowMs:now,getConfigForTicker:()=>({sessionEnabled:true,rolloverEntryBlock:false}),evaluateGlobalKillswitch:async()=>false,evaluateAssetKillswitch:async()=>false,tickFlow:{isSpreadAnomalous:()=>false}});
 Object.assign(h.context.store,{globalKillswitches:{}});h.trades.set('pending',{executionUncertain:true});
 assert.equal(await h.api.preflight(),'BLOCKED_EXECUTION_INCIDENT','AUTO must consult RAM, not only durable risk cache');
 h.trades.clear();h.context.evaluateAssetKillswitch=async()=>{h.trades.set('during',{closeAccountingPending:true});return false;};
 assert.equal(await h.api.preflight(),'BLOCKED_EXECUTION_INCIDENT','risk await cannot race a RAM incident');
 assert.ok(source.includes('export async function recheckLiveExecutionRisk('),'manual callback shares live risk policy');
 h.trades.clear();h.context.evaluateAssetKillswitch=async()=>false;
 assert.equal(await h.api.recheckLiveExecutionRisk('EURUSD',now),null);
 h.context.evaluateGlobalKillswitch=async()=>true;assert.equal(await h.api.recheckLiveExecutionRisk('EURUSD',now),'BLOCKED_GLOBAL');
};
cases.autoPersistence=async()=>{
 const persistence=nodes(n=>ts.isTryStatement(n)&&n.tryBlock.getText(ast).includes('await updateTradePositionId(oteData.tradeId, result.positionId, result.riskSnapshot)')).sort((a,b)=>a.getWidth(ast)-b.getWidth(ast))[0];assert.ok(persistence);
 const h=sandbox(fn('retainExecutionIncident')+'\n'+fn('hasUnresolvedExecutionIncidents')+`\nexport async function run(){${persistence.getText(ast)}}`,{result:{success:true,positionId:'P1',riskSnapshot:snapshot},oteData:{tradeId:'T1'},journalId:'J1',ticker:'EURUSD',isBacktest:false,updateTradePositionId:async()=>{throw Error('offline write failure');}});
 h.trades.set('T1',{tradeId:'T1',ticker:'EURUSD',direction:'BUY'});h.setReject(true);
 await h.api.run();assert.equal(h.trades.has('T1'),true);assert.equal(h.trades.get('T1').executionIncidentPending,true,'known fill persistence failure installs immediate RAM hold');
 assert.equal(h.api.hasUnresolvedExecutionIncidents(),true);assert.equal(h.trades.get('T1').ctraderPositionId,'P1');assert.equal(h.deleted.length,0);
};
const closeFunctions=()=>['resolveClosedFromDeals','finalizeClosedPositionFromDeals','completeLiveTradeClose','hasUnresolvedExecutionIncidents'].filter(name=>source.includes(`function ${name}(`)).map(fn).join('\n');
const entryDeal={dealId:'D1',positionId:'P1',tradeSide:1,filledVolume:10000,executionPrice:1.1,executionTimestamp:now-900000,moneyDigits:2};
const closeDeal={dealId:'D2',positionId:'P1',tradeSide:2,filledVolume:10000,executionPrice:1.099,executionTimestamp:now-1000,moneyDigits:2,closePositionDetail:{closedVolume:10000,grossProfit:-900,commission:-50,swap:0,moneyDigits:2,balance:100000,balanceVersion:2}};
function seed(h:ReturnType<typeof sandbox>){const trade:any={tradeId:'T1',journalId:'J1',ticker:'EURUSD',direction:'BUY',timestamp:now-900000,ctraderPositionId:'P1',entryPrice:1.1,slPrice:1.09,tp1Price:1.11,tp2Price:1.12,riskSnapshot:snapshot,riskAccountingStatus:'VERIFIED',accountCurrency:'EUR'};h.trades.set('T1',trade);h.broker.getDealsByPosition=async()=>[entryDeal,closeDeal];return trade;}
const flush=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
cases.reconcile=async()=>{
 const h=sandbox(closeFunctions()+'\n'+fn('reconcileCTraderPositions'));const trade=seed(h);Object.assign(trade,{executionUncertain:true,executionIncidentPending:true,executionFillUnverified:true});
 let release!:()=>void;h.setGate(new Promise<void>(r=>release=r));const pending=h.api.reconcileCTraderPositions();await flush();
 assert.equal(h.trades.has('T1'),true,'reconciler awaits durable journal before removing RAM');assert.equal(trade.closeAccountingPending,true,'RAM holds throughout close commit');assert.equal(h.deleted.length,0);
 h.setGate(undefined);release();await pending;
 assert.equal(h.trades.has('T1'),false);const row=h.collections.get('trade_journal')!.get('J1');assert.equal(row.ctrader_real_pnl,-9.5);assert.equal(row.rMultiple,risk.computeTradeRiskR(-9.5,snapshot));
 for(const key of ['closeAccountingPending','executionUncertain','executionIncidentPending','executionFillUnverified'])assert.equal(row[key],false,`durable close clears ${key}`);
 const retry=sandbox(closeFunctions()+'\n'+fn('reconcileCTraderPositions'));const held=seed(retry);retry.setReject(true);await retry.api.reconcileCTraderPositions();
 assert.equal(retry.trades.has('T1'),true,'journal rejection cannot delete active trade');assert.equal(held.closeAccountingPending,true);assert.equal(retry.deleted.length,0);
 retry.setReject(false);retry.context.lastReconcileTs=0;await retry.api.reconcileCTraderPositions();assert.equal(retry.trades.has('T1'),false,'retry completes with original identity');
};
function exitBranch(kind:'ROI'|'RIDER') {const expression=kind==='ROI'?'currentPnlPct >= effectiveROI * 100':'(lastChoch as any).direction === inverseDir';const branch=nodes(n=>ts.isIfStatement(n)&&n.expression.getText(ast)===expression)[0];assert.ok(branch,kind+' actual branch');return branch.getText(ast);}
for(const kind of ['ROI','RIDER'] as const)cases[kind]=async()=>{
 const make=()=>sandbox(closeFunctions()+`\nexport async function run(){for(const [tradeId,trade]of store.activeTrades){${exitBranch(kind)}}}`,{ticker:'EURUSD',isBacktest:false,isDuplicate:()=>false,nowTrade:now,currentPrice:1.2,currentPnlPct:1,effectiveROI:.001,roiLabel:'30min',tradeAgeMs:900000,lastChoch:{direction:'Bearish'},inverseDir:'Bearish'});
 const h=make();const trade=seed(h);trade.riderTf='H1';let closes=0;h.broker.closePosition=async()=>{closes++;return true;};
 let release!:()=>void;h.setGate(new Promise<void>(r=>release=r));const running=h.api.run();await flush();assert.equal(h.trades.has('T1'),true,kind+' awaits accounting before RAM deletion');assert.equal(trade.closeAccountingPending,true,kind+' installs RAM hold');
 h.setGate(undefined);release();await running;assert.equal(h.trades.has('T1'),false);
 const row=h.collections.get('trade_journal')!.get('J1');assert.equal(row.result,'LOSS',kind+' floating gain cannot force WIN');assert.equal(row.ctrader_real_pnl,-9.5);assert.equal(row.rMultiple,risk.computeTradeRiskR(-9.5,snapshot));assert.equal(closes,1);
 const retry=make();const held=seed(retry);let retryCloses=0;retry.broker.closePosition=async()=>{retryCloses++;return true;};retry.setReject(true);await retry.api.run();assert.equal(retry.trades.has('T1'),true);assert.equal(held.closeAccountingPending,true);assert.equal(retry.deleted.length,0);
 retry.setReject(false);await retry.api.run();assert.equal(retry.trades.has('T1'),false);assert.equal(retryCloses,1,'accounting retry must not repeat broker close');
 const missing=make();const unlinked=seed(missing);delete unlinked.ctraderPositionId;await missing.api.run();assert.equal(missing.trades.has('T1'),true,kind+' live unlinked trade cannot acquire theoretical closure');
};
for(const kind of ['TP2','SL','SAR'] as const)cases[kind]=async()=>{
 const branch=nodes(n=>ts.isIfStatement(n)&&(kind==='SAR'?n.expression.getText(ast)==='sarPendingClose':n.expression.getText(ast)==='!isBacktest && trade.ctraderPositionId'&&n.getText(ast).includes(`[${kind}] 🔧`)))[0];assert.ok(branch,kind+' production closure branch');
 const make=()=>sandbox(closeFunctions()+`\nexport async function run(){for(const [tradeId,trade]of store.activeTrades){${branch.getText(ast)}}}`,{ticker:'EURUSD',isBacktest:false});
 const setup=()=>{const h=make();const trade=seed(h);trade.closeMissedCount=8;if(kind==='SAR')h.context.sarPendingClose=trade;return{h,trade};};
 const {h,trade}=setup();let release!:()=>void;h.setGate(new Promise<void>(r=>release=r));const running=h.api.run();await flush();assert.equal(h.trades.has('T1'),true,kind+' holds RAM while journal deferred');assert.equal(trade.closeAccountingPending,true,kind+' holds RAM risk while write pending');assert.equal(h.deleted.length,0);h.setGate(undefined);release();await running;
 assert.equal(h.trades.has('T1'),false);assert.equal(h.collections.get('trade_journal')!.get('J1').ctrader_real_pnl,-9.5);
 const retry=setup();retry.h.setReject(true);await retry.h.api.run();assert.equal(retry.h.trades.has('T1'),true,kind+' rejected write retains RAM');assert.equal(retry.trade.closeAccountingPending,true);assert.equal(retry.h.deleted.length,0);retry.h.setReject(false);await retry.h.api.run();assert.equal(retry.h.trades.has('T1'),false,kind+' retry succeeds');
 for(const missing of ['db','journal','deals']){const bad=setup();if(missing==='db')bad.h.context.db=null;if(missing==='journal')delete bad.trade.journalId;if(missing==='deals')bad.h.broker.getDealsByPosition=async()=>[entryDeal];await bad.h.api.run();assert.equal(bad.h.trades.has('T1'),true,`${kind} missing ${missing} cannot remove state`);assert.equal(bad.trade.closeAccountingPending,true);assert.equal(bad.h.deleted.length,0);}
};
cases.frozenInitial=async()=>{
 const h=sandbox(fn('updateTradePositionId'));h.trades.set('T1',{ticker:'EURUSD',direction:'BUY',initialSlPrice:1.08});await h.api.updateTradePositionId('T1','P1',snapshot);
 assert.equal(Object.getOwnPropertyDescriptor(h.trades.get('T1'),'initialSlPrice')?.writable,false,'verified initial SL is immutable at fill boundary');
};
cases.pendingRetry=async()=>{
 const loop=nodes(n=>ts.isForOfStatement(n)&&n.initializer.getText(ast)==='const [tradeId, trade]'&&n.expression.getText(ast)==='store.activeTrades')[0] as ts.ForOfStatement;assert.ok(loop);const body=loop.statement as ts.Block;
 const cutoff=body.statements.findIndex(n=>ts.isVariableStatement(n)&&n.getText(ast).includes('const nowTrade'));assert.ok(cutoff>=0);
 const prefix=body.statements.slice(0,cutoff).map(n=>n.getText(ast)).join('\n');
 const h=sandbox(closeFunctions()+`\nexport async function run(){for(const [tradeId,trade]of store.activeTrades){${prefix}}}`,{ticker:'EURUSD',isBacktest:false});const trade=seed(h);Object.assign(trade,{closeAccountingPending:true,executionFillUnverified:true});
 await h.api.run();assert.equal(h.trades.has('T1'),false,'pending closure retries on next PING before fill-unverified skip or new price trigger');
};
cases.earlyCloseHold=async()=>{
 for(const kind of ['TP2','SL']){const branch=nodes(n=>ts.isIfStatement(n)&&n.expression.getText(ast)==='!isBacktest && trade.ctraderPositionId'&&n.getText(ast).includes(`[${kind}] 🔧`))[0];assert.ok(branch);
 const h=sandbox(closeFunctions()+`\nexport async function run(){for(const [tradeId,trade]of store.activeTrades){${branch.getText(ast)}}}`,{ticker:'EURUSD',isBacktest:false});const trade=seed(h);await h.api.run();assert.equal(trade.closeAccountingPending,true,kind+' broker absence holds risk before 8-detection fallback');}
};
cases.incidentWithoutRam=async()=>{
 const h=sandbox(fn('retainExecutionIncident')+'\n'+fn('hasUnresolvedExecutionIncidents'));h.setReject(true);
 await h.api.retainExecutionIncident('LOST','JLOST',{success:false,executionUncertain:true,error:'timeout'});
 assert.equal(h.api.hasUnresolvedExecutionIncidents(),true,'missing RAM candidate still installs in-memory execution hold');assert.equal(h.trades.has('LOST'),true);
};
cases.autoOuterCatch=async()=>{
 const catcher=nodes(n=>ts.isCatchClause(n)&&n.variableDeclaration?.name.getText(ast)==='teleErr')[0];assert.ok(catcher);
 const h=sandbox(fn('retainExecutionIncident')+'\n'+fn('hasUnresolvedExecutionIncidents')+`\nexport async function run(){try{throw Error('post-fill management persistence rejected');}${catcher.getText(ast)}}`,{autoExecutionAttempted:true,autoExecutionResult:{success:true,positionId:'P1',riskSnapshot:snapshot},oteData:{tradeId:'T1'},journalId:'J1',ticker:'EURUSD',msg:'signal'});seed(h);h.setReject(true);await h.api.run();assert.equal(h.trades.get('T1').executionIncidentPending,true,'post-fill exception never escapes AUTO safety hold');
};
cases.autoBudget=async()=>{
 const persistence=nodes(n=>ts.isTryStatement(n)&&n.tryBlock.getText(ast).includes('await updateTradePositionId(oteData.tradeId, result.positionId, result.riskSnapshot)')).sort((a,b)=>a.getWidth(ast)-b.getWidth(ast))[0];assert.ok(persistence);
 const h=sandbox(fn('updateTradePositionId')+'\n'+fn('retainExecutionIncident')+`\nexport async function run(){${persistence.getText(ast)}}`,{result:{success:true,positionId:'P1',riskSnapshot:snapshot,riskBudgetAccount:25,executedPrice:1.1,lots:.01},oteData:{tradeId:'T1'},journalId:'J1',ticker:'EURUSD',isBacktest:false,globalConfig:{CTRADER_DEMO:true}});const trade=seed(h);trade.requestedRiskPercent=.5;
 await h.api.run();const row=h.collections.get('trade_journal')!.get('J1');assert.equal(row.riskBudgetAccount,25,'requested cash budget is separate from actual frozen risk');assert.equal(row.requestedRiskPercent,.5);assert.equal(trade.riskBudgetAccount,25);assert.equal(row.riskSnapshot.riskAmountAccount,snapshot.riskAmountAccount);
};
cases.autoSlNormalization=async()=>{
 const branch=nodes(n=>ts.isIfStatement(n)&&n.expression.getText(ast)==='exTrade && !exTrade.isBacktest')[0];assert.ok(branch);
 const h=sandbox(`export async function run(){${branch.getText(ast)}}`,{ticker:'EURUSD',executionPolicy:{profile:'legacy'},oteData:{tradeId:'T1',entryPrice:1.1,stopLoss:'1.08',tp1:'1.12',tp2:'1.15'},result:{executedPrice:1.1},rolloverFillPolicy:undefined});const trade=seed(h);trade.slPrice=1.105;h.context.exTrade=trade;await h.api.run();assert.equal(trade.slPrice,1.105,'AUTO post-SAR normalization must not overwrite broker-normalized/trailing SL with requested SL');
};
cases.journalOnly=async()=>{
 const h=sandbox(closeFunctions()+'\n'+fn('reconcileCTraderPositions'));
 h.collections.set('trade_journal',new Map([['J1',{...seed(h),tradeId:'T1',result:null,executionUncertain:true,executionIncidentPending:true,executionFillUnverified:true}]]));h.trades.clear();
 let release!:()=>void;h.setGate(new Promise<void>(r=>release=r));const pending=h.api.reconcileCTraderPositions();await flush();
 assert.equal(h.api.hasUnresolvedExecutionIncidents(),true,'journal-only close installs RAM hold during commit');h.setGate(undefined);release();await pending;
 const row=h.collections.get('trade_journal')!.get('J1');assert.equal(row.ctrader_real_pnl,-9.5,'empty RAM must still audit broker-closed journal');assert.equal(row.closeAccountingPending,false);assert.equal(row.executionUncertain,false);assert.equal(h.trades.size,0);
};
cases.unfilledManagement=async()=>{
 const loop=nodes(n=>ts.isForOfStatement(n)&&n.initializer.getText(ast)==='const [tradeId, trade]'&&n.expression.getText(ast)==='store.activeTrades')[0] as ts.ForOfStatement;const body=loop.statement as ts.Block;const cutoff=body.statements.findIndex(n=>ts.isVariableStatement(n)&&n.getText(ast).includes('const nowTrade'));assert.ok(cutoff>=0);
 const prefix=body.statements.slice(0,cutoff).map(n=>n.getText(ast)).join('\n');const h=sandbox(closeFunctions()+`\nexport async function run(){for(const [tradeId,trade]of store.activeTrades){${prefix}exports.managed=true;}}`,{ticker:'EURUSD',isBacktest:false});const trade=seed(h);delete trade.ctraderPositionId;await h.api.run();assert.notEqual(h.api.managed,true,'unfilled live signal must never reach theoretical TP2/SL management');assert.equal(h.trades.has('T1'),true);
};
cases.adoptionLegacy=async()=>{
 const h=sandbox(fn('reconcileCTraderPositions'));h.broker.getOpenPositions=async()=>[{positionId:'P1',symbolName:'EURUSD',price:1.1,stopLoss:1.105,tradeData:{tradeSide:1,openTimestamp:now-100000}}];await h.api.reconcileCTraderPositions();const trade=h.trades.get('ADOPTP1');assert.ok(trade);assert.equal(Object.hasOwn(trade,'originalSlPrice'),false,'unknown opening stop is omitted, not current trailing stop or undefined Firestore value');assert.equal(trade.riskAccountingStatus,'UNVERIFIED');
};
cases.fillDurability=async()=>{
 const h=sandbox(fn('updateTradePositionId'));h.trades.set('T1',{tradeId:'T1',ticker:'EURUSD',direction:'BUY'});h.context.db=null;
 await assert.rejects(()=>h.api.updateTradePositionId('T1','P1',snapshot),/unavailable/i,'missing DB is a persistence failure, not a successful fill linkage');
 const lost=sandbox(fn('updateTradePositionId'));await assert.rejects(()=>lost.api.updateTradePositionId('MISSING','P1',snapshot),/identity unavailable/i);
};
cases.adoptionMismatch=async()=>{
 const h=sandbox(fn('reconcileCTraderPositions'));const mismatched=risk.createTradeRiskSnapshot({...snapshot,entryPrice:1.101})!;
 h.collections.set('trade_journal',new Map([['J1',{ticker:'EURUSD',direction:'BUY',result:null,ctraderPositionId:'P1',riskSnapshot:mismatched,accountCurrency:'EUR'}]]));h.broker.getOpenPositions=async()=>[{positionId:'P1',symbolName:'EURUSD',price:1.1,stopLoss:1.105,tradeData:{tradeSide:1,openTimestamp:now-100000}}];await h.api.reconcileCTraderPositions();const trade=h.trades.get('J1');assert.ok(trade);assert.equal(trade.riskAccountingStatus,'INVALID','a matched journal id is not proof of matching actual fill price');assert.equal(portfolio.hasPendingExecutionIncident(trade),true);
};
cases.retryAuditContext=async()=>{
 const h=sandbox(closeFunctions()+'\nexports.finish=completeLiveTradeClose;');const trade=seed(h);h.setReject(true);await h.api.finish(trade,h.context.store,{reversalClosed:true,roiDecayApplied:'30min'});h.setReject(false);await h.api.finish(trade,h.context.store,{reconciled:true});const row=h.collections.get('trade_journal')!.get('J1');assert.equal(row.reversalClosed,true,'generic accounting retry retains original closure audit metadata');assert.equal(row.roiDecayApplied,'30min');
};
cases.autoFinalPersistence=async()=>{
 const branch=nodes(n=>ts.isIfStatement(n)&&n.expression.getText(ast)==='exTrade && !exTrade.isBacktest')[0];assert.ok(branch);
 const h=sandbox(`export async function run(){${branch.getText(ast)}}`,{ticker:'EURUSD',executionPolicy:{profile:'legacy'},oteData:{tradeId:'T1',entryPrice:1.1,stopLoss:'1.08',tp1:'1.12',tp2:'1.15'},result:{executedPrice:1.1},rolloverFillPolicy:undefined});h.context.exTrade=seed(h);h.setReject(true);await assert.rejects(()=>h.api.run(),/offline journal rejected/,'final AUTO active normalization must propagate write failure to incident catch');
};
cases.adoptionBudget=async()=>{
 const h=sandbox(fn('reconcileCTraderPositions'));h.collections.set('trade_journal',new Map([['J1',{ticker:'EURUSD',direction:'BUY',result:null,ctraderPositionId:'P1',riskSnapshot:snapshot,accountCurrency:'EUR',riskBudgetAccount:25,requestedRiskPercent:.5}]]));h.broker.getOpenPositions=async()=>[{positionId:'P1',symbolName:'EURUSD',price:1.1,stopLoss:1.105,tradeData:{tradeSide:1,openTimestamp:now-100000}}];await h.api.reconcileCTraderPositions();const trade=h.trades.get('J1');assert.equal(trade.riskBudgetAccount,25);assert.equal(trade.requestedRiskPercent,.5);assert.equal(trade.riskAmountAccount,snapshot.riskAmountAccount);
};
const selected = Object.entries(cases).filter(([name]) => !process.env.LIFECYCLE_CASE || process.env.LIFECYCLE_CASE === name);
assert.ok(selected.length, 'LIFECYCLE_CASE must select a real production-path regression');
for (const [name, test] of selected) { await test(); console.log(`PASS lifecycle ${name}`); }
console.log(`${selected.length}/${selected.length} lifecycle regression groups PASS (offline AST runtime; zero broker connections/remote writes)`);
