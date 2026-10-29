// Real tiny offline engine replays; no broker, history download or deployment.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {evaluateFollowup} from './weekly_followup.js';
import {RpcWorker} from './eval_production.js';
import {mapAssetConfig} from './selection_context.js';
import {registerRolloverSchedule,getRolloverCalendar} from '../../src/engine/RolloverSpreadGate.js';
const dir=mkdtempSync(path.join(tmpdir(),'followup-calendar-replay-'));
const start=Date.parse('2026-07-14T15:00:00Z');
const open={scheduleTimeZone:'UTC',schedule:[{startSecond:0,endSecond:604800}]};
// Engine's existing flag blocks short rollover pauses (entryWindow), not all
// closed markets. Supply a real short pause covering this synthetic interval.
const closed={scheduleTimeZone:'UTC',schedule:[{startSecond:0,endSecond:2*86400+15*3600},{startSecond:2*86400+16*3600,endSecond:604800}]};
const asset={entryTrigger:'CHOCH',minBuyPoints:1,minSellPoints:1,oteEntryPercent:70,maxTradesPerDay:0,maxTradesPerSession:0,sessionWarmupMin:0,mlGateEnabled:false};
const ping=(t:number,p=1.1)=>`PING_PRICE | TF: 5 | Precio: ${p} | High: ${p+0.0002} | Low: ${p-0.0002} | TS: ${t}`;
try {
 const lines=[ping(start-300000)];
 for(let i=0;i<8;i++)lines.push(ping(start+i*300000),`EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${start+i*300000+1}`,ping(start+i*300000+60000,1.105),ping(start+i*300000+120000));
 lines.push(ping(start+8*300000));
 writeFileSync(path.join(dir,'M5.csv'),lines.join('\n'));
 const rpc=new RpcWorker();let init:any;
 try{init=await rpc.call('init',{ticker:'EURUSD',log_dir:dir});}finally{rpc.close();}
 const config={...mapAssetConfig('EURUSD',asset),rolloverEntryBlock:true};
 let initCalls=0;
 const input={ticker:'EURUSD',appliedAt:start,priorEvaluatedEndMs:start,beforeAsset:asset,appliedAsset:asset,
  evaluatedBeforeConfig:config,evaluatedAppliedConfig:config,logsDir:dir,outputDir:path.join(dir,'evidence'),
  worker:{call:async(method:string)=>{assert.equal(method,'init');initCalls++;return init;}},expectedSourceFiles:init.provenance.source_files,
  minIntervalMs:1,minContextObservations:{'5':1},warmupDays:0};
 // First with no registered schedule: supplied closed calendar must override FX
 // fallback for BOTH actual engines, then disappear rather than becoming global.
 assert.equal(getRolloverCalendar('EURUSD',start).metadataAvailable,false);
 const defaultBefore=getRolloverCalendar('EURUSD',start);
 const blocked=await evaluateFollowup({...input,brokerCalendar:closed});
 assert.equal(blocked.reason,'insufficient_trades',blocked.reason);
 assert.equal(blocked.before.closedTrades.length,0,'before replay must use supplied closed real-ticker calendar');
 assert.equal(blocked.applied.closedTrades.length,0,'applied replay must use the same supplied closed calendar');
 assert.deepEqual(getRolloverCalendar('EURUSD',start),defaultBefore,'absent registration must stay absent after evaluation');
 // A conflicting prior registration must survive success, invalid input and
 // exceptions; later calls must not inherit the preceding supplied schedule.
 registerRolloverSchedule('EURUSD',closed);
 const prior=getRolloverCalendar('EURUSD',start);
 const kept=await evaluateFollowup({...input,brokerCalendar:open});
 assert.equal(kept.decision,'KEEP',kept.reason);
 for(const side of ['before','applied'])assert.ok(kept[side].closedTrades.length>=8,`${side} uses supplied open calendar, not caller closed calendar`);
 assert.deepEqual(getRolloverCalendar('EURUSD',start),prior);
 const owned=await evaluateFollowup({...input,worker:undefined,brokerCalendar:open});
 assert.equal(owned.decision,'KEEP',owned.reason);
 assert.deepEqual(getRolloverCalendar('EURUSD',start),prior,'owned RPC path also remains calendar-isolated');
 const blockedAgain=await evaluateFollowup({...input,brokerCalendar:closed});
 assert.equal(blockedAgain.before.closedTrades.length,0);assert.equal(blockedAgain.applied.closedTrades.length,0);
 assert.deepEqual(getRolloverCalendar('EURUSD',start),prior);
 const invalid=await evaluateFollowup({...input,brokerCalendar:{...open,scheduleTimeZone:'not/a/timezone'}});
 assert.equal(invalid.decision,'PENDING');assert.match(invalid.reason,/calendar/i);
 assert.deepEqual(getRolloverCalendar('EURUSD',start),prior,'invalid calendar cannot destructively remove caller state');
 const failed=await evaluateFollowup({...input,brokerCalendar:open,worker:{call:async()=>{throw new Error('isolated init failure');}}});
 assert.equal(failed.reason,'isolated init failure');
 assert.deepEqual(getRolloverCalendar('EURUSD',start),prior,'error exit leaves prior registration unchanged');
 assert.equal(initCalls,4,'injected init seam remains supported for isolated evaluation');
 console.log('PASS actual before/applied real-ticker supplied calendars; absence/prior registration restored, repeated/invalid/error calls isolated');
} finally {rmSync(dir,{recursive:true,force:true});}
