import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';
import {SMCEngine} from '../../src/engine/smc/SMCEngine';import {buildRolloverFreezeContext} from '../../src/engine/RolloverRuntimeContext';
const pre=process.env.ROLLOVER_PRE_ROOT;assert.ok(pre,'actual dirty PRE required');
const {SMCEngine:PreEngine}=await import(path.join(pre,'src/engine/smc/SMCEngine.ts'));
const preset:any={name:'wiring-fixture',risk_level:3,asset_type:'forex',override_choch:true,require_displacement:false,require_fvg_after_ob:false,strict_breaker:false,strict_sweep:false,confirm_close:true,min_score:0,choch_require_sweep:false,choch_require_momentum:false,valid_bos_displacement:false};
function manager(file:string,Engine:any){
 const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),decl=ast.statements.find(ts.isClassDeclaration)!;
 const code=ts.transpileModule(decl.getText(ast)+'\nSMCManager;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const emitted:any[]=[];
 const Manager=vm.runInNewContext(code,{SMCEngine:Engine,buildRolloverFreezeContext,loadOptimizedPreset:()=>structuredClone(preset),structuredClone,console:{log(){},error:console.error},broadcastCandle:(...x:any[])=>emitted.push(['raw',...x]),broadcastState:(...x:any[])=>emitted.push(['state',...x]),broadcastEvent:(...x:any[])=>emitted.push(['event',...x])});
 const instance=new Manager();instance.addListener((...x:any[])=>emitted.push(['listener',...x]));return {instance,emitted};
}
const a=manager('src/engine/smc/SMCManager.ts',SMCEngine),b=manager(path.join(pre,'src/engine/smc/SMCManager.ts'),PreEngine);
const start=Date.parse('2026-07-13T10:00:00Z'),clock=Date.now;Date.now=()=>start;
try{
 for(let i=0;i<91;i++){
  const close=100+Math.sin(i*Math.PI/10)*5+i*.02;
  const candle={timestamp:start+i*300000,open:close-.1,high:close+.5,low:close-.5,close,volume:100+i%7};
  for(const m of [a,b])m.instance.processLiveCandles('EURUSD','M5',[candle]);
  assert.deepEqual(structuredClone(a.emitted),structuredClone(b.emitted),'actual default manager pipeline event/raw/state order matches PRE');
 }
 const count=a.emitted.filter(x=>x[0]==='event').length;assert.ok(count>0);console.log('PASS actual AST manager versus dirty PRE 90 closed bars, positive events='+count);
}finally{Date.now=clock;}
