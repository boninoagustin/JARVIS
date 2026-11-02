import assert from 'node:assert/strict';
import {parseCSV,runBacktest} from '../../jarvis-os/src/services/backtestEngine';
import type {BacktestConfig} from '../../jarvis-os/src/services/backtestTypes';
const t=Date.parse('2026-07-14T15:00:00Z');
const lines=parseCSV(`PING_PRICE | TF: 5 | Precio: 1.1 | High: 1.1002 | Low: 1.0998 | TS: ${t-100}
EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${t+1}
PING_PRICE | TF: 5 | Precio: 1.1 | TS: ${t+60000}`).lines;
const config:BacktestConfig={ticker:'EURUSD',minBuyPoints:1,minSellPoints:1,oteEntryPercent:70,entryTrigger:'CHOCH'};
const run=(c:any,cb?:any)=>{const random=Math.random;Math.random=()=>.25;try{return runBacktest(new Map(),c,cb,lines);}finally{Math.random=random;}};
const legacy=run({...config});assert.equal(legacy.trades.length,1);
assert.deepEqual(run({...config,rolloverPolicy:{profile:'legacy'},mlRegimeShadow:false}),legacy);
const shadow=run({...config,mlRegimeShadow:true});
assert.equal((shadow.trades[0] as any).mlRegimeShadow?.status,'UNAVAILABLE','actual entry calls separate regime predictor when shadow opted in');
const strip=({researchReport,...r}:any)=>({...r,trades:r.trades.map(({mlRegimeShadow,...trade}:any)=>trade)});
assert.deepEqual(strip(shadow),legacy,'shadow must not alter 12-feature gate/scoring/fills');
assert.equal(Object.keys(shadow.trades[0].mlFeatures!).length,12);
const mutate:any={...config,mlRegimeShadow:true};
const isolated=run(mutate,()=>{mutate.mlRegimeShadow=false;mutate.minBuyPoints=999;});
assert.deepEqual(isolated,shadow,'research config owned by run before progress callback');
console.log('PASS actual BT entry shadow unavailable, legacy identity, owned config');
