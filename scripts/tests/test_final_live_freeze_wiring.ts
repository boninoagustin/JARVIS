import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';

import {buildRolloverSignalContext} from '../../src/engine/RolloverRuntimeContext.js';
import {shouldFreezeRolloverObservation} from '../../src/engine/RolloverTriagePolicy.js';
const file='src/db/trading.ts',src=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true);
const stmt=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='evaluateImpulse')!;
const code=ts.transpileModule(stmt.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let routed=0;const cfg={executionPolicy:{profile:'microstructure_v1',smart:true},rolloverPolicy:{freezeSignals:true},fixedRR:2.5,oteEntryPercent:62,minPointsForBuy:6,minPointsForSell:6,slBufferPercent:0,entryTrigger:'SMART'};
// The real wrapper must return before invoking routing or the independently tested
// Alpha core. Do not import AlphaModel: its telemetry import initializes services.
const api=vm.runInNewContext(code+'\n({evaluateImpulse})',{console:{log(){}},globalState:{},getConfigForTicker:()=>cfg,resolveExecutionPolicy:(p:any)=>p,getLiveExecutionInstrument:()=>undefined,getCurrentSession:()=> 'NY',getExecutionSnapshot:()=>undefined,calculateDynamicSlBuffer:()=>.001,routeExecutionSetup:()=>{routed++;},evaluateImpulseCore:()=>{throw new Error('frozen wrapper invoked core');},buildRolloverSignalContext,shouldFreezeRolloverObservation});
const leg={dir:'BUY',origin:1.08,extreme:1.12,createdAt:Date.parse('2026-07-13T20:00:00Z'),chochEvents:['CHoCH_15M']};const state={lastPrice:1.1,zones:[],marketBias:{},scoreBuy:{events:[]},scoreSell:{events:[]}};
const before=JSON.stringify(leg);let result:any;try{result=api.evaluateImpulse(leg,1.1,1.101,1.099,undefined,undefined,'EURUSD',state,Date.parse('2026-07-13T21:20:00Z'));}catch{/* assertions below identify the missing pre-routing freeze */}
assert.equal(routed,0,'freeze must hold BEFORE SMART routing mutates a leg');assert.equal(result.updatedLeg,leg);assert.equal(result.triggerOte,false);assert.equal(JSON.stringify(leg),before);
console.log('FINAL_LIVE_FREEZE_WIRING: PASS');
