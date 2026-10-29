import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
let now=1792160100300, requests=0, active=0,maxActive=0;let payload:any;let fail=false;let pending:undefined|(()=>void);let hold=false;
const timers=new Map<number,{fn:()=>void,at:number}>();let seq=0;
const clock={now:()=>now,setTimeout:(fn:()=>void,ms:number)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:(id:number)=>timers.delete(id)};
let transportOptions:any;
const fetcher=async(_url?:string,options?:any)=>{transportOptions=options;requests++;active++;maxActive=Math.max(maxActive,active);try{if(hold)await new Promise<void>(r=>pending=r);if(fail)throw Error('offline');return {ok:true,json:async()=>payload};}finally{active--;}};
function load(path:string,imports:any={}){const sandbox:any={exports:{},require:(id:string)=>{if(id in imports)return imports[id];if(id==='fs'||id==='path')return new Proxy({},{get(){throw Error('disk access');}});throw Error('forbidden import '+id);},Date:class extends Date{static now(){return now;}},fetch:fetcher,AbortController,AbortSignal:{timeout:()=>({})},setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,console};if(fs.existsSync(path))vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,sandbox);return sandbox.exports;}
const filter=load('src/engine/TimesfmFilter.ts');
const api=load('src/engine/TimesfmLiveCacheNode.ts',{'./TimesfmFilter.js':filter});
const cfg=filter.resolveTimesfmConfig({enabled:true,liveTransport:'ram',liveMaxAttempts:4,liveRetryMs:100});
const args={ticker:'EURUSD',tfMinutes:15,signalDir:'SELL',currentPrice:1,atr14:1,smcPoints:2,cfg};
const target=1792160100000;
function forecast(ts=target,extra:any={}){return {ts,contextCloseTimeMs:ts,computedAt:ts+100,availableAt:ts+100,timestamp_convention:'context_close_ms_v2',schema_version:2,model_version:'timesfm-2.5-200m-pytorch@f1',ticker:'eurusd',tf:15,horizon:2,point:[2,2],q10:[1.9,1.9],q50:[2,2],q90:[2.1,2.1],...extra};}
async function settle(){for(let i=0;i<12;i++)await Promise.resolve();}
async function advance(ms:number){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await settle();}
async function main(){
 assert.equal(typeof api.readTimesfmRamDecision,'function','RAM API must exist');
 assert.equal(requests,0);assert.equal(timers.size,0,'no import side effects');
 assert.equal(api.readTimesfmRamDecision(args).degraded,true);assert.equal((await api.fetchLiveTimesfmDecision(args)).degraded,true);assert.equal(requests,0);assert.equal(timers.size,0,'miss cannot start I/O');
 payload=forecast(target-900000);api.configureTimesfmLiveCache({ticker:'EURUSD',tfMinutes:15,cfg},{...clock,fetch:fetcher});await settle();
 assert.equal(transportOptions.redirect,'error','bridge identity cannot silently follow redirects');
 assert.equal(requests,1);assert.equal(api.readTimesfmRamDecision(args).degraded,true,'old generation is not ready');assert.equal(timers.size,1);
 payload=forecast();await advance(100);assert.equal(requests,2);assert.equal(api.readTimesfmRamDecision(args).action,'REJECT');assert.equal(timers.size,0);
 const before=requests;for(let i=0;i<100;i++)assert.equal(api.readTimesfmRamDecision(args).riskMult,0);assert.equal(requests,before);
 assert.equal(api.readTimesfmRamDecision({...args,tfMinutes:5}).degraded,true);assert.equal(api.readTimesfmRamDecision({...args,ticker:'GBPUSD'}).degraded,true);assert.equal(api.readTimesfmRamDecision({...args,cfg:{...cfg,bridgeUrl:'http://other'}}).degraded,true);
 // Legacy and shadow use the actual legacy transport, including a valid rejection.
 payload=forecast();for(const mode of [undefined,'legacy_http','ram_shadow']){const r=await api.fetchLiveTimesfmDecision({...args,cfg:{...cfg,liveTransport:mode}});assert.equal(r.action,'REJECT');}
 api.resetTimesfmLiveCache();assert.equal(timers.size,0);
 // Validate strict envelopes before publication, preserving APPROVE 1 on every miss.
 for(const patch of [{ticker:'gbpusd'},{tf:5},{model_version:'other'},{schema_version:1},{timestamp_convention:undefined},{contextCloseTimeMs:target-1},{computedAt:now+1},{availableAt:now+1},{ts:target+1,contextCloseTimeMs:target+1},{q10:[3,3]},{q50:[]},{q90:[Infinity,Infinity]}]){
  payload=forecast(target,patch);api.configureTimesfmLiveCache({ticker:args.ticker,tfMinutes:15,cfg:{...cfg,liveMaxAttempts:1}},{...clock,fetch:fetcher});await settle();assert.equal(api.readTimesfmRamDecision(args).degraded,true,JSON.stringify(patch));api.resetTimesfmLiveCache();assert.equal(timers.size,0);
 }
 // One flight across repeated bar notifications; old target response does not publish.
 payload=forecast();hold=true;api.configureTimesfmLiveCache({ticker:args.ticker,tfMinutes:15,cfg},{...clock,fetch:fetcher});await settle();const count=requests;
 now+=900000;const next=target+900000;
 for(let i=0;i<4;i++)api.notifyTimesfmCandleClosed({ticker:'EURUSD',tfMinutes:15,contextCloseTimeMs:next});
 assert.equal(requests,count);hold=false;pending!();await settle();assert.equal(api.readTimesfmRamDecision(args).degraded,true,'late old generation not published');
 payload=forecast(next);await advance(100);assert.equal(api.readTimesfmRamDecision(args).action,'REJECT');assert.equal(maxActive,1);
 assert.equal(api.readTimesfmRamDecision(args,now-1).degraded,true,'local receipt controls as-of');
 const snapshot=api.readTimesfmRamDecision(args).forecast;assert.throws(()=>snapshot.q50.push(999));
 now+=cfg.maxForecastAgeMs+1;const n=requests;assert.equal(api.readTimesfmRamDecision(args).degraded,true);assert.equal(requests,n,'stale decision cannot fetch');
 api.resetTimesfmLiveCache();
 // Bounded failures, then explicit reconfigure recovery; reset invalidates delayed response.
 fail=true;const start=requests;api.configureTimesfmLiveCache({ticker:args.ticker,tfMinutes:15,cfg:{...cfg,liveMaxAttempts:2}},{...clock,fetch:fetcher});await settle();await advance(100);await advance(10000);assert.equal(requests-start,2);assert.equal(timers.size,0);fail=false;
 payload=forecast(filter.timesfmCandleKey(now,15));api.configureTimesfmLiveCache({ticker:args.ticker,tfMinutes:15,cfg},{...clock,fetch:fetcher});await settle();assert.equal(api.readTimesfmRamDecision(args).degraded,false);
 api.resetTimesfmLiveCache();hold=true;api.configureTimesfmLiveCache({ticker:args.ticker,tfMinutes:15,cfg},{...clock,fetch:fetcher});await settle();api.resetTimesfmLiveCache();hold=false;pending!();await settle();assert.equal(api.readTimesfmRamDecision(args).degraded,true);assert.equal(timers.size,0);
 assert.equal(api.configureTimesfmLiveCache({ticker:args.ticker,tfMinutes:15,cfg:{...cfg,liveMaxAttempts:NaN}},{...clock,fetch:fetcher}),false,'bad retry budget rejected');
 assert.equal(api.configureTimesfmLiveCache({ticker:args.ticker,tfMinutes:15,cfg:{...cfg,liveRetryMs:Infinity}},{...clock,fetch:fetcher}),false,'bad backoff rejected');
 assert.equal(api.configureTimesfmLiveCache({ticker:args.ticker,tfMinutes:15,cfg:{...cfg,latencyBudgetMs:NaN}},{...clock,fetch:fetcher}),false,'bad timeout rejected');
 assert.equal(timers.size,0);
 console.log('PASS TimesFM RAM: lifecycle, 12 strict corrupt envelopes, no import/miss/stale I/O, readiness/backoff, singleflight, late-generation rejection, as-of, immutable snapshot, failure recovery, legacy/shadow parity');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
