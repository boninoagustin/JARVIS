import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTradeRiskSnapshot } from '../../src/engine/TradeRisk.js';
import { evaluateGlobalRisk, invalidateRiskCache } from '../../src/engine/PortfolioModel.js';

assert.ok(fs.existsSync('src/engine/TradeAccountingPersistence.ts'), 'missing durable canonical trade-close commit boundary');
const { commitTradeCloseAccounting } = await import('../../src/engine/TradeAccountingPersistence.js');
const now = Date.parse('2026-10-21T14:00:00Z');
const snapshot = createTradeRiskSnapshot({ ticker:'EURUSD', direction:'BUY', currency:'EUR', entryPrice:100, initialSlPrice:99, filledVolumeCents:100, quoteToAccountRate:1, capturedAtMs:now-10000 })!;
const row:any = { ticker:'EURUSD', direction:'BUY', ctraderStatus:'EXECUTED', result:null, riskSnapshot:snapshot,
    riskAccountingStatus:'VERIFIED', accountCurrency:'EUR', riskAmountAccount:1, executionIncidentPending:false };
const accounting:any = { result:'LOSS', pnl:-3, rMultiple:-3, slHit:true, balanceAfterUsd:97, accountCurrency:'EUR', riskAmountAccount:1,
    riskAccountingStatus:'VERIFIED', riskAccountingProvenance:'broker_fill', closedAt:new Date(now-1000).toISOString(), closedAtSource:'broker_execution', entryPrice:100, filledVolumeCents:100 };
const writes:any[]=[];
const db:any={ collection:(name:string)=>{
    assert.equal(name,'trade_journal');
    return { get:async()=>({empty:false,docs:[{data:()=>row}]}), doc:(id:string)=>({set:async(fields:any,options:any)=>{writes.push({id,fields,options});Object.assign(row,fields);}}) };
}};
const config:any={enabled:true,maxDailyLossR:2};
invalidateRiskCache();
assert.equal((await evaluateGlobalRisk(now,config,0,'LONDON',db)).isKilled,false);
row.executionIncidentPending=true;row.executionUncertain=true;row.closeAccountingPending=true;row.executionFillUnverified=true;
await commitTradeCloseAccounting(db,'J1',accounting,{reconciled:true});
assert.equal(writes.length,1);
for(const field of ['executionIncidentPending','executionUncertain','closeAccountingPending','executionFillUnverified']) assert.equal(row[field],false,field);
assert.equal(row.ctrader_real_pnl,-3);
assert.equal(row.closedAt,accounting.closedAt);
assert.equal(row.riskAccountingProvenance,'broker_fill');
assert.equal(writes[0].options.merge,true,'do not replace existing fill snapshot / strategy context');
assert.equal((await evaluateGlobalRisk(now+1,config,0,'LONDON',db)).killReason,'Max Daily Loss superado (-2R | PnL: -3.00R)','close commit invalidates earlier cached allow');
console.log('PASS canonical close commit preserves monetary result, clears pending flags and invalidates earlier allow');

// A rejected write never constitutes completed accounting, and must not keep an
// earlier allow cached. Callers retain management/incident identity until resolve.
invalidateRiskCache(); row.result=null;row.executionIncidentPending=false;
assert.equal((await evaluateGlobalRisk(now,config,0,'LONDON',db)).isKilled,false);
let release: (()=>void)|undefined;
let completed=false;
const slow:any={collection:()=>({doc:()=>({set:async()=>{await new Promise<void>(resolve=>{release=resolve;});completed=true;}})})};
const pending=commitTradeCloseAccounting(slow,'J1',accounting);
await Promise.resolve();assert.equal(completed,false);release!();await pending;assert.equal(completed,true);
const broken:any={collection:()=>({doc:()=>({set:async()=>{throw new Error('storage offline');}})})};
await assert.rejects(commitTradeCloseAccounting(broken,'J1',accounting),/storage offline/);
row.executionIncidentPending=true;
assert.equal((await evaluateGlobalRisk(now+1,config,0,'LONDON',db)).riskDataStatus,'held','failed write must not resurrect stale permission');
for(const id of ['', 'ERR', 'N/A']) await assert.rejects(commitTradeCloseAccounting(db,id,accounting),/CLOSE_ACCOUNTING_PENDING/);
await assert.rejects(commitTradeCloseAccounting(null,'J1',accounting),/CLOSE_ACCOUNTING_PENDING/);
await assert.rejects(commitTradeCloseAccounting(db,'J1',{...accounting,closedAtSource:'unknown'}),/CLOSE_ACCOUNTING_PENDING/);
console.log('PASS delayed and rejected persistence is awaited; cache cleared on failure; no commit without broker close evidence');
