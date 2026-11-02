import assert from 'node:assert/strict';
import { MarketStructureEngine } from '../../src/engine/smc/modules/market_structure.js';
import type { Direction, OHLCV, Pivot, SMCPreset } from '../../src/engine/smc/types.js';
const c=(t:number,o:number,h:number,l:number,close:number,volume=100):OHLCV=>({timestamp:t*1000,open:o,high:h,low:l,close,volume});
const base:SMCPreset={name:'offline',risk_level:3,asset_type:'forex',override_choch:true,require_displacement:true,require_fvg_after_ob:false,strict_breaker:true,strict_sweep:false,confirm_close:true,min_score:3};
const exp:SMCPreset={...base,signal_profile:'directional_atr_v1',signal_ablation:{directionalMomentum:false},valid_bos_displacement:true,displ_atr_mult:.5};
const p=():Pivot=>({index:1,timestamp:2000,price:10,type:'High',isBroken:false});
let count=0,failures=0;
function test(name:string,f:()=>void){count++;try{f();console.log('PASS',name);}catch(e){failures++;console.error('FAIL',name,e);}}
function seed(e:MarketStructureEngine,preset=exp){for(const b of [c(1,8,9,7,8),c(2,9,10,8,9),c(3,8,9,7,8)])e.processCandle(b,[],[],preset,2);}
test('experimental delayed break freezes original ATR/Z instead of accepting current indicators',()=>{
 for(const z of [false,true]){
 const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e);const pivot=p();
 e.processCandle(c(4,10,10.2,10,10.1),[],[],exp,2,z?{zScore:1}:{});
 const out=e.processCandle(c(5,10,13,10,12),[pivot],[],exp,.1,z?{zScore:3}:{});
 assert.equal(out.length,0);assert.equal(pivot.isBroken,false);
 }
});
test('experimental accepted historical break is emitted now with separate origin timestamp',()=>{
 const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e);const pivot=p();
 e.processCandle(c(4,10,13,10,12),[],[],exp,2,{zScore:3,crtValid:false});
 const out=e.processCandle(c(5,10,10.2,10,10.1),[pivot],[],exp,200,{zScore:0,crtValid:true,availableAt:6000});
 assert.equal(out.length,1);assert.equal(out[0].timestamp,5000);assert.equal(out[0].breakTimestamp,4000);assert.equal(out[0].availableAt,6000);assert.equal(out[0].signalProfile,'directional_atr_v1');assert.equal(out[0].crtOrigin,false);assert.equal(pivot.isBroken,true);
});
const directional:SMCPreset={...exp,signal_ablation:undefined};
function impulse(t:number,zUp=2,zDn=0,atr=2,ready=true){return {timestamp:t*1000,sampleCount:50,ready,zUp,zDn,upSmooth:1,dnSmooth:0,atr,atrNormalizedRange:1,volumeRatio:1,priorVolumeMean:100};}
test('directional displacement replaces signed legacy Z, uses color/body geometry and causal snapshot',()=>{
 const cases=[
  {bar:c(4,10,13,10,12),snapshot:impulse(4),zScore:-10,ok:true},
  {bar:c(4,10,13,10,10.2),snapshot:impulse(4),zScore:10,ok:false},
  {bar:c(4,12,13,10,11),snapshot:impulse(4),zScore:10,ok:false},
  {bar:c(4,10,13,10,12),snapshot:impulse(3),zScore:10,ok:false},
  {bar:c(4,10,13,10,12),snapshot:impulse(4,2,0,3),zScore:10,ok:false},
  {bar:c(4,10,13,10,12),snapshot:null,zScore:-10,ok:true},
  {bar:c(4,10,13,10,12),snapshot:impulse(4,0,0,2,false),zScore:-10,ok:true},
 ];
 for(const x of cases){const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e,directional);const pivot=p();const out=e.processCandle(x.bar,[pivot],[],directional,2,{zScore:x.zScore,impulse:x.snapshot});assert.equal(out.length,x.ok?1:0,JSON.stringify(x));assert.equal(pivot.isBroken,x.ok);}
});
test('directional CHoCH momentum uses ready positive candidate channel, not abs signed legacy Z',()=>{
 for(const [zUp,zDn,ready,ok] of [[1.1,0,true,true],[0,4,true,false],[1.09,0,true,false],[4,0,false,false]] as const){
 const cfg={...directional,valid_bos_displacement:false,choch_require_momentum:true};const e=new MarketStructureEngine();e.currentTrend='Bearish';seed(e,cfg);const out=e.processCandle(c(4,10,13,10,12),[p()],[],cfg,2,{zScore:-5,impulse:impulse(4,zUp,zDn,2,ready)});assert.equal(out.length,ok?1:0);
 }
});
test('invalid experimental geometry/time/availability never becomes a historical gate frame',()=>{
 for(const bad of [c(4,10,10.5,10,12),{...c(4,10,13,10,12),timestamp:NaN}]){
 const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e);const pivot=p();
 assert.equal(e.processCandle(bad,[pivot],[],exp,2,{zScore:3}).length,0);assert.equal(pivot.isBroken,false);
 const out=e.processCandle(c(5,10,13,10,12),[pivot],[],exp,2,{zScore:3});assert.equal(out[0]?.breakTimestamp,5000);
 }
 for(const availableAt of [1000,NaN,Infinity]){const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e);const pivot=p();assert.equal(e.processCandle(c(4,10,13,10,12),[pivot],[],exp,2,{zScore:3,availableAt}).length,0);assert.equal(pivot.isBroken,false);}
 const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e);assert.equal(e.processCandle(c(2,10,13,10,12),[p()],[],exp,2,{zScore:3}).length,0);
});
test('experimental active gates reject invalid ATR even with legacy momentum ablation',()=>{
 for(const atr of [0,-1,NaN,Infinity]){const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e);assert.equal(e.processCandle(c(4,10,13,10,12),[p()],[],exp,atr,{zScore:3}).length,0);}
});
test('neutral/BOS/reversal branches and both directions freeze the first break gate',()=>{
 const mirror=(b:OHLCV):OHLCV=>({...b,open:20-b.open,high:20-b.low,low:20-b.high,close:20-b.close});
 for(const bullish of [true,false])for(const branch of ['Neutral','BOS','CHoCH'] as const){
 const e=new MarketStructureEngine();e.currentTrend=branch==='Neutral'?'Neutral':branch==='BOS'?(bullish?'Bullish':'Bearish'):(bullish?'Bearish':'Bullish');
 const map=bullish?(b:OHLCV)=>b:mirror;const pivot={...p(),type:bullish?'High' as const:'Low' as const};
 const feed=(b:OHLCV,withPivot=false,z=1)=>e.processCandle(map(b),withPivot&&bullish?[pivot]:[],withPivot&&!bullish?[pivot]:[],exp,2,{zScore:bullish?z:-z});
 for(const b of [c(1,8,9,7,8),c(2,9,10,8,9),c(3,8,9,7,8)])feed(b);
 feed(c(4,10,10.2,10,10.1));assert.equal(feed(c(5,10,13,10,12),true,3).length,0,`${bullish}/${branch}`);assert.equal(pivot.isBroken,false);
 }
});
test('historical volume uses only pre-break bars, never approval-bar volume/baseline',()=>{
 for(const goodVolume of [true,false]){
 const cfg={...exp,displ_vol_mult:2};const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e,cfg);
 e.processCandle(c(4,10,13,10,12,goodVolume?300:150),[],[],cfg,2,{zScore:3});
 const out=e.processCandle(c(5,10,13,10,12,goodVolume?1:10000),[p()],[],cfg,2,{zScore:3});assert.equal(out.length,goodVolume?1:0);
 }
});
test('late sweep/BOS/momentum context cannot rescue a rejected historical CHoCH',()=>{
 for(const gate of ['sweep','bos','momentum'] as const){
 const cfg={...directional,valid_bos_displacement:false,choch_require_sweep:gate==='sweep',choch_require_bos_prior:gate==='bos',choch_require_momentum:gate==='momentum'};
 const e=new MarketStructureEngine();e.currentTrend='Bearish';
 for(const b of [c(1,8,9,7,8),c(2,9,10,8,9),c(3,8,9,8,8)])e.processCandle(b,[],[],cfg,2);
 const old=c(4,10,13,10,12);const snapshot=impulse(4,0,4);const directions:Direction[]=[];
 e.processCandle(old,[],[],cfg,2,{impulse:snapshot,sweepDirections:directions,crtValid:false});
 old.volume=10000;snapshot.zUp=10;directions.push('Bullish'); // Caller mutation cannot rewrite as-of frames.
 e.lastBOS={...p(),type:'Low'};
 const out=e.processCandle(c(5,10,13,10,12),[p()],[],cfg,2,{impulse:impulse(5),sweepDirections:['Bullish','Bearish'],crtValid:true});assert.equal(out.length,0,gate);
 }
});
test('same-bar dual sweep flags support each candidate direction with frozen CRT',()=>{
 for(const bullish of [true,false]){
 const cfg={...exp,valid_bos_displacement:false,choch_require_sweep:true};const e=new MarketStructureEngine();e.currentTrend=bullish?'Bearish':'Bullish';
 const map=(b:OHLCV)=>bullish?b:{...b,open:20-b.open,high:20-b.low,low:20-b.high,close:20-b.close};
 for(const b of [c(1,8,9,7,8),c(2,9,10,8,9),c(3,8,9,8,8)])e.processCandle(map(b),[],[],cfg,2);
 const pivot={...p(),type:bullish?'High' as const:'Low' as const};
 e.processCandle(map(c(4,10,13,10,12)),[],[],cfg,2,{sweepDirections:['Bullish','Bearish'],crtValid:true});
 const out=e.processCandle(map(c(5,10,13,10,12)),bullish?[pivot]:[],bullish?[]:[pivot],cfg,2,{crtValid:false});
 assert.equal(out[0]?.direction,bullish?'Bullish':'Bearish');assert.equal(out[0]?.crtOrigin,true);assert.equal(out[0]?.breakTimestamp,4000);
 }
});
test('unknown/truncated pivot history fails closed rather than inventing an origin gate',()=>{
 const e=new MarketStructureEngine();e.currentTrend='Bullish';assert.equal(e.processCandle(c(5,10,13,10,12),[p()],[],exp,2,{zScore:3}).length,0);
 const capped=new MarketStructureEngine();capped.currentTrend='Bullish';seed(capped);for(let t=4;t<=155;t++)capped.processCandle(c(t,8,9,7,8),[],[],exp,2);
 const pivot=p();assert.equal(capped.processCandle(c(156,10,13,10,12),[pivot],[],exp,2,{zScore:3}).length,0);assert.equal(pivot.isBroken,false);
});
test('delayed event does not discard already-observed trend extremes for subsequent gates',()=>{
 const cfg={...exp,choch_require_sweep:true};const e=new MarketStructureEngine();e.currentTrend='Bullish';seed(e,cfg);
 e.processCandle(c(4,10,13,10,12),[],[],cfg,2,{zScore:3});assert.equal(e.processCandle(c(5,10,100,10,12),[p()],[],cfg,2,{zScore:0}).length,1);
 e.processCandle(c(6,11,20,9,11),[],[],cfg,2);e.processCandle(c(7,11,19,9.5,11),[],[],cfg,2);
 const low:Pivot={index:5,timestamp:6000,price:9,type:'Low',isBroken:false};
 assert.equal(e.processCandle(c(8,10,10,7,8),[],[low],cfg,2,{zScore:-3}).length,0);assert.equal(low.isBroken,false);
});
console.log(JSON.stringify({count,failures}));if(failures)process.exitCode=1;
