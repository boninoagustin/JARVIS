import assert from 'node:assert/strict';
import {parseCSV,runBacktest} from '../../jarvis-os/src/services/backtestEngine';
import {registerRolloverSchedule} from '../../src/engine/RolloverSpreadGate';
const t=Date.parse('2026-07-13T20:26:00Z');
registerRolloverSchedule('EURUSD',{scheduleTimeZone:'America/New_York',schedule:Array.from({length:5},(_,i)=>({startSecond:61205+i*86400,endSecond:145795+i*86400}))});
const entries=parseCSV(`PING_PRICE | TF: 5 | Precio: 1.1 | TS: ${t-600000}
EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${t-599999}
PING_PRICE | TF: 5 | Precio: 1.0996 | TS: ${t}
PING_PRICE | TF: 5 | Precio: 1.1 | TS: ${t+60000}`).lines;
const base:any={ticker:'EURUSD',minBuyPoints:1,minSellPoints:1,oteEntryPercent:70,entryTrigger:'CHOCH'};
const run=(config:any)=>{const random=Math.random;Math.random=()=>.25;try{return runBacktest(new Map(),config,undefined,entries);}finally{Math.random=random;}};
const original=run({...base});assert.equal(original.trades.length,1);const trade=original.trades[0];
const triage={maxExtraRiskR:.3,greenPeakMultiple:1.25,greenMinR:.85,structuralPeakMultiple:1.35,beMinDistancePeakMultiple:1.15,severeLossR:-.8,maxQuoteAgeMs:10000};
const policy={profile:'rollover_triage_v1',triage};
const missing=run({...base,rolloverPolicy:policy});
assert.equal(missing.trades[0].rolloverTriage?.[0]?.proposal.action,'HOLD','CSV lacks Ask/cost evidence, actual caller must record unavailable HOLD');
const initialRisk=trade.entryPrice-trade.slPrice;
const c:any={profile:'rollover_triage_v1',ticker:'EURUSD',tradeId:trade.id,direction:'BUY',nowMs:t,entryPrice:trade.entryPrice,initialSlPrice:trade.slPrice,initialRiskPrice:initialRisk,currentSlPrice:trade.slPrice,
 quote:{bid:1.0996,ask:1.0997,bidTimestampMs:t,askTimestampMs:t},tickSize:.00001,minStopDistancePrice:.00002,protectionEarned:false,
 costs:{remainingCostsCash:.00002,remainingValuePerPriceUnit:1},partial:{tp1Confirmed:false,realizedNetCash:0},htf:{aligned:true,availableAtMs:t-1000},peakSpread:{price:.0017,availableAtMs:t-1000},config:triage,
 normalization:{snapshot:{bid:1.0996,ask:1.0997,ts:t,ageMs:0,samples:100,spread:.0001,baselineSpread:.0001},baseSpreadPrice:.0001,pipSize:.0001}};
const sidecar={[`EURUSD:${trade.id}:${t}`]:c};
const positive=run({...base,rolloverPolicy:policy,rolloverTriageContexts:sidecar});
assert.equal(positive.trades[0].rolloverTriage[0].proposal.action,'WIDEN_BOUNDED_SL','real BT caller forwards complete as-of bilateral context to policy');
assert.equal(positive.trades[0].slPrice,original.trades[0].slPrice,'proposal is NOT execution confirmation');
assert.equal(positive.trades[0].rolloverTriage[0].execution,'PROPOSAL_ONLY');
for(const override of [{nowMs:t+1},{initialRiskPrice:initialRisk*2},{ticker:'OTHER'},{quote:null}]){
 const invalid=run({...base,rolloverPolicy:policy,rolloverTriageContexts:{...sidecar,[`EURUSD:${trade.id}:${t}`]:{...c,...override}}});
 assert.equal(invalid.trades[0].rolloverTriage[0].proposal.action,'HOLD');assert.equal(invalid.trades[0].rMultiple,original.trades[0].rMultiple);
}
console.log('PASS actual BT triage proposals/HOLD sidecar identity/as-of; never fabricated confirmation');
