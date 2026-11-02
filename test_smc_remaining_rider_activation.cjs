const ts=require('typescript'),fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');const {test}=require('node:test');
const src=fs.readFileSync('src/db/trading.ts','utf8'), ast=ts.createSourceFile('trading.ts',src,ts.ScriptTarget.Latest,true);
function fn(name){return ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)?.getText(ast).replace(/^export /,'')||'';}
function compile(code,ctx){vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);}
function setup({direction='BUY',mode='ok',config={riderEnabled:true,riderTf:'H4'},seed}={}){
 let durable=seed?structuredClone(seed):{},writes=0,mutations=0,reads=0,release; const record=[];
 const trade=seed?structuredClone(seed):{tradeId:'R1',ticker:'EURUSD',direction,timestamp:1000,entryPrice:100,slPrice:direction==='BUY'?100.1:99.9,tp1Hit:true,tp2Price:direction==='BUY'?110:90,ctraderPositionId:'123'};
 const doc={async update(fields){writes++;record.push('write:'+fields.riderTransition?.phase);if(mode===`reject-${writes}`)throw Error('persist rejected');if(mode===`delay-${writes}`)await new Promise(r=>release=r);durable={...durable,...structuredClone(fields)};},async get(){record.push('read');return {exists:true,data:()=>structuredClone(durable)};}};
 const ctx={console:{warn:()=>{},log:()=>{}},db:{collection:name=>{assert.equal(name,'active_trades');return {doc:id=>{assert.equal(id,'R1');return doc;}};}},setTimeout,clearTimeout};
 const pure={exports:{}};compile(fs.readFileSync('src/engine/RiderState.ts','utf8'),{exports:pure.exports,module:pure});Object.assign(ctx,pure.exports);
 // State-machine unit fixture; native rounding is exercised by rider_quantization.
 ctx.rolloverBroker={normalizePositionStopLoss:async(_id,sl)=>sl,removeTakeProfitForRider:async(id,expected,allow,guard)=>{reads++;record.push('broker:'+allow);if(allow){if(guard&&!guard())return null;mutations++;}return mode==='broker-fail'?null:{stopLoss:trade.slPrice,openedAtMs:1000};}};
 compile(`const riderInFlight=new Set();const riderValidated=new WeakSet();${fn('persistRiderState')};${fn('advanceRiderActivation')};globalThis.advance=typeof advanceRiderActivation==='function'?advanceRiderActivation:undefined;`,ctx);
 const policy=()=>ctx.resolveRiderPolicy?.(config,'NY',trade.mgmtOverrides);
 return {ctx,trade,config,record,run:()=>{assert.equal(typeof ctx.advance,'function','durable RIDER activation missing');return ctx.advance(trade,policy,'breakeven',direction==='BUY'?100.05:99.95,3000,false);},get durable(){return durable;},get writes(){return writes;},get mutations(){return mutations;},get reads(){return reads;},release:()=>release?.()};
}
for(const direction of ['BUY','SELL'])test(`${direction} activation requires durable intent then broker verification then durable ACTIVE before RAM`,async()=>{
 const s=setup({direction});assert.equal(await s.run(),true);assert.equal(s.trade.managementMode,'RIDER');assert.equal(s.trade.tp2Price,0);assert.equal(s.durable.managementMode,'RIDER');assert.equal(s.durable.riderTransition.phase,'ACTIVE');assert.equal(s.mutations,1);assert.deepEqual(s.record,['write:PENDING','read','broker:true','write:ACTIVE','read']);
});
for(const n of [1,2])test(`persist rejection ${n} never publishes RIDER; restart never repeats broker mutation`,async()=>{
 const s=setup({mode:`reject-${n}`});assert.equal(await s.run(),false);assert.equal(s.trade.managementMode,undefined);assert.notEqual(s.trade.tp2Price,0);assert.equal(s.mutations,n===1?0:1);
 if(n===2){const r=setup({seed:{...s.trade,...s.durable}});assert.equal(await r.run(),true);assert.equal(r.mutations,0);assert.equal(r.trade.managementMode,'RIDER');}
});
for(const n of [1,2])test(`persist delay ${n} keeps RAM inactive and disallows concurrent mutation`,async()=>{
 const s=setup({mode:`delay-${n}`});const p=s.run();await new Promise(r=>setImmediate(r));assert.equal(s.trade.managementMode,undefined);assert.notEqual(s.trade.tp2Price,0);assert.equal(s.mutations,n===1?0:1);assert.equal(await s.run(),false);s.release();assert.equal(await p,true);
});
test('broker rejection/readback ambiguity retains durable PENDING and manageable fixed target',async()=>{
 const s=setup({mode:'broker-fail'});assert.equal(await s.run(),false);assert.equal(s.durable.riderTransition.phase,'PENDING');assert.equal(s.trade.managementMode,undefined);assert.notEqual(s.trade.tp2Price,0);await s.run();assert.equal(s.mutations,1);
});
for(const config of [{},{riderEnabled:false},{riderEnabled:false,sessions:{NY:{riderEnabled:true}}},{riderEnabled:'true'},{riderEnabled:true,riderTf:'M5'},{riderEnabled:true,sessionEnabled:false},{riderEnabled:true,sessions:{NY:{riderEnabled:false}}}])test(`no opt-in: ${JSON.stringify(config)}`,async()=>{
 const s=setup({config});s.trade.mgmtOverrides={riderEnabled:true};assert.equal(await s.run(),false);assert.equal(s.mutations,0);assert.equal(s.writes,0);assert.equal(s.trade.managementMode,undefined);
});
test('session-only explicit opt-in works; frozen overrides do not independently opt in',async()=>{const s=setup({config:{sessions:{NY:{riderEnabled:true,riderTf:'D1'}}}});assert.equal(await s.run(),true);assert.equal(s.trade.riderTf,'D1');});
test('missing cTrader link, pending BE, no TP1, SCALP do not activate',async()=>{for(const patch of [{ctraderPositionId:''},{targetSlPending:true},{tp1Hit:false},{managementMode:'SCALP'}]){const s=setup();Object.assign(s.trade,patch);assert.equal(await s.run(),false);assert.equal(s.mutations,0);}});
test('policy revoked while durable intent delayed cannot dispatch TP removal',async()=>{const s=setup({mode:'delay-1'});const p=s.run();await new Promise(r=>setImmediate(r));s.config.riderEnabled=false;s.release();assert.equal(await p,false);assert.equal(s.mutations,0);});
test('ACTIVE restored after restart is readback-validated without broker amendment',async()=>{const s=setup();await s.run();const r=setup({seed:{...s.trade,...s.durable}});assert.equal(await r.run(),true);assert.equal(r.mutations,0);assert.equal(r.reads,1);});
test('replay RIDER stays active on later ticks without persistence or broker I/O',async()=>{
 const s=setup();assert.equal(typeof s.ctx.advance,'function');
 const policy=()=>s.ctx.resolveRiderPolicy(s.config,'NY');
 assert.equal(await s.ctx.advance(s.trade,policy,'breakeven',100.05,3000,true),true);
 assert.equal(await s.ctx.advance(s.trade,policy,'breakeven',100.05,4000,true),true);
 assert.equal(s.writes,0);assert.equal(s.reads,0);assert.equal(s.trade.tp2Price,0);
});
test('durable ACTIVE remains managed after current SL mode changes, without new amendment',async()=>{
 const s=setup();await s.run();const r=setup({seed:{...s.trade,...s.durable}});
 assert.equal(await r.ctx.advance(r.trade,()=>r.ctx.resolveRiderPolicy({riderEnabled:false},'NY'),'none',100.05,4000,false),true);
 assert.equal(r.mutations,0);assert.equal(r.reads,1);
});
test('production caller awaits transition under normal mutation lock after TP1 broker work, and legacy RAM-only activation removed',()=>{
 assert(!src.includes("trade.managementMode = 'RIDER'"),'RAM-only TP1 activation still exists');
 assert.match(src,/await runNormalStopMutation\(tradeId, trade, async \(\) => \{\s*riderReady = await advanceRiderActivation/);
});
