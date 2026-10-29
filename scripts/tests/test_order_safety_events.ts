import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { commitTradeCloseAccounting } from '../../src/engine/TradeAccountingPersistence.js';
const path='src/services/ctrader.ts',source=fs.readFileSync(path,'utf8'),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='setupCTraderEvents')!;
const code=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const writes:any[]=[],calls:any[]=[];let handler:any,complete=true;
const trade:any={ticker:'XPTUSD',direction:'BUY',entryPrice:1643.37,initialSlPrice:1623.25698,ctraderPositionId:'42',riskSnapshot:{frozen:true}};
const doc={id:'journal',data:()=>trade,ref:{update:async(p:any)=>{writes.push(p);}}};
const query:any={where:()=>query,limit:()=>query,get:async()=>({empty:false,docs:[doc]}),doc:(id:string)=>{assert.equal(id,doc.id);return{set:async(fields:any,options:any)=>{assert.equal(options.merge,true);writes.push(fields);}};}};
const accounting:any={result:'LOSS',pnl:-31.23,rMultiple:-.8,accountCurrency:'EUR',riskAmountAccount:39.0375,riskAccountingStatus:'VERIFIED',riskAccountingProvenance:'broker_fill',closedAt:'2026-10-21T00:00:00.000Z',closedAtSource:'broker_execution',slHit:true,balanceAfterUsd:3400};
const ctx:any={console:{log(){},warn(){},error(){}},db:{collection:()=>query},captureExecutionExitCosts(){},
    require:(name:string)=>{
        if(name==='../engine/TradeAccountingPersistence.js') return {commitTradeCloseAccounting};
        assert.equal(name,'../db/trading.js');
        return {globalState:{activeTrades:new Map([['T1',trade]])},finalizeClosedPositionFromDeals:async(id:string,t:any)=>{calls.push({id,t});return complete?accounting:null;}};
    },
    computeRMultipleFromPnlUsd:()=>{throw new Error('FORBIDDEN hardcoded pip-based R');}};
vm.runInNewContext(code+'\nsetupCTraderEvents(client);',{...ctx,client:{onExecution:(fn:any)=>{handler=fn;}}});
const event:any={executionType:3,position:{positionId:42,positionStatus:2},deal:{dealStatus:2,dealId:101,closePositionDetail:{grossProfit:-3123,commission:0,swap:0,moneyDigits:2},moneyDigits:2}};
await handler(event);assert.equal(calls.length,1,'actual filled event must resolve complete broker history, not hardcoded R');assert.equal(writes.length,1);assert.equal(writes[0].rMultiple,-.8);assert.equal(writes[0].ctrader_real_pnl,-31.23);assert.equal(writes[0].riskAccountingStatus,'VERIFIED');
await handler(event);assert.equal(writes[1].ctrader_real_pnl,-31.23,'duplicate events cannot double-count net PnL');
event.deal.stopTriggerBase='TAKE_PROFIT';await handler(event);assert.equal(writes[2].tp2Hit,true,'preserve final broker TP marker');
complete=false;writes.length=0;await handler(event);assert.equal(writes.length,0,'incomplete deal history cannot finalize');
writes.length=0;event.position.positionStatus=1;event.executionType=11;await handler(event);assert.ok(writes.every(p=>p.status!=='CLOSED'&&!('rMultiple'in p)&&!('ctrader_real_pnl'in p)),'partial event never writes final accounting');
console.log('ORDER_SAFETY_EVENTS: PASS actual fill, duplicate, partial and incomplete history');
