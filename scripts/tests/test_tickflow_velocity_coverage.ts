import assert from 'node:assert/strict';
import {test} from 'node:test';
import {tickFlow} from '../../src/engine/TickFlow.js';
// Synthetic timestamps/inter-arrivals only; real TickFlow engine, no market I/O.
const start=Date.UTC(2026,9,12,13,30);
function feed(ticker:string, count:number, constant=false, first=start) {
 let last=first;const intervals:number[]=[];
 tickFlow.onTick(ticker,last,1.1,NaN);
 for(let i=0;i<count;i++) {const dt=constant?100:i%2?110:90;intervals.push(dt);last+=dt;tickFlow.onTick(ticker,last,1.1,NaN);}
 return {last,intervals};
}
test('snapshot absence until current UTC-hour has strictly more than 50 actual intervals',()=>{
 for(const n of [0,1,50]) {
  const ticker=`EURUSD-VELOCITY-WARMUP-${n}`, {last}=feed(ticker,n);
  assert.equal(tickFlow.getTickVelocitySnapshot(ticker,last),null,`n=${n} is not an observed normal regime`);
  if(n>0) assert.deepEqual(tickFlow.getTickVelocity(ticker,last),{ticksPerSec:n===1?1000/90:tickFlow.getTickVelocity(ticker,last)!.ticksPerSec,zScore:0,samples:n},'legacy neutral fallback is intentionally unchanged');
 }
});
test('mature snapshot exposes real sample count and positive population variance in ms^2',()=>{
 const ticker='EURUSD-VELOCITY-MATURE', {last,intervals}=feed(ticker,51);
 const snapshot=tickFlow.getTickVelocitySnapshot(ticker,last+1);
 assert.ok(snapshot);assert.equal(snapshot.samples,51);
 const mean=intervals.reduce((a,b)=>a+b,0)/intervals.length;
 const variance=intervals.reduce((a,b)=>a+(b-mean)**2,0)/intervals.length;
 assert.ok(Math.abs(snapshot.baselineVarianceMs2-variance)<1e-10);
 assert.equal(snapshot.observedAtMs,last);assert.equal(snapshot.availableAtMs,last);
 assert.equal(snapshot.baselineHourUtc,13);assert.ok(Number.isFinite(snapshot.zScore));
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,last-1),null);
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,last+10001),null);
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,NaN),null);
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,1e20),null);
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,last,-1),null);
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,last,NaN),null);
});
test('mature constant inter-arrival is unknown variance, not normal z=0',()=>{
 const ticker='EURUSD-VELOCITY-ZERO-VARIANCE', {last}=feed(ticker,60,true);
 assert.equal(tickFlow.getTickVelocity(ticker,last)!.zScore,0,'legacy constant baseline retained');
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,last),null);
});
test('empty or immature new UTC-hour never borrows a mature previous-hour baseline',()=>{
 const ticker='EURUSD-VELOCITY-HOUR-BOUNDARY';
 const {last}=feed(ticker,51,false,Date.UTC(2026,9,12,13,59,53));
 assert.ok(tickFlow.getTickVelocitySnapshot(ticker,last));
 const hour=Date.UTC(2026,9,12,14);
 assert.equal(tickFlow.getTickVelocity(ticker,hour)!.samples,0);
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,hour),null,'fresh prior-hour history does not populate this hour');
 tickFlow.onTick(ticker,hour+1,1.1,NaN);
 assert.equal(tickFlow.getTickVelocity(ticker,hour+1)!.samples,1);
 assert.equal(tickFlow.getTickVelocitySnapshot(ticker,hour+1),null);
});
