import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as risk from '../../src/engine/TradeRisk.js';
import * as portfolio from '../../src/engine/PortfolioModel.js';
import { buildExecutionNotice } from '../../src/engine/ExecutionNotice.js';

const source = fs.readFileSync('src/db/trading.ts','utf8');
const ast = ts.createSourceFile('trading.ts', source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && ['retainExecutionIncident','hasUnresolvedExecutionIncidents'].includes(n.name?.text ?? '')).map(n=>n.getText(ast)).join('\n');
let branch: ts.IfStatement | undefined;
function visit(n: ts.Node) { if(ts.isIfStatement(n) && n.expression.getText(ast)==='result.success && result.positionId' || ts.isIfStatement(n) && n.expression.getText(ast)==='result?.success && result.positionId') branch=n as ts.IfStatement; ts.forEachChild(n,visit); }
visit(ast); assert.ok(branch, 'actual auto dispatch result handler exists');
const quiet = {log(){},warn(){},error(){}};
for (const result of [{success:false,executionUncertain:true,error:'timeout'}, {success:false,positionId:'P1',error:'verified emergency close'}, null, {success:false,error:'rejected'}]) {
 const trades = new Map<string,any>([['T1',{tradeId:'T1',journalId:'J1',ticker:'EURUSD',direction:'BUY',timestamp:1}]]);
 const writes:any[]=[]; const deleted:string[]=[];
 const db:any={collection:(collection:string)=>({doc:(id:string)=>({set:async(fields:any)=>writes.push({collection,id,fields}),update:async(fields:any)=>writes.push({collection,id,fields}),delete:async()=>deleted.push(`${collection}:${id}`)})})};
 const api:any={};
 vm.runInNewContext(ts.transpileModule(functions+`\nexport async function actualAutoResult(){ ${branch!.getText(ast)} }`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
  exports:api, buildExecutionNotice, console:quiet,...risk,...portfolio,globalState:{activeTrades:trades},store:{activeTrades:trades},db,result,
  ticker:'EURUSD',oteData:{tradeId:'T1'},journalId:'J1',isBacktest:false,msg:'signal',sendTelegramAlert:async()=>{},
  require:(id:string)=>id.includes('PortfolioModel')?portfolio:id.includes('memory')?{db}:(()=>{throw Error('Unexpected import '+id)})(),
 });
 await api.actualAutoResult();
 const uncertain=result===null || !!result.executionUncertain || !!result.positionId;
 if(uncertain){
  assert.equal(trades.has('T1'),true,'ambiguous/executed auto result must retain RAM identity');
  assert.equal(deleted.length,0,'ambiguous/executed auto result must never delete active record');
  assert.ok(writes.some(w=>w.collection==='trade_journal' && w.fields.executionIncidentPending===true && w.fields.result===null),'journal must retain unresolved incident, not ABORTED/SKIP');
  if(result?.positionId) assert.equal(trades.get('T1').ctraderPositionId,result.positionId);
  portfolio.invalidateRiskCache();
  const rows=writes.filter(w=>w.collection==='trade_journal').map(w=>w.fields);
  const readDb:any={collection:()=>({get:async()=>({empty:false,docs:rows.map(t=>({data:()=>t}))})})};
  const hold=await portfolio.evaluateGlobalRisk(Date.parse('2026-10-21T14:00:00Z'),{enabled:false} as any,0,'NY',readDb);
  assert.equal(hold.riskDataStatus,'held','null-result incident blocks new global risk even with policy disabled');
 }else{
  assert.equal(trades.has('T1'),false,'genuine no-fill rejection still cleans up');
  assert.ok(writes.some(w=>w.fields.ctraderStatus==='ABORTED'));
 }
}
portfolio.invalidateRiskCache();
const ordinary:any={collection:()=>({get:async()=>({empty:false,docs:[{data:()=>({ticker:'EURUSD',result:null,ctraderStatus:'EXECUTED',riskAccountingStatus:'VERIFIED',direction:'BUY',accountCurrency:'EUR',riskSnapshot:risk.createTradeRiskSnapshot({ticker:'EURUSD',direction:'BUY',currency:'EUR',entryPrice:1.1,initialSlPrice:1.09,filledVolumeCents:10000,quoteToAccountRate:.9,capturedAtMs:1000})})}]})})};
assert.equal((await portfolio.evaluateGlobalRisk(Date.parse('2026-10-21T14:00:00Z'),{enabled:false} as any,0,'NY',ordinary)).isKilled,false,'normal verified open trades do not block risk');
console.log('PASS actual auto result branches: ambiguous/no-pid, known fill/emergency close, null outcome, genuine rejection; global pending hold; ordinary open allowed');

// Positive accounting evidence, not truthy saved R/status, establishes live credit.
const now=Date.parse('2026-10-21T14:00:00Z');
async function gate(rows:any[],asset=false){
 portfolio.invalidateRiskCache(); const db:any={collection:()=>({get:async()=>({empty:rows.length===0,docs:rows.map(t=>({data:()=>t}))})})};
 return asset?portfolio.evaluateAssetRisk(db,'EURUSD',now,{}):portfolio.evaluateGlobalRisk(now,{enabled:false} as any,0,'NY',db);
}
const saved={ticker:'EURUSD',direction:'BUY',result:'WIN',rMultiple:.12,closedAt:'2026-10-21T13:00:00Z',closedAtSource:'broker_execution'};
assert.equal((await gate([saved])).riskDataStatus,'held','legacy saved .12R without frozen risk must not offset verified loss');
assert.equal((await gate([{...saved,riskAccountingStatus:'VERIFIED',riskAccountingProvenance:'broker_fill'}])).riskDataStatus,'held','status strings alone are not a denominator');
assert.equal((await gate([{...saved,closedAt:'2020-01-01T13:00:00Z',closedAtSource:'unknown'}])).isKilled,false,'dated old closures outside FX day are excluded before provenance validation');
assert.equal((await gate([{...saved,closedAt:undefined}])).riskDataStatus,'held','undated live closures require audit, never entry-date inference');
for(const status of ['INVALID','UNVERIFIED']){
 const open={ticker:'EURUSD',result:null,ctraderPositionId:'P1',ctraderStatus:'EXECUTED',riskAccountingStatus:status};
 assert.equal((await gate([open])).riskDataStatus,'held','known executed open without valid risk blocks account');
 assert.equal((await gate([open],true)).riskDataStatus,'held');
}
assert.equal((await gate([{ticker:'EURUSD',result:null,riskAccountingStatus:'UNVERIFIED'}])).isKilled,false,'ordinary unfilled pretrade is not an execution incident');
const snap=risk.createTradeRiskSnapshot({ticker:'EURUSD',direction:'BUY',currency:'EUR',entryPrice:1.1,initialSlPrice:1.09,filledVolumeCents:10000,quoteToAccountRate:.9,capturedAtMs:now-10000})!;
const certified={...saved,riskSnapshot:snap,riskAccountingStatus:'VERIFIED',riskAccountingProvenance:'broker_fill',accountCurrency:'EUR',riskAmountAccount:snap.riskAmountAccount,ctrader_real_pnl:snap.riskAmountAccount*.12};
assert.equal((await gate([certified])).isKilled,false,'explicit certified counterfactual allows finite consistent R');
assert.equal((await gate([{...certified,ctrader_real_pnl:999}])).riskDataStatus,'held','contradictory monetary R holds');
console.log('PASS live positive frozen accounting evidence; invalid executed open holds; old dated excluded, undated retained');

