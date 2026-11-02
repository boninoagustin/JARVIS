import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parse} from 'csv-parse/sync';
import * as context from '../../src/engine/ExecutionContext.js';
import * as micro from '../../src/engine/ExecutionMicrostructure.js';
import * as costs from '../../src/engine/ExecutionCosts.js';
import * as targets from '../../src/engine/tp2Cap.js';
import * as types from '../../src/engine/Types.js';
import {SMCEngine} from '../../src/engine/smc/SMCEngine.js';
import type {OHLCV} from '../../src/engine/smc/types.js';

// Cached, already frozen review sample: no network, broker, production export or preset writes.
const root=path.resolve(import.meta.dirname,'../..');
const evidence='/tmp/jarvis-execution-verification/fix-adapters';
fs.mkdirSync(evidence,{recursive:true});
const tmp=fs.mkdtempSync(path.join(evidence,'producer-'));
const fixture='/tmp/jarvis-execution-verification/review-integration';
const raw=path.join(tmp,'input');fs.mkdirSync(raw);
const input=path.join(raw,'history_M5.csv');
fs.copyFileSync(path.join(fixture,'export-sample-input/history_M5.csv'),input);
const preset=path.join(tmp,'preset.json');fs.copyFileSync(path.join(root,'optimized_preset_EURUSD.json'),preset);
const digest=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputHash=digest(input),presetHash=digest(preset);
const original=JSON.parse(fs.readFileSync(path.join(fixture,'export-sample-context/export_manifest.json'),'utf8'));
assert.equal(inputHash,original.inputHashes[path.join(fixture,'export-sample-input/history_M5.csv')]);
assert.equal(presetHash,original.inputHashes[path.join(root,'optimized_preset_EURUSD.json')]);
function cli(name:string,ex1:boolean){
 const output=path.join(tmp,name);
 const p=spawnSync(path.join(root,'node_modules/.bin/tsx'),['scripts/export_smc_csv.ts','EURUSD','--input-dir',raw,'--output-dir',output,'--preset-file',preset,'--timeframes','M5','--quiet',...(ex1?['--execution-context']:[])],{cwd:root,encoding:'utf8',timeout:120000});
 fs.writeFileSync(path.join(tmp,name+'.log'),p.stdout+p.stderr);
 assert.equal(p.status,0,p.stdout+p.stderr);
 const manifest=JSON.parse(fs.readFileSync(path.join(output,'export_manifest.json'),'utf8'));
 assert.equal(manifest.execution_context_version,ex1?1:null);
 return {manifest,csv:fs.readFileSync(path.join(output,'pine-logs-SMC Master_M5.csv'),'utf8'),rows:parse(fs.readFileSync(path.join(output,'pine-logs-SMC Master_M5.csv'),'utf8'),{columns:true}) as {Fecha:string;Mensaje:string}[]};
}
const exported=cli('context',true),plain=cli('plain',false);
assert.deepEqual(exported.rows.map(r=>({...r,Mensaje:r.Mensaje.split(' | EX1:')[0]})),plain.rows,'all legacy CSV cells unchanged after EX1 removal');
const strip=(csv:string)=>csv.replace(/ \| EX1: [A-Za-z0-9_-]+/g,'');
assert.equal(strip(exported.csv),plain.csv,'EX1 opt-in preserves every plain CSV byte');
assert.equal(strip(fs.readFileSync(path.join(fixture,'export-sample-context/pine-logs-SMC Master_M5.csv'),'utf8')),plain.csv,'plain CSV bytes unchanged versus frozen pre-fix export');
assert.equal(digest(input),inputHash);assert.equal(digest(preset),presetHash);
const candles=parse(fs.readFileSync(input,'utf8'),{columns:true,cast:true}) as OHLCV[];assert.equal(candles.length,1200);
// Replay the actual detector to independently identify delayed events and FVG provenance.
const log=console.log.bind(console);console.log=(...args:unknown[])=>{if(typeof args[0]==='string'&&/^\[SMC-(ENGINE|GATES)\]/.test(args[0]))return;log(...args);};
const detector=new SMCEngine(exported.manifest.exports[0].effectivePreset,'M5');
const eventsAt=new Map<number,any[]>();
const fvgAt=new Map<number,any[]>();
for(const candle of candles){detector.setHTFContext('Neutral','Neutral');const events=detector.nextCandle(candle);eventsAt.set(candle.timestamp+300000,events.filter((e:any)=>['EVENT_BOS','EVENT_CHOCH'].includes(e.type)));fvgAt.set(candle.timestamp+300000,JSON.parse(JSON.stringify(detector.getState().activeFVGs)));}
function execute(file:string,names?:string[]){
 const source=fs.readFileSync(path.join(root,file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const nodes=ast.statements.filter(n=>!ts.isImportDeclaration(n)&&(!names||(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text??''))));
 if(names)assert.equal(nodes.length,names.length);
 const exports:any={};
 vm.runInNewContext(ts.transpileModule(nodes.map(n=>n.getFullText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,console,process:{env:{}},...context,...micro,...costs,...targets,...types,telemetry:new Proxy({},{get:()=>()=>{}}),mlPredict:()=>null,isMLActive:()=>false});
 return exports;
}
const alpha=execute('src/engine/AlphaModel.ts');
const live=execute('src/db/trading.ts',['routeExecutionSetup']); // never import trading or its services
const state=alpha.emptyState();
const errors:string[]=[],report:any[]=[];
const routedLegs:any[]=[];
let actualAlphaFills=0,controlledAlphaFills=0;
let structuralCount=0,delayedCount=0,positiveRoutes=0,positiveAlphaBuy=0,positiveAlphaSell=0,fvgs=0;
const cfg={entryTrigger:'SMART',oteEntryPercent:1,slBufferPercent:0,fixedRR:2,executionPolicy:{profile:'microstructure_v1',targets:false}};
for(const row of exported.rows){
 const at=Number(row.Mensaje.match(/\| TS: (\d+)/)?.[1]);
 const decoded=context.parseExecutionEnvelope(row.Mensaje,at);if(!row.Mensaje.includes(' | EX1:'))continue;
 assert.ok(decoded.observation,decoded.reason);const o=decoded.observation!;
 assert.equal(o.bar?.closed,true);assert.equal(o.quote,undefined);assert.equal(o.tickActivity,undefined);
 const ingested=context.ingestExecutionContext(state,o,at);assert.equal(ingested.accepted,true,ingested.reason);
 if(/^EVENTO_(BOS|CHOCH) /.test(decoded.text)){
  structuralCount++;
  const direction=decoded.text.match(/Dir: (BUY|SELL)/)![1];
  const origin=Number(decoded.text.match(/ORIGIN: ([0-9.]+)/)![1]),price=Number(decoded.text.match(/Precio: ([0-9.]+)/)![1]);
  const event=eventsAt.get(at)!.shift();assert.ok(event,'actual detector event must back every structural row');
  const delayed=(event.breakTimestamp??event.timestamp)!==o.bar!.openTimeMs;
  if(delayed)delayedCount++;
  if(JSON.stringify(o.impulse)!==JSON.stringify({direction,origin,extreme:price,createdAtMs:at}))errors.push(`identity ${at} delayed=${delayed}: ${JSON.stringify(o.impulse)} vs ${direction}/${origin}/${price}/${at}`);
  if(delayed&&o.breakBar)errors.push(`delayed event fabricated break vintage ${at}`);
  const snap=context.getExecutionSnapshot(state,o.tf,at);
  const leg:any={dir:direction,origin,extreme:price,createdAt:at,executionSnapshot:snap};
  const d=direction==='BUY'?1:-1,risk=Math.abs(price-origin);
  const decision=live.routeExecutionSetup(state,leg,cfg,o.tf,at,price,origin,price+d*risk*2);
  if(delayed){if(decision.mode!=='WAIT_DATA')errors.push(`delayed event reused old break at ${at}`);}
  else if(snap?.atr14){if(decision.mode==='WAIT_DATA')errors.push(`known ATR immediate route blocked ${at}: ${decision.reason}`);else positiveRoutes++;}
  if(decision.mode!=='WAIT_DATA'){
   const routed={...leg,isValidated:true,chochPoints:12,chochEvents:[event.type==='EVENT_BOS'?'BOS_5M':'CHoCH_5M']};
   routedLegs.push(routed);
   // Controlled future retracement fixture, NOT a historical replay fill:
   // retain the real CLI setup, real ATR history and real saved route decision.
   const probe=JSON.parse(JSON.stringify(state)),probeLeg=JSON.parse(JSON.stringify(routed));
   const nextAt=at+300000,mid=decision.recommendedOtePrice-d*.00001;
   const nextBar={tf:o.tf,openTimeMs:at,closeTimeMs:nextAt,availableAtMs:nextAt,open:mid+d*.00002,high:mid+.00004,low:mid-.00004,close:mid,closed:true};
   const q={bid:mid-.000005,ask:mid+.000005,timestampMs:nextAt,source:'modeled' as const};
   assert.equal(context.ingestExecutionContext(probe,context.buildExecutionObservation({ticker:'EURUSD',tf:o.tf,observedAtMs:nextAt,bar:nextBar,previousClosedBar:o.bar,quote:q}),nextAt).accepted,true);
   probe.scoreBuy.events=[];probe.scoreSell.events=[];
   const result=alpha.evaluateImpulseCore(probeLeg,mid,nextBar.high,nextBar.low,'EURUSD',probe,nextAt,{config:cfg,currentSession:'NY'});
   assert.equal(result.triggerOte,true,'real exported setup + real routed decision must execute on a controlled subsequent closed-only retracement');
   assert.equal(result.newTrade.entryPrice,direction==='BUY'?q.ask:q.bid);controlledAlphaFills++;
  }
  report.push({at,direction,delayed,impulse:o.impulse,breakBar:o.breakBar,atr14:snap?.atr14,decision});
 }
 for(const f of o.fvgs??[]){
  fvgs++;
  const source=fvgAt.get(at)!.find(x=>x.id===f.id);assert.ok(source);
  assert.equal(source.direction==='Bullish'?'BUY':'SELL',o.impulse!.direction);
  if(source.timestamp+300000!==o.impulse!.createdAtMs||f.createdAtMs!==source.timestamp+300000)errors.push(`unproved FVG displacement linkage ${f.id} at ${at}`);
  assert.ok(f.availableAtMs<=at&&f.createdAtMs<=f.availableAtMs);
 }
 // Whole Alpha caller with a real exported closed-only snapshot and saved routing decision.
 // Quotes are explicitly research modeled; do not infer executable touches from historical ranges.
 if(/^PING_PRICE /.test(decoded.text)&&o.bar){
  const snap=context.getExecutionSnapshot(state,o.tf,at);if(!snap?.atr14)continue;
  state.executionContext.quote={bid:o.bar.close-.00005,ask:o.bar.close+.00005,timestampMs:at,source:'modeled'};
  for(let i=routedLegs.length-1;i>=0;i--){
   state.scoreBuy.events=[];state.scoreSell.events=[];
   const leg=routedLegs[i],q=state.executionContext.quote;
   const result=alpha.evaluateImpulseCore(leg,o.bar.close,o.bar.high,o.bar.low,'EURUSD',state,at,{config:cfg,currentSession:'NY'});
   if(result.triggerOte){actualAlphaFills++;assert.equal(result.newTrade.entryPrice,leg.dir==='BUY'?q.ask:q.bid);}
   if(!result.updatedLeg||result.triggerOte)routedLegs.splice(i,1);
  }
  for(const direction of ['BUY','SELL']){
   const d=direction==='BUY'?1:-1,price=o.bar.close,range=.01;
   const origin=direction==='BUY'?o.bar.low-.005:o.bar.high+.005,extreme=origin+d*range;
   const entry=price+d*.00005;
   const saved={mode:'OTE_STANDARD',takeDirectNow:false,recommendedOtePrice:entry,recommendedOtePercent:62,effectiveOtePercent:62,requiresCloseConfirmation:false,reason:'frozen_test_decision'};
   const makeLeg=()=>({dir:direction,origin,extreme,createdAt:at,isValidated:true,chochPoints:12,chochEvents:['CHoCH_5M'],executionDecision:saved,executionDecisionAtMs:at,executionSnapshot:snap});
   const q={bid:direction==='BUY'?price-.00001:entry,ask:direction==='BUY'?entry:price+.00001,timestampMs:at,source:'modeled' as const};
   // Preserve valid bid<=ask for both directions.
   state.executionContext.quote=q;
   state.scoreBuy.events=[];state.scoreSell.events=[];
   const run=()=>alpha.evaluateImpulseCore(makeLeg(),price,9,.01,'EURUSD',state,at,{config:cfg,currentSession:'NY'});
   const result=run();
   if(result.triggerOte){
    if(direction==='BUY')positiveAlphaBuy++;else positiveAlphaSell++;
    assert.equal(result.newTrade.entryPrice,direction==='BUY'?q.ask:q.bid);
    state.executionContext.quote=direction==='BUY'?{...q,bid:entry+.001,ask:entry+.0011}:{...q,bid:entry-.0011,ask:entry-.001};
    assert.equal(run().triggerOte,undefined,'historical range must never fill away from executable quote');
   }
  }
 }
}
fs.writeFileSync(path.join(tmp,'report.json'),JSON.stringify({structuralCount,delayedCount,positiveRoutes,actualAlphaFills,controlledAlphaFills,positiveAlphaBuy,positiveAlphaSell,fvgs,errors,events:report},null,2));
console.log(JSON.stringify({tmp,structuralCount,delayedCount,positiveRoutes,actualAlphaFills,controlledAlphaFills,positiveAlphaBuy,positiveAlphaSell,fvgs,errors},null,2));
assert.equal(structuralCount,13);assert.ok(delayedCount>0);assert.ok(positiveAlphaBuy>0&&positiveAlphaSell>0);
assert.deepEqual(errors,[],'actual CLI producer -> ingestion -> actual routing caller must agree on canonical setup and causal vintage');
assert.ok(positiveRoutes>0,'known closed ATR immediate events must reach a positive real route');
assert.ok(controlledAlphaFills>0,'actual exported setups must pass real routing and then Alpha on explicit controlled retracement fixtures');
console.log('PASS 1200-bar actual isolated CLI + actual ingest/route + whole Alpha closed-only executable BUY/SELL; legacy rows unchanged');
