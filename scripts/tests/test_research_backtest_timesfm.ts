import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseCSV,runBacktest} from '../../jarvis-os/src/services/backtestEngine';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bt-timesfm-'));const t=Date.parse('2026-07-14T15:00:00Z');
const cache=path.join(tmp,'cache.jsonl'),audit=path.join(tmp,'audit.jsonl');
const alerts=Array.from({length:14},(_,i)=>`PING_PRICE | TF: 5 | Precio: 1.1 | High: 1.1005 | Low: 1.0995 | TS: ${t-(14-i)*300000}`);
alerts.push(`EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${t}`,`PING_PRICE | TF: 5 | Precio: 1.1 | TS: ${t+60000}`);
const entries=parseCSV(alerts.join('\n')).lines;
const cfg:any={ticker:'EURUSD',minBuyPoints:1,minSellPoints:1,oteEntryPercent:70,entryTrigger:'CHOCH'};
const run=(timesfm:any)=>runBacktest(new Map(),{...cfg,timesfm},undefined,entries);
const old=globalThis.fetch;let fetches=0;globalThis.fetch=async()=>{fetches++;throw new Error('HTTP forbidden in historical backtest');};
try{
 fs.writeFileSync(cache,JSON.stringify({ts:t,horizon:1,q10:[.8999],q50:[.9],q90:[.9001]})+'\n');
 const reject=run({enabled:true,cachePath:cache,auditPath:audit});assert.equal(reject.trades.length,0);
 const record=JSON.parse(fs.readFileSync(audit,'utf8').trim().split('\n')[0]);assert.equal(record.action,'REJECT');assert.equal(record.degraded,false);
 const shadow=run({enabled:true,cachePath:cache,auditPath:audit,dryRun:true,liveTransport:'ram'});assert.equal(shadow.trades.length,1,'live transport flag cannot replace historical offline cache semantics');
 const miss=run({enabled:true,cachePath:path.join(tmp,'absent'),auditPath:audit});assert.equal(miss.trades.length,1);assert.equal(miss.trades[0].timesfmAction,'APPROVE');
 assert.equal(fetches,0);assert.equal(Object.keys(shadow.trades[0].mlFeatures!).length,12);
 console.log('PASS actual BT TimesFM historical quantiles no ticker, reject/dryrun/degraded, zero HTTP');
}finally{globalThis.fetch=old;fs.rmSync(tmp,{recursive:true,force:true});}
