import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as risk from '../../src/engine/TradeRisk.js';
import * as portfolio from '../../src/engine/PortfolioModel.js';
import { commitTradeCloseAccounting } from '../../src/engine/TradeAccountingPersistence.js';
const source=fs.readFileSync('src/services/ctrader_confirmation.ts','utf8');
const ast=ts.createSourceFile('confirm.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleTradeCallback')!;
const trading=ts.createSourceFile('trading.ts',fs.readFileSync('src/db/trading.ts','utf8'),ts.ScriptTarget.Latest,true);
const shared=trading.statements.filter(n=>ts.isFunctionDeclaration(n)&&['retainExecutionIncident','hasUnresolvedExecutionIncidents'].includes(n.name?.text??'')).map(n=>n.getText(trading)).join('\n');
const snapshot=risk.createTradeRiskSnapshot({ticker:'EURUSD',direction:'BUY',currency:'EUR',entryPrice:1.1,initialSlPrice:1.09,filledVolumeCents:10000,quoteToAccountRate:.9,capturedAtMs:1000})!;
async function run(result:any, options:any={}){
 options = structuredClone(options);
 const pending:any={tradeId:'T1',journalId:'J1',ticker:'EURUSD',direction:'BUY',entryPrice:1.1,slPrice:1.09,tp1Price:1.12,...options.pending};
 const trades=new Map<string,any>([['T1',{...pending}]]); if(options.old)trades.set('OLD',options.old);
 const writes:any[]=[];const deletes:any[]=[];const messages:string[]=[];const orderCalls:any[]=[];
 let linked=false;
 const db:any={collection:(collection:string)=>({doc:(id:string)=>({update:async(fields:any)=>{if(options.failWrites)throw Error('offline');writes.push({collection,id,fields});},set:async(fields:any)=>{if(options.failWrites)throw Error('offline');writes.push({collection,id,fields});},delete:async()=>deletes.push(id)})})};
 const api:any={};
 const context:any={exports:api,...risk,...portfolio,commitTradeCloseAccounting,recheckLiveExecutionRisk:async()=>null,db,console:{log(){},warn(){},error(){}},globalState:{activeTrades:trades},config:{CTRADER_RISK_PERCENT:1,CTRADER_DEMO:true},pendingConfirmations:new Map([['T1',pending]]),
 executeMarketOrder:async(p:any)=>{orderCalls.push(p);return result;},
 updateTradePositionId:async()=>{await Promise.resolve();if(options.failLink)throw Error('link offline'); linked=true;},
 finalizeClosedPositionFromDeals:async()=>options.fin??null,
 bot:{api:{editMessageReplyMarkup:async()=>{},sendMessage:async(_:any,text:string)=>{messages.push(text);if(text.includes('EJECUTADO EN CTRADER'))assert.equal(linked,true,'success must await async RAM+fill persistence');}}},
 require:(id:string)=>id.includes('trading')?{globalState:{activeTrades:trades}}:id.includes('ctrader')?{closePosition:async()=>true}:id.includes('PortfolioModel')?portfolio:(()=>{throw Error('unexpected import '+id)})(),
 };
 vm.runInNewContext(ts.transpileModule(shared+'\n'+fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 await api.handleTradeCallback('ctrader_execute_T1',1,2,3);
 return{trades,writes,deletes,messages,orderCalls};
}
const scenario=process.argv[2]??'incidents';
if(scenario==='incidents'){
 for(const result of [{success:false,executionUncertain:true,error:'timeout'},{success:false,positionId:'P1',error:'emergency closed'},null]){
  const r=await run(result);assert.equal(r.trades.has('T1'),true,'semi-auto ambiguous/fill outcome must retain identity');assert.equal(r.deletes.length,0);assert.ok(r.writes.some(w=>w.fields.executionIncidentPending===true));assert.ok(!r.messages.some(m=>m.includes('NO se ejecutó')));
 }
 const failed=await run({success:true,positionId:'P1',riskSnapshot:snapshot},{failLink:true});
 assert.equal(failed.trades.get('T1').executionIncidentPending,true,'failed awaited linkage must be caught and retain accounting hold');
 assert.equal(failed.messages.some(m=>m.includes('EJECUTADO EN CTRADER')),false);
 const ok=await run({success:true,positionId:'P1',riskSnapshot:snapshot,executedPrice:1.1,lots:.01});assert.ok(ok.messages.some(m=>m.includes('EJECUTADO EN CTRADER')));
 const blocked=await run({success:true,positionId:'P1'},{old:{tradeId:'OLD',executionUncertain:true}});assert.equal(blocked.orderCalls.length,0,'manual approval cannot bypass account RAM incident hold');
 console.log('PASS actual semi-auto handler: ambiguous/known/null, awaited failed linkage retained, normal fill awaited, unresolved RAM blocks broker send');
}else{
 const old:any={tradeId:'OLD',journalId:'JOLD',ticker:'EURUSD',direction:'SELL',ctraderPositionId:'POLD',riskAccountingStatus:'VERIFIED',accountCurrency:'EUR',riskSnapshot:risk.createTradeRiskSnapshot({ticker:'EURUSD',direction:'SELL',currency:'EUR',entryPrice:1.1,initialSlPrice:1.11,filledVolumeCents:10000,quoteToAccountRate:.9,capturedAtMs:1000})};
 const result={success:true,positionId:'P1',riskSnapshot:snapshot,executedPrice:1.1,lots:.01};
 const pending={sarPendingClose:old};
 const missing=await run(result,{pending,old});assert.equal(missing.trades.has('OLD'),true,'SAR incomplete history must retain old identity');assert.ok(missing.writes.some(w=>w.id==='JOLD'&&w.fields.closeAccountingPending===true));
 const fin={result:'LOSS',rMultiple:-1,pnl:-10,balanceAfterUsd:100,accountCurrency:'EUR',riskAmountAccount:10,riskAccountingStatus:'VERIFIED',riskAccountingProvenance:'broker_fill',slHit:false,closedAt:'2026-10-20T14:00:00.000Z',closedAtSource:'broker_execution'};
 const complete=await run(result,{pending,old,fin});const closure=complete.writes.find(w=>w.id==='JOLD'&&w.fields.result==='LOSS');assert.equal(closure?.fields.closedAt,fin.closedAt,'SAR persists broker close time, never wall clock');assert.equal(closure?.fields.riskAccountingProvenance,'broker_fill');assert.equal(complete.trades.has('OLD'),false);
 const failed=await run(result,{pending,old,fin,failWrites:true});assert.equal(failed.trades.has('OLD'),true,'SAR cannot delete before journal commit');
 console.log('PASS actual semi-auto SAR: incomplete history retained; broker timestamp+provenance; deletion after awaited accounting only');
}