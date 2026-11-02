import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { buildExecutionNotice } from '../../src/engine/ExecutionNotice.js';
import { evaluateGlobalRisk, invalidateRiskCache } from '../../src/engine/PortfolioModel.js';
import { createTradeRiskSnapshot } from '../../src/engine/TradeRisk.js';
const source=fs.readFileSync('src/services/ctrader_confirmation.ts','utf8');
const ast=ts.createSourceFile('confirmation.ts',source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleTradeCallback')!;
const now=Date.parse('2026-10-21T14:00:00Z');
const risk=createTradeRiskSnapshot({ticker:'EURUSD',direction:'BUY',currency:'EUR',entryPrice:100,initialSlPrice:99,filledVolumeCents:100,quoteToAccountRate:1,capturedAtMs:now-10000})!;
const loss={ticker:'EURUSD',direction:'BUY',mode:'live',result:'LOSS',rMultiple:-3,ctrader_real_pnl:-3,
    riskAmountAccount:1,accountCurrency:'EUR',riskSnapshot:risk,riskAccountingStatus:'VERIFIED',riskAccountingProvenance:'broker_fill',
    closedAt:new Date(now-1000).toISOString(),closedAtSource:'broker_execution'};
async function run(initialLoss:boolean,lossAtDispatch=false){
    const rows:any[]=initialLoss?[loss]:[]; const messages:string[]=[]; let submissions=0,requests=0,rechecks=0;
    const db:any={collection:()=>({get:async()=>({empty:rows.length===0,docs:rows.map(t=>({data:()=>t}))}),doc:()=>({update:async()=>{},delete:async()=>{}})})};
    const recheck=async()=>{rechecks++;invalidateRiskCache();const r=await evaluateGlobalRisk(now,{enabled:true,maxDailyLossR:2} as any,0,'NY',db);return r.isKilled?r.killReason??'blocked':null;};
    const api:any={};vm.runInNewContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
        exports:api,buildExecutionNotice,console:{log(){},warn(){},error(){}},db,config:{CTRADER_RISK_PERCENT:1},globalState:{activeTrades:new Map()},
        pendingConfirmations:new Map([['T1',{tradeId:'T1',journalId:'J1',ticker:'EURUSD',direction:'BUY',entryPrice:100,slPrice:99,tp1Price:102}]]),
        hasUnresolvedExecutionIncidents:()=>false,recheckLiveExecutionRisk:recheck,
        executeMarketOrder:async(params:any)=>{requests++;if(lossAtDispatch)rows.push(loss);const block=await params.beforeExecution?.();if(block)return{success:false,error:block};submissions++;return{success:false,error:'authoritative no-fill rejection'};},
        retainExecutionIncident:async()=>false,
        bot:{api:{editMessageReplyMarkup:async()=>{},sendMessage:async(_:any,text:string)=>messages.push(text)}},
    });
    await api.handleTradeCallback('ctrader_execute_T1',1,2,3);return{submissions,requests,rechecks,messages};
}
const blocked=await run(true);
assert.equal(blocked.submissions,0,'delayed manual approval must not bypass a verified daily loss gate');
assert.equal(blocked.requests,0,'a blocked approval does not even invoke the broker facade');
const changed=await run(false,true);
assert.equal(changed.submissions,0,'broker preflight rechecks losses occurring after user approval');
assert.equal(changed.requests,1);
assert.ok(changed.rechecks>=2,'both approval and final broker preflight must use current account risk');
const normal=await run(false);
assert.equal(normal.submissions,1,'verified safe approval still attempts once');
console.log('PASS real manual callback: existing daily loss blocks approval; later loss blocks dispatch; safe order attempts once');
