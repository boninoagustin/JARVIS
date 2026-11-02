const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
// No service imports: load the actual pure TypeScript engines in a VM.
function load(file) {
  const source = fs.readFileSync(file, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} };
  vm.runInNewContext(code, { exports: m.exports, module: m, require: id => {
    assert(id.startsWith('.'), `unexpected import ${id}`);
    const p = path.resolve(path.dirname(file), id.replace(/\.js$/, '.ts'));
    assert(!p.includes('/db/'), 'network-bearing module is forbidden');
    return load(p);
  } }, { filename: file });
  return m.exports;
}
const { MarketStructureEngine } = load(path.resolve('src/engine/smc/modules/market_structure.ts'));
const candle = (timestamp, close) => ({ timestamp, open: 100, high: Math.max(100,close)+1, low: Math.min(100,close)-1, close, volume: 20 });
for (const direction of ['Bullish','Bearish']) {
  test(`confirmed ${direction} metadata use confirmation availability, preserve Pivot compatibility`, () => {
    const e = new MarketStructureEngine();
    e.currentTrend = direction === 'Bullish' ? 'Bearish' : 'Bullish';
    const p = { type: direction === 'Bullish' ? 'High' : 'Low', price: direction === 'Bullish' ? 101 : 99, timestamp: 1000, index: 0, isBroken: false };
    e.processCandle(candle(2000, direction === 'Bullish' ? 102 : 98), [], [], {});
    // Pivot is only discovered on a later candle; old break remains source-anchored.
    const events = e.processCandle(candle(5000, direction === 'Bullish' ? 103 : 97), p.type==='High'?[p]:[], p.type==='Low'?[p]:[], {}, 1, { availableAt: 6000 });
    assert.equal(events[0].timestamp, 2000);
    assert.equal(e.lastCHoCH, p);
    assert.equal(e.lastCHoCH.direction, undefined);
    assert.equal(e.lastCHoCHEvent?.direction, direction);
    assert.equal(e.lastCHoCHEvent?.observedAt, 6000);
    assert.equal(e.lastCHoCHEvent?.availableAt, 6000);
    assert.equal(e.lastCHoCHEvent?.confirmed, true);
    assert.equal(events[0].availableAt, 6000);
  });
}

for (const direction of ['Bullish','Bearish']) test(`experimental ${direction}: delayed reversal publishes causal confirmation`,()=>{
 const e=new MarketStructureEngine();e.currentTrend=direction==='Bullish'?'Bearish':'Bullish';
 const preset={signal_profile:'directional_atr_v1'};
 const p={type:direction==='Bullish'?'High':'Low',price:direction==='Bullish'?101:99,timestamp:1000,index:0,isBroken:false};
 e.processCandle(candle(1000,100),[],[],preset,1,{availableAt:1500});
 e.processCandle(candle(2000,direction==='Bullish'?102:98),[],[],preset,1,{availableAt:2500});
 const events=e.processCandle(candle(5000,direction==='Bullish'?103:97),p.type==='High'?[p]:[],p.type==='Low'?[p]:[],preset,1,{availableAt:6000});
 assert.equal(events[0].breakTimestamp,2000);assert.equal(e.lastCHoCH,p);assert.equal(e.lastCHoCHEvent.direction,direction);assert.equal(e.lastCHoCHEvent.observedAt,6000);assert.equal(events[0].confirmed,true);
});
test('rejected CHoCH gates do not publish a reversal',()=>{
 const e=new MarketStructureEngine();e.currentTrend='Bullish';const p={type:'Low',price:99,timestamp:1000,index:0,isBroken:false};
 assert.equal(e.processCandle(candle(2000,98),[],[p],{choch_require_bos_prior:true},1,{availableAt:3000}).length,0);
 assert.equal(e.lastCHoCHEvent,null);assert.equal(p.isBroken,false);
});
test('missing availability stays unknown, never replaced with source/pivot time',()=>{
 const e=new MarketStructureEngine();e.currentTrend='Bullish';e.processCandle(candle(2000,98),[],[{type:'Low',price:99,timestamp:1000,index:0,isBroken:false}],{});
 assert(Number.isNaN(e.lastCHoCHEvent.availableAt));
});
test('actual SMCEngine getState exposes independent metadata copy and unchanged Pivot',()=>{
 const file='src/engine/smc/SMCEngine.ts',source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);let method;
 function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(ast)==='getState')method=n;ts.forEachChild(n,visit);}visit(ast);
 const body=ts.transpileModule(`function getState()${method.body.getText(ast)};globalThis.get=getState`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const ctx={};vm.runInNewContext(body,ctx);const pivot={timestamp:1000,type:'Low'};const event={direction:'Bearish',confirmed:true,observedAt:6000,availableAt:6000};
 const engine={state:{},orderBlocks:{},imbalances:{},structure:{lastCHoCH:pivot,lastCHoCHEvent:event},liquidity:{},signalPolicy:{experimental:false}};
 const state=ctx.get.call(engine);assert.equal(state.lastCHoCH,pivot);assert.equal(state.lastCHoCHEvent.availableAt,6000);assert.notEqual(state.lastCHoCHEvent,event);
 state.lastCHoCHEvent.direction='Bullish';assert.equal(event.direction,'Bearish');
 assert.match(source,/: \{ zScore: zScoreForGates, sweepEscapeDir, crtValid: this.liquidity.hasActiveCRTPattern\(\), availableAt: candle.timestamp \+ this.periodMs \}/);
});
