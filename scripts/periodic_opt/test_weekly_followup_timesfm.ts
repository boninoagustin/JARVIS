// Tiny synthetic/offline contract tests. No bridge, inference or historical replay.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {prepareEntries,runBacktest} from '../../jarvis-os/src/services/backtestEngine.js';
import {planReplayWindow} from '../../jarvis-os/src/services/replayWindow.js';
import {mapAssetConfig} from './selection_context.js';
import {readOnlyReplayConfig,configFingerprint} from '../hyperopt/evaluation_protocol.js';
import {evaluateFollowup} from './weekly_followup.js';
import {RpcWorker} from './eval_production.js';
const dir=mkdtempSync(path.join(tmpdir(),'followup-timesfm-offline-'));
const start=Date.parse('2026-07-14T15:00:00Z');
const asset={entryTrigger:'CHOCH',minBuyPoints:1,minSellPoints:1,oteEntryPercent:70,
  maxTradesPerDay:0,maxTradesPerSession:0,sessionWarmupMin:0,mlGateEnabled:false};
const ping=(t:number,p=1.1)=>`PING_PRICE | TF: 5 | Precio: ${p} | High: ${p+0.0002} | Low: ${p-0.0002} | TS: ${t}`;
const lines=Array.from({length:20},(_,i)=>ping(start-(20-i)*300000));
for(let i=0;i<8;i++)lines.push(ping(start+i*300000),`EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${start+i*300000+1}`,ping(start+i*300000+60000,1.105),ping(start+i*300000+120000));
lines.push(ping(start+8*300000));
const forecast=(tf:number,ts:number,observedAt:number)=>({schema_version:2,timestamp_convention:'context_close_ms_v2',
  ts,contextCloseTimeMs:ts,computedAt:ts+10,availableAt:ts+20,ticker:'eurusd',tf,horizon:1,
  q10:[1.08999],q50:[1.09],q90:[1.09001],model_version:'synthetic-native-v2'});
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
function deterministic<T>(fn:()=>T):T {const old=Math.random;let seed=123;Math.random=()=>((seed=(seed*16807)%2147483647)/2147483647);try{return fn();}finally{Math.random=old;}}
try {
  const logs=new Map([['5',lines]]),entries=await prepareEntries(logs);
  const window=planReplayWindow(entries,start,start+8*300000+1,{warmupDays:0,minContextObservations:{'5':1}});
  const config=readOnlyReplayConfig(mapAssetConfig('EURUSD',{...asset,timesfm:{enabled:true,cachePath:path.join(dir,'absent-legacy.jsonl')}}));
  const calls:number[][]=[];
  const hooked=deterministic(()=>runBacktest(logs,structuredClone(config),undefined,entries,window,{timesfmForecastAt:(now,tf)=>{calls.push([now,tf]);return forecast(tf,start-900000,now);}}));
  assert.ok(calls.length>=8,'sixth argument must drive actual createTrade callback');
  assert.ok(calls.some(([now,tf])=>now===start+1&&tf===5),'callback receives event time, not candle-key time');
  assert.ok(hooked.trades.length<8,'actual counter-forecast rejects low-score trades with initialized ATR');
  assert.throws(()=>runBacktest(logs,structuredClone(config),undefined,entries,undefined,{timesfmForecastAt:()=>undefined}),/replay|context|window/i);
  const after=deterministic(()=>runBacktest(logs,structuredClone(config),undefined,entries,window));
  assert.ok(after.trades.length>=8,'default run clears prior resolver');
  // Load the exact saved pre-fix bytes in memory at their original resolution base.
  const require=createRequire(import.meta.url),ts=require('typescript'),Module=require('node:module');
  const enginePath=path.resolve('jarvis-os/src/services/backtestEngine.ts');
  const originalPath='/opt/jarvis-research/autotune-enable-20261026-053344/pre-timesfm-fix/jarvis-os/src/services/backtestEngine.ts';
  const originalBytes=readFileSync(originalPath);
  assert.equal(hash(originalBytes),'6325831a832bfee516b4c446e61c45d858ec1ff4171dd91e2c9af366dabbd1c1','pinned actual pre-fix source identity');
  const oldModule=new Module(enginePath);oldModule.filename=enginePath;oldModule.paths=Module._nodeModulePaths(path.dirname(enginePath));
  oldModule._compile(ts.transpileModule(originalBytes.toString(),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,enginePath);
  const legacyPath=path.join(dir,'legacy.jsonl');
  writeFileSync(legacyPath,Array.from({length:9},(_,i)=>JSON.stringify({ts:start+i*300000,horizon:1,q10:[1.08999],q50:[1.09],q90:[1.09001]})).join('\n')+'\n');
  for(const cfg of [config,{...config,timesfm:{...config.timesfm,cachePath:legacyPath}},{...config,timesfm:{enabled:false}}]){
    for(const replay of [undefined,window]){
      const actual=deterministic(()=>runBacktest(logs,structuredClone(cfg),undefined,entries,replay));
      const original=deterministic(()=>oldModule.exports.runBacktest(logs,structuredClone(cfg),undefined,entries,replay));
      assert.deepEqual(actual,original,'default/no-hook exact result parity with saved pre-fix source, including legacy cache');
    }
  }
  const missing=deterministic(()=>runBacktest(logs,structuredClone({...config,timesfm:{...config.timesfm,cachePath:legacyPath}}),undefined,entries,window,{timesfmForecastAt:()=>undefined}));
  assert.ok(missing.trades.length>=8,'undefined resolver degrades, never falls back to rejecting legacy cache');
  assert.deepEqual(deterministic(()=>runBacktest(logs,structuredClone(config),undefined,entries,window)),after,'resolver does not leak across runs');
  console.log('PASS hook actual event/TF, offline-only guard, undefined degradation, cross-run reset; exact saved-byte baseline parity (6 runs)');
  writeFileSync(path.join(dir,'M5.csv'),lines.join('\n'));
  const rpc=new RpcWorker();let init:any;
  try{init=await rpc.call('init',{ticker:'EURUSD',log_dir:dir});}finally{rpc.close();}
  const ledgerPath=path.join(dir,'live.jsonl'),epoch='12345678-1234-4234-8234-123456789abc';
  const baseRow=(tf:number,observedAt:number)=>({schema_version:1,ticker:'EURUSD',tf,observedAt,producer_epoch:epoch});
  const initialRows=[5,15].map(tf=>({...baseRow(tf,start-1000),kind:'unavailable',reason:'recorder_epoch_start'}));
  const prefix=initialRows.map(r=>JSON.stringify(r)+'\n').join('');
  const rows:any[]=[...initialRows];
  for(let t=start-500;t<=start+8*300000;t+=15000)for(const tf of [5,15]){
    const fc={...forecast(tf,start-900000,t),q10:[1.10499],q50:[1.105],q90:[1.10501]};
    rows.push({...baseRow(tf,t),kind:t===start-500?'forecast':'heartbeat',forecastFingerprint:configFingerprint(fc),...(t===start-500?{forecast:fc}:{})});
  }
  // The last M5 timestamp is also independently observed for both TFs.
  for(const tf of [5,15])rows.push({...baseRow(tf,start+8*300000),kind:'heartbeat',forecastFingerprint:rows.find(r=>r.tf===tf&&r.kind==='forecast').forecastFingerprint});
  writeFileSync(ledgerPath,rows.map(r=>JSON.stringify(r)+'\n').join(''));
  const liveAsset={...asset,timesfm:{enabled:true,cachePath:legacyPath,auditPath:path.join(dir,'MUST_NOT_WRITE')}};
  const liveInput={ticker:'EURUSD',appliedAt:start-1000,priorEvaluatedEndMs:start,beforeAsset:liveAsset,appliedAsset:structuredClone(liveAsset),
    evaluatedBeforeConfig:mapAssetConfig('EURUSD',liveAsset),evaluatedAppliedConfig:mapAssetConfig('EURUSD',liveAsset),
    logsDir:dir,outputDir:path.join(dir,'evidence'),worker:{call:async()=>init},expectedSourceFiles:init.provenance.source_files,
    minIntervalMs:1,minContextObservations:{'5':1},warmupDays:0,
    expectedLiveLedger:{path:ledgerPath,model_version:'synthetic-native-v2',registered_at_ms:start-1000,prefix_sha256:hash(prefix),prefix_size_bytes:Buffer.byteLength(prefix)}};
  const live=await evaluateFollowup(liveInput);
  assert.equal(live.decision,'KEEP',live.reason);
  assert.ok(live.before.closedTrades.length>=8,'causal observation stream, not rejecting legacy cache, drives real paired engine');
  assert.deepEqual(live.before.returns,live.applied.returns);
  assert.equal(live.window.from_ms,start);assert.equal(live.window.to_ms,start+8*300000+1);
  assert.equal(live.evidence.frozenInputs.expectedLiveLedger.prefix_sha256,hash(prefix));
  assert.equal(hash(readFileSync(live.liveLedger.snapshotEvidencePath)),live.liveLedger.snapshot.sha256);
  assert.deepEqual(JSON.parse(readFileSync(live.evidencePath,'utf8')),live.evidence);
  console.log('PASS actual paired engine consumes shared immutable native ledger and local content-addressed evidence, ignoring legacy cache');
  const putRows=(observations:any[])=>writeFileSync(ledgerPath,observations.map(r=>JSON.stringify(r)+'\n').join(''));
  putRows(rows.filter(r=>r.tf===5||r.observedAt===start-1000));
  const absentTf=await evaluateFollowup(liveInput);
  assert.equal(absentTf.decision,'PENDING','both native TF observation streams must cover the evaluation, even if signals only use M5');
  assert.match(absentTf.reason,/interval|coverage/);
  putRows(rows.filter(r=>r.tf!==15||r.observedAt<start+600000||r.observedAt>=start+660000));
  const observationHole=await evaluateFollowup(liveInput);
  assert.equal(observationHole.decision,'PENDING','a heartbeat hole is not invented degraded forecast coverage');
  assert.match(observationHole.reason,/observation_gap/);
  const backwards=structuredClone(rows);backwards[10].observedAt=backwards[8].observedAt-1;putRows(backwards);
  const regressedClock=await evaluateFollowup(liveInput);
  assert.equal(regressedClock.decision,'PENDING','observation order cannot be repaired by sorting');
  assert.match(regressedClock.reason,/clock|monotonic/);
  const changedHeartbeat=structuredClone(rows);changedHeartbeat[10].forecastFingerprint='0'.repeat(64);putRows(changedHeartbeat);
  const wrongHeartbeat=await evaluateFollowup(liveInput);
  assert.equal(wrongHeartbeat.decision,'PENDING','heartbeat must refer to exact current native envelope');
  assert.match(wrongHeartbeat.reason,/fingerprint|heartbeat/);
} finally {rmSync(dir,{recursive:true,force:true});}
