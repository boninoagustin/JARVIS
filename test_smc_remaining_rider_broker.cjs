const ts=require('typescript'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const assert=require('node:assert/strict');const {test}=require('node:test');
// Any accidental real socket attempt is a test failure; the SDK is never connected.
for(const [mod,names] of [['node:net',['connect','createConnection']],['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']]])for(const name of names)require(mod)[name]=()=>{throw Error('REAL NETWORK FORBIDDEN');};
function extract(file,name){const src=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true);let found='';function v(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(ast).replace(/^export /,'');ts.forEachChild(n,v);}v(ast);return found;}
function compile(code,context){return vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);}
async function setup(side='BUY',mode='success'){
 const sdk=path.resolve('node_modules/ctrader-ts/dist/src');
 const {CTraderConnection}=await import(sdk+'/core/connection.js');
 const {CTraderAccount}=await import(sdk+'/modules/account.js');
 const {encodeMessage,decodeMessage}=await import(sdk+'/protocol/codec.js');
 const {PayloadType}=await import(sdk+'/protocol/enums.js');
 const con=new CTraderConnection({host:'OFFLINE.invalid',requestTimeoutMs:30});let position={positionId:123,positionStatus:1,swap:0,price:100,stopLoss:side==='BUY'?100.1:99.9,takeProfit:side==='BUY'?110:90,tradeData:{symbolId:1,volume:1000,tradeSide:side==='BUY'?1:2,openTimestamp:1000},trailingStopLoss:true,guaranteedStopLoss:false,stopLossTriggerMethod:1};let reads=0;const frames=[];
 con.socket={destroyed:false,write(frame){const msg=decodeMessage(frame.subarray(4));frames.push(msg);let type,payload;
  if(msg.payloadType===PayloadType.RECONCILE_REQ){reads++;type=PayloadType.RECONCILE_RES;let p={...position};if(reads>1&&mode==='changed-sl')p.stopLoss+=1;if(reads>1&&mode==='explicit-zero')p.takeProfit=0;if(reads>1&&mode==='wrong-identity')p.tradeData={...p.tradeData,openTimestamp:999};payload={ctidTraderAccountId:7,position:mode==='absent'?[]:[p]};}
  else if(msg.payloadType===PayloadType.AMEND_POSITION_SLTP_REQ){if(mode==='timeout')return;if(mode==='reject'||mode==='rate-limit'){type=PayloadType.OA_ERROR_RES;payload={ctidTraderAccountId:7,errorCode:mode==='reject'?'TRADING_BAD_STOPS':'REQUEST_FREQUENCY_EXCEEDED'};}else {if(mode!=='unchanged')delete position.takeProfit;type=PayloadType.EXECUTION_EVENT;payload={ctidTraderAccountId:7,executionType:4};}}
  else throw Error(`UNEXPECTED BROKER MUTATION ${msg.payloadType}`);
  setImmediate(()=>con.handleData(encodeMessage(type,payload,msg.clientMsgId)));},destroy(){this.destroyed=true;}};
 const account=new CTraderAccount(con,7);
 const auth=extract('src/engine/OrderSafety.ts','authorizedBrokerRequest');
 const helper=extract('src/services/ctrader.ts','removeTakeProfitForRider');
 const ctx={setTimeout,clearTimeout,Date,console:{warn:()=>{},error:()=>{},log:()=>{}},config:{CTRADER_ACCOUNT_ID:'7'},PayloadType,ctClient:{connection:con,getPositions:()=>account.reconcile(),getState:()=>account.reconcile()},isCTraderReady:()=>true,getSymbolInfo:async id=>{assert.equal(id,1);return {symbolId:1,digits:5};}};
 compile(`const brokerDispatchGuards=new WeakMap();${auth};${extract('src/services/ctrader.ts','formatStopLossPrice')};${extract('src/services/ctrader.ts','normalizePositionStopLoss')};${helper};globalThis.helper=typeof removeTakeProfitForRider==='function'?removeTakeProfitForRider:undefined;`,ctx);
 return {ctx,helper:ctx.helper,con,frames,expected:{direction:side,entryPrice:100,minimumSl:side==='BUY'?100.05:99.95},get position(){return position;}};
}
for(const side of ['BUY','SELL'])test(`${side}: remove broker TP via omitted protobuf field; preserve exact SL and flags; readback`,async()=>{
 const s=await setup(side);assert.equal(typeof s.helper,'function','safe RIDER broker helper missing');const result=await s.helper('123',s.expected,true);assert(result);assert.equal(result.stopLoss,s.position.stopLoss);assert.equal(result.openedAtMs,1000);
 const mutations=s.frames.filter(x=>x.payloadType===2110);assert.equal(mutations.length,1);const p=mutations[0].payload;assert.equal(Object.hasOwn(p,'takeProfit'),false);assert.equal(p.stopLoss,s.position.stopLoss);assert.equal(p.trailingStopLoss,true);assert.equal(p.stopLossTriggerMethod,1);assert.equal(s.frames.filter(x=>x.payloadType===2124).length,2);s.con.disconnect();
});
for(const mode of ['reject','rate-limit','timeout','unchanged','changed-sl','explicit-zero','wrong-identity','absent'])test(`broker ${mode}: no success or blind close/new order`,async()=>{
 const s=await setup('BUY',mode);assert.equal(typeof s.helper,'function','safe RIDER broker helper missing');assert.equal(await s.helper('123',s.expected,true),null);assert(s.frames.every(x=>[2110,2124].includes(x.payloadType)));assert(s.frames.filter(x=>x.payloadType===2110).length<=1);s.con.disconnect();
});
test('send-time policy revocation cannot remove TP',async()=>{
 const s=await setup();assert.equal(await s.helper('123',s.expected,true,()=>false),null);assert.equal(s.frames.filter(x=>x.payloadType===2110).length,0);s.con.disconnect();
});
test('read-only recovery confirms an already absent TP without mutation',async()=>{
 const s=await setup();delete s.position.takeProfit;assert(await s.helper('123',s.expected,false));assert.equal(s.frames.filter(x=>x.payloadType===2110).length,0);s.con.disconnect();
});
for(const side of ['BUY','SELL'])for(const mode of ['success','reject','unchanged','timeout'])test(`end-to-end ${side} ${mode}: actual consumer + state machine + SDK frames`,async()=>{
 const s=await setup(side,mode),ctx=s.ctx;let durable={},commits=[];
 const trade={tradeId:'R',ticker:'EURUSD',direction:side,timestamp:1000,entryPrice:100,slPrice:s.position.stopLoss,tp1Hit:true,tp2Price:side==='BUY'?110:90,ctraderPositionId:'123'};
 const policy={exports:{}};compile(ts.transpileModule(fs.readFileSync('src/engine/RiderState.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:policy.exports,module:policy});Object.assign(ctx,policy.exports);
 ctx.db={collection:()=>({doc:()=>({async update(fields){if(fields.riderTransition.phase==='PENDING'){assert.equal(s.frames.filter(x=>x.payloadType===2110).length,0);assert.equal(s.frames.filter(x=>x.payloadType===2124).length,1);}else {assert.equal(s.frames.filter(x=>x.payloadType===2110).length,1);assert.equal(s.frames.filter(x=>x.payloadType===2124).length,3);}commits.push(fields.riderTransition.phase);durable={...durable,...structuredClone(fields)};},async get(){return {exists:true,data:()=>structuredClone(durable)};}})})};
 Object.assign(ctx,{trade,tradeId:'R',ticker:'EURUSD',nowTrade:3000,mgmtSlModeT:'breakeven',isBacktest:false,rolloverBroker:{removeTakeProfitForRider:s.helper,normalizePositionStopLoss:ctx.normalizePositionStopLoss},getConfigForTicker:()=>({riderEnabled:true,riderTf:'H4'}),getCurrentSession:()=> 'NY',breakevenBufferPrice:()=>s.expected.minimumSl});
 const file='src/db/trading.ts',source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);let caller;
 function v(n){if(ts.isIfStatement(n)&&n.expression.getText(ast)==='trade.tp1Hit && !trade.targetSlPending')caller=n.getText(ast);ts.forEachChild(n,v);}v(ast);assert(caller,'actual awaited consumer missing');
 compile(`const riderInFlight=new Set(),riderValidated=new WeakSet(),rolloverMutationInFlight=new Set();${extract(file,'persistRiderState')};${extract(file,'advanceRiderActivation')};${extract(file,'runNormalStopMutation')};globalThis.e2e=async()=>{let riderReady=false;${caller};return riderReady;};`,ctx);
 const active=await ctx.e2e();assert.equal(active,mode==='success');assert.equal(trade.managementMode,mode==='success'?'RIDER':undefined);assert.equal(trade.tp2Price===0,mode==='success');assert.deepEqual(commits,mode==='success'?['PENDING','ACTIVE']:['PENDING']);assert.equal(s.frames.filter(x=>x.payloadType===2110).length,1);s.con.disconnect();
});
test('recovery with TP present is read-only; malformed link fails closed',async()=>{
 const s=await setup();assert.equal(typeof s.helper,'function','safe RIDER broker helper missing');assert.equal(await s.helper('123',s.expected,false),null);assert.equal(await s.helper('',s.expected,true),null);assert.equal(s.frames.filter(x=>x.payloadType===2110).length,0);s.con.disconnect();
});
