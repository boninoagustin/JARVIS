const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
function pure() {
 const f='src/engine/RiderState.ts'; if(!fs.existsSync(f)) return {};
 const m={exports:{}}; vm.runInNewContext(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports}); return m.exports;
}
const source=fs.readFileSync('src/db/trading.ts','utf8');
const ast=ts.createSourceFile('trading.ts',source,ts.ScriptTarget.Latest,true);
let block; function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(ast)==="trade.managementMode === 'RIDER'")block=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert(block,'actual RIDER exit consumer exists');
async function execute(direction,event,tf='H4',link='123') {
 let closed=0, accounted=0;const asked=[];
 const trade={direction,tradeId:'T',ticker:'EURUSD',timestamp:1000,managementMode:'RIDER',riderTf:tf,ctraderPositionId:link};
 const body=block.replace("await import('../services/ctrader.js')",'await broker()');
 const fn=vm.runInNewContext(ts.transpileModule(`(async()=>{for(const ignored of [0]){${body}}})`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
   ...pure(), riderReady:true, trade, ticker:'EURUSD',tradeId:'T', nowTrade:3000,tradeAgeMs:2000,isBacktest:false,
   store:{smcManager:{getEngine:(ticker,period)=>{asked.push(period);return {getState:()=>({lastCHoCH:{timestamp:100,type:'Low'},lastCHoCHEvent:event,currentTrend:'Bearish'})};}}},
   isDuplicate:()=>false, broker:async()=>({closePosition:async()=>{closed++;return true;}}),
   completeLiveTradeClose:async()=>{accounted++;return true;},sendTelegramAlert:async()=>{},console:{log:()=>{}}
 });await fn();return {closed,accounted,asked};
}
for(const direction of ['BUY','SELL']) {
 const inverse=direction==='BUY'?'Bearish':'Bullish';
 test(`${direction} exits only fresh confirmed requested-TF reversal`,async()=>{
  const x=await execute(direction,{direction:inverse,confirmed:true,observedAt:2000,availableAt:2000});
  assert.equal(x.closed,1);assert.equal(x.accounted,1);assert.deepEqual(x.asked,['H4']);
 });
 for(const at of [999,1000,3001]) test(`${direction} no exit event at ${at}`,async()=>{
  assert.equal((await execute(direction,{direction:inverse,confirmed:true,observedAt:at,availableAt:at})).closed,0);
 });
 test(`${direction} delayed confirmation after entry qualifies despite old source`,async()=>{
  assert.equal((await execute(direction,{direction:inverse,confirmed:true,observedAt:2000,availableAt:2000,breakTimestamp:500})).closed,1);
 });
 test(`${direction} trend/Pivot alone and unconfirmed or unavailable events cannot exit`,async()=>{
  for(const event of [undefined,{direction:inverse},{direction:inverse,confirmed:false,observedAt:2000,availableAt:2000},{direction:inverse,confirmed:true,observedAt:2000,availableAt:NaN},{direction:inverse,confirmed:true,observedAt:500,availableAt:2000},{direction:direction==='BUY'?'Bullish':'Bearish',confirmed:true,observedAt:2000,availableAt:2000}]) assert.equal((await execute(direction,event)).closed,0);
 });
 test(`${direction} missing broker link fails closed without accounting`,async()=>{
  const r=await execute(direction,{direction:inverse,confirmed:true,observedAt:2000,availableAt:2000},'H1',undefined);
  // Explicitly empty avoids the function default.
  const x=await execute(direction,{direction:inverse,confirmed:true,observedAt:2000,availableAt:2000},'H1','');
  assert.equal(x.closed,0);assert.equal(x.accounted,0);
 });
}
