import assert from 'node:assert/strict';
import { PivotEngine } from '../../src/engine/smc/modules/pivots.js';
import { ImbalanceEngine } from '../../src/engine/smc/modules/imbalances.js';
import type { OHLCV, SMCPreset } from '../../src/engine/smc/types.js';
const c = (t:number,o:number,h:number,l:number,close:number):OHLCV => ({timestamp:t*1000,open:o,high:h,low:l,close,volume:100});
const base:SMCPreset={name:'offline',risk_level:3,asset_type:'forex',override_choch:true,require_displacement:true,require_fvg_after_ob:false,strict_breaker:true,strict_sweep:false,confirm_close:true,min_score:3};
let failures=0, count=0;
function test(name:string, f:()=>void){count++;try{f();console.log('PASS',name);}catch(e){failures++;console.error('FAIL',name,e);}}
test('plateau is opt-in, left strict, and available only after right confirmation',()=>{
 for(const low of [false,true]){
 const bars=low?[c(1,8,9,7,8),c(2,7,8,6,7),c(3,7,8,6,7),c(4,8,9,7,8)]:[c(1,8,9,7,8),c(2,9,10,8,9),c(3,9,10,8,9),c(4,8,9,7,8)];
 const legacy=new PivotEngine(1,2), exp=new PivotEngine(1,2,{allowRightTies:true});
 const a=bars.map(x=>legacy.nextCandle(x));const b=bars.map(x=>exp.nextCandle(x));
 assert.equal(a.filter(Boolean).length,0); assert.deepEqual(b.slice(0,3),[null,null,null]);
 assert.equal(b[3]?.type,low?'Low':'High');assert.equal(b[3]?.timestamp,2000);assert.equal(b[3]?.availableAt,4000);
 const left=new PivotEngine(1,1,{allowRightTies:true});assert.equal([bars[1],bars[2],bars[3]].map(x=>left.nextCandle(x)).at(-1),null);
 }
 const strict=new PivotEngine(1,1);const p=[c(1,8,9,7,8),c(2,9,10,8,9),c(3,8,9,7,8)].map(x=>strict.nextCandle(x)).at(-1)!;
 assert.equal('availableAt' in p,false);
});
const exp:SMCPreset={...base,signal_profile:'directional_atr_v1'};
function fvg(bars:OHLCV[],preset:SMCPreset=exp,atr=2,period=1000){const e=new ImbalanceEngine();let events:any[]=[];for(const b of bars)events=e.processCandle(b,atr,preset,period);return {events,e};}
const smallBody=[c(1,9,10,8,9),c(2,10,14,9,10.1),c(3,12,14,12,13)];
const good=[c(1,9,10,8,9),c(2,9,14,9,13),c(3,12,14,12,13)];
test('experimental FVG quality rejects small bodies and oversize gaps; legacy unchanged',()=>{
 assert.equal(fvg(smallBody).events.length,0);
 assert.equal(fvg(smallBody,base).events.length,1);
 const huge=[c(1,9,10,8,9),c(2,10,21,9,20),c(3,20,22,20,21)];
 assert.equal(fvg(huge).events.length,0);assert.equal(fvg(huge,base).events.length,1);
 assert.equal(fvg(good).events[0]?.fvg.availableAt,3000);assert.equal(fvg(good).events[0]?.fvg.timestamp,2000);
 assert.equal('availableAt' in fvg(good,base).events[0].fvg,false);
 assert.equal(fvg(smallBody,{...exp,signal_ablation:{fvgQuality:false}}).events.length,1);
 assert.equal(fvg(good,exp,0).events.length,0);assert.equal(fvg(good,exp,NaN).events.length,0);
 assert.equal(fvg([good[0],good[1],{...good[2],low:15}]).events.length,0);
 assert.equal(fvg([good[0],good[1],{...good[2],timestamp:10000}]).events.length,0);
 assert.equal(fvg(good.map(b=>({...b,timestamp:b.timestamp-4000}))).events.length,0);
});
test('experimental FVG min aliases and explicit quality thresholds are wired',()=>{
 const bars=[c(1,9,10,8,9),c(2,9,12,9,11),c(3,10.6,12,10.6,11)];
 assert.equal(fvg(bars).events.length,0);
 for(const cfg of [{fvg_min_atr:.1},{fvg_min_atr_factor:.1},{signal_fvg:{minAtr:.1}}]) assert.equal(fvg(bars,{...exp,...cfg}).events.length,1);
 assert.equal(fvg(good,{...exp,signal_fvg:{minBodyFraction:.9}}).events.length,0);
 assert.equal(fvg(good,{...exp,signal_fvg:{maxAtr:.75}}).events.length,0);
 assert.equal(fvg(smallBody,{...exp,signal_fvg:{minBodyFraction:.01}}).events.length,1);
 assert.throws(()=>fvg(good,{...exp,fvg_min_atr:.1,fvg_min_atr_factor:.2}),/conflict/i);
 assert.equal(fvg(good,{...exp,fvg_min_atr:.1,fvg_min_atr_factor:.2,signal_fvg:{minAtr:.1}}).events.length,1);
 const mirror=(b:OHLCV)=>({...b,open:30-b.open,high:30-b.low,low:30-b.high,close:30-b.close});
 assert.equal(fvg(good.map(mirror)).events[0]?.fvg.direction,'Bearish');
 assert.equal(fvg(smallBody.map(mirror)).events.length,0);
 assert.equal(fvg(bars,{...base,fvg_min_atr:.1}).events.length,0);
 assert.equal(fvg(bars,{...base,fvg_min_atr_factor:.1}).events.length,1);
});
test('FVG/iFVG lifecycle remains intact under both policies',()=>{
 for(const cfg of [base,exp]){
 const {e}=fvg(good,cfg);const zone=e.activeFVGs[0];
 e.processCandle(c(4,12,13,11.5,12),2,cfg,1000);assert.equal(zone.top,11.5);assert.equal(zone.mitigated,false);
 e.processCandle(c(5,11,12,9.5,11),2,cfg,1000);assert.equal(zone.mitigated,true);
 const flip=e.processCandle(c(6,11,11,8,9),2,cfg,1000);assert.equal(flip[0]?.type,'EVENT_IFVG_CREATED');assert.equal(zone.direction,'Bearish');assert.equal(zone.top,12);assert.equal(zone.bottom,10);
 e.processCandle(c(7,11,14,10,13),2,cfg,1000);assert.equal(e.activeFVGs.includes(zone),false);
 }
});
console.log(JSON.stringify({count,failures}));if(failures)process.exitCode=1;
