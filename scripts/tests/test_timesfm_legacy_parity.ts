import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
const now=1792160100300;let payload:any;let requests=0;
function load(file:string,imports:any={}){const sandbox:any={exports:{},require:(id:string)=>{if(id in imports)return imports[id];if(id==='fs'||id==='path')return {};throw Error('forbidden '+id);},Date:class extends Date{static now(){return now;}},AbortSignal:{timeout:()=>({})},fetch:async()=>{requests++;return {ok:true,json:async()=>payload};}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,sandbox);return sandbox.exports;}
const pre=load(process.env.TIMESFM_PRE_SOURCE??'/tmp/jarvis-final-implementation/timesfm/TimesfmFilter.PRE.ts'),post=load('src/engine/TimesfmFilter.ts'),wrapper=load('src/engine/TimesfmLiveCacheNode.ts',{'./TimesfmFilter.js':post});
async function main(){let count=0;
 for(const signalDir of ['BUY','SELL'])for(const median of [0.8,1,1.2])for(const width of [0.1,10])for(const score of [2,15,20])for(const config of [{},{dryRun:true},{counterMult:1,lowConvictionMult:1}]){
  payload={ts:now-300,horizon:2,point:[median,median],q10:[median-width/2,median-width/2],q50:[median,median],q90:[median+width/2,median+width/2]};
  const cfg=post.resolveTimesfmConfig({enabled:true,...config});const args={ticker:'EURUSD',tfMinutes:15,signalDir,currentPrice:1,atr14:1,smcPoints:score,cfg};
  const expected=JSON.stringify(await pre.fetchLiveTimesfmDecision(args));
  for(const mode of [undefined,'legacy_http','ram_shadow']){const actual=await wrapper.fetchLiveTimesfmDecision({...args,cfg:{...cfg,liveTransport:mode}});assert.equal(JSON.stringify(actual),expected,JSON.stringify({signalDir,median,width,score,config,mode}));count++;}
 }
 console.log(JSON.stringify({test:'TimesFM exact PRE decision parity',comparisons:count,transportCalls:requests,modes:['absent','legacy_http','ram_shadow'],boundaries:'offline transport/clock only; real PRE and POST functions'}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
