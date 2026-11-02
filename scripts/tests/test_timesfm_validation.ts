import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync('src/engine/TimesfmFilter.ts','utf8');
let payload:any; let requests=0;
const now=1792160100300;
const sandbox:any={exports:{},require:(id:string)=>{if(id==='fs'||id==='path')return {};throw Error(id);},Date:class extends Date{static now(){return now;}},AbortSignal:{timeout:()=>({})},fetch:async()=>{requests++;return {ok:true,json:async()=>payload};}};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
const api=sandbox.exports,cfg=api.resolveTimesfmConfig({enabled:true});
const valid={ts:now-300,horizon:2,point:[2,2],q10:[1.9,1.9],q50:[2,2],q90:[2.1,2.1],ticker:'eurusd',tf:15};
const args={ticker:'EURUSD',tfMinutes:15,signalDir:'SELL',currentPrice:1,atr14:1,smcPoints:2,cfg};
async function main(){
 payload=valid; const positive=await api.fetchLiveTimesfmDecision(args); assert.equal(positive.action,'REJECT'); assert.equal(positive.degraded,false);
 for(const [name,patch] of Object.entries({legacyComputedFuture:{computed_at:now+1},legacyComputedInvalid:{computed_at:NaN},future:{ts:now+1},missingTs:{ts:undefined},ticker:{ticker:'gbpusd'},tf:{tf:5},crossing:{q10:[3,3]},empty:{q10:[]},missing:{q10:undefined},nan:{q50:[NaN,2]},mismatch:{q90:[2.1]},horizon:{horizon:0},stale:{ts:now-cfg.maxForecastAgeMs-1}})){
 payload={...valid,...patch};const decision=await api.fetchLiveTimesfmDecision(args);assert.equal(decision.degraded,true,name);assert.equal(decision.action,'APPROVE',name);assert.equal(decision.riskMult,1,name);
 }
 // Older backtest records without live identity remain evaluable.
 const historical={...valid};delete (historical as any).ticker;delete (historical as any).tf;
 assert.equal(api.evaluateTimesfmFilter(historical,'SELL',1,1,2,cfg).action,'REJECT');
 payload={...valid,q10:[1e308,1e308],q50:[1e308,1e308],q90:[1e308,1e308]};
 assert.equal((await api.fetchLiveTimesfmDecision(args)).degraded,true,'finite inputs with overflowing derived median must degrade');
 assert.equal(requests,15); console.log('PASS TimesFM validation: positive, 13 corrupt/future/stale cases, derived overflow, historical compatibility; no real I/O');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
