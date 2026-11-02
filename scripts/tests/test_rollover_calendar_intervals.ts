import assert from 'node:assert/strict';
import * as calendar from '../../src/engine/RolloverSpreadGate.js';
const api:any=calendar;
assert.equal(typeof api.getVerifiedRolloverPauses,'function','missing complete verified pause enumeration');
const ms=Date.parse;
calendar.registerRolloverSchedule('EURUSD',{scheduleTimeZone:'America/New_York',schedule:Array.from({length:5},(_,i)=>({startSecond:61205+i*86400,endSecond:145795+i*86400}))});
calendar.registerRolloverSchedule('XAUUSD',{scheduleTimeZone:'UTC',schedule:Array.from({length:5},(_,i)=>({startSecond:79260+i*86400,endSecond:161940+i*86400}))});
for(const [date,utcHour] of [['2026-01-12','21'],['2026-07-13','20']]){
 const r=api.getVerifiedRolloverPauses('EURUSD',ms(date+'T00:00:00Z'),ms(date+'T23:59:59Z'));
 assert.equal(r.metadataAvailable,true);assert.equal(r.pauses.length,1);assert.equal(r.pauses[0].pauseStartMs,ms(date+'T'+utcHour+':29:55Z'));
}
const span=api.getVerifiedRolloverPauses('EURUSD',ms('2026-07-13T00:00:00Z'),ms('2026-07-15T23:59:59Z'));assert.equal(span.pauses.length,3,'HTF range includes every daily gap');
const gold=api.getVerifiedRolloverPauses('XAUUSD',ms('2026-07-13T21:30:00Z'),ms('2026-07-13T22:10:00Z'));assert.equal(gold.pauses[0].reopenMs,ms('2026-07-13T22:01:00Z'));
calendar.registerRolloverSchedule('MULTI',{scheduleTimeZone:'UTC',schedule:[{startSecond:0,endSecond:3600},{startSecond:4200,endSecond:7200},{startSecond:7800,endSecond:86400}]});
const multi=api.getVerifiedRolloverPauses('MULTI',ms('2026-07-12T00:00:00Z'),ms('2026-07-12T03:00:00Z'));assert.equal(multi.pauses.length,2,'enumeration cannot sample only latest daily gap');
const weekend=api.getVerifiedRolloverPauses('EURUSD',ms('2026-07-17T20:00:00Z'),ms('2026-07-20T00:00:00Z'));assert.equal(weekend.pauses.length,0,'weekly closure is not intraday rollover');
for(const [ticker,start,end] of [['GBPUSD',ms('2026-07-13T00:00:00Z'),ms('2026-07-14T00:00:00Z')],['EURUSD',NaN,ms('2026-07-14T00:00:00Z')],['EURUSD',1,1],['EURUSD',1,90*86400000]]){
 const r=api.getVerifiedRolloverPauses(ticker,start,end);assert.equal(r.metadataAvailable,false);assert.equal(r.pauses.length,0);
}
console.log('ROLLOVER_CALENDAR_INTERVALS: PASS');
