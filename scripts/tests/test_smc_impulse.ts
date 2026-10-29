import assert from 'node:assert/strict';
import { DirectionalImpulseCalculator, isValidImpulseCandle } from '../../src/engine/smc/math/directional_impulse.js';
import type { OHLCV } from '../../src/engine/smc/types.js';
const candle: OHLCV = { timestamp: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 };
assert.equal(isValidImpulseCandle(candle), true);
assert.equal(isValidImpulseCandle({ ...candle, high: 10 }), false);
assert.equal(isValidImpulseCandle({ ...candle, timestamp: NaN }), false);
assert.equal(isValidImpulseCandle({ ...candle, low: Infinity }), false);
const calc = new DirectionalImpulseCalculator();
assert.equal(calc.last, null);
assert.equal(calc.nextValue({ ...candle, close: 20 }, 1), null);
assert.equal(calc.nextValue(candle, 0), null);
assert.equal(calc.last, null);
for (const config of [{window: 1}, {window: 2.5}, {decay: 1}, {decay: NaN}, {wickWeight: -1}, {volWindow: 0}, {foo: true}]) assert.throws(() => new DirectionalImpulseCalculator(config as any));
console.log('PASS impulse geometry, empty state and config validation');
assert.equal(isValidImpulseCandle({ ...candle, timestamp: -1 }), false);
assert.equal(isValidImpulseCandle({ ...candle, timestamp: .5 }), false);
assert.equal(isValidImpulseCandle({ ...candle, high: Number.MAX_VALUE, low: -Number.MAX_VALUE }), false);
assert.equal(isValidImpulseCandle({ ...candle, volume: NaN }), true);
assert.equal(isValidImpulseCandle({ ...candle, open: 10, close: 10, high: 10, low: 10 }), true);
console.log('PASS impulse time and finite derived geometry');

// Literal user equations; zero-seeded EMA, population rolling Z including current.
const sequence = new DirectionalImpulseCalculator({window:3,decay:.8,wickWeight:.35,volWindow:2});
const rows = [
 {timestamp:100,open:10,high:12,low:9,close:11,volume:10},
 {timestamp:101,open:11,high:12,low:9,close:10,volume:30},
 {timestamp:102,open:10,high:13,low:9,close:12,volume:0},
 {timestamp:103,open:12,high:13,low:9,close:10,volume:40},
];
let u=0,d=0;const uh:number[]=[],dh:number[]=[];const vh:number[]=[];
const rolling=(a:number[])=>{const mean=a.reduce((s,x)=>s+x,0)/a.length;const sd=Math.sqrt(a.reduce((s,x)=>s+(x-mean)**2,0)/a.length);return sd>1e-8?(a[a.length-1]-mean)/sd:0;};
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
for(let i=0;i<rows.length;i++){
 const r=rows[i],atr=2,mid=(r.high+r.low)/2;
 u=.8*u+.2*(Math.max(0,r.close-r.open)+.35*Math.max(0,r.close-mid))/atr;
 d=.8*d+.2*(Math.max(0,r.open-r.close)+.35*Math.max(0,mid-r.close))/atr;
 uh.push(u);dh.push(d);if(uh.length>3){uh.shift();dh.shift();}
 const prior=vh.length?vh.reduce((s,x)=>s+x,0)/vh.length:null;
 const snap=sequence.nextValue(r,atr);assert.ok(snap,'valid candle must advance the directional calculator');
 near(snap!.upSmooth,u);near(snap!.dnSmooth,d);near(snap!.zUp,rolling(uh));near(snap!.zDn,rolling(dh));
 assert.equal(snap!.ready,i>=2);assert.equal(snap!.sampleCount,Math.min(i+1,3));
 assert.equal(snap!.priorVolumeMean,prior);
 near(snap!.volumeRatio,r.volume>0&&prior!==null&&prior>0?r.volume/prior:1);
 assert.ok(Object.isFrozen(snap));
 vh.push(r.volume);if(vh.length>2)vh.shift();
 assert.deepEqual(sequence.nextValue({...r},atr),snap,'identical repeat is idempotent');
}
const last=sequence.last;
assert.equal(sequence.nextValue({...rows[3],timestamp:104,high:9},2),null);
assert.equal(sequence.last,last,'invalid input must not mutate or masquerade as a fresh observation');
assert.throws(()=>sequence.nextValue({...rows[3],close:10.1},2),/duplicate|conflict/i);
assert.throws(()=>sequence.nextValue(rows[0],2),/order|timestamp/i);
sequence.reset();assert.equal(sequence.last,null);
assert.equal(sequence.nextValue(rows[0],2)!.sampleCount,1);
console.log('PASS exact directional recurrence, rolling statistics, prior-bar volume, duplicate and reset semantics');
