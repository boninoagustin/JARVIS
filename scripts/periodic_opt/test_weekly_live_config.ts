// Runs the ACTUAL Firestore config-listener callback without starting the bot or broker.
// Uses existing candidate artifacts only to verify field transport, never profitability.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {AssetSessionConfigSchema} from '../../src/engine/Types.js';
const filename='src/db/trading.ts';const text=fs.readFileSync(filename,'utf8');
const ast=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true);
let callback:ts.Node|undefined;
function visit(node:ts.Node){
 if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='onSnapshot'&&node.expression.expression.getText(ast)==="db.collection('asset_configs')") callback=node.arguments[0];
 ts.forEachChild(node,visit);
}
visit(ast);assert.ok(callback,'live asset-config listener must exist');
const script=ts.transpileModule(`const consume=${callback.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
for(const ticker of ['FRA40','NL25','USDJPY']){
 const report=JSON.parse(fs.readFileSync(`scripts/periodic_opt/reports/${ticker}.json`,'utf8'));
 const raw=report.final_asset_config;const globalState:any={assetSessionConfigs:new Map(),dynamicBotConfig:{entryTrigger:'SMART',minPointsForBuy:4,minPointsForSell:4}};
 const calls:any[]=[];
 const ctx=vm.createContext({globalState,AssetSessionConfigSchema,resolveExecutionPolicy:()=>{},configureExperimentalRuntime:()=>{},experimentalRuntimeRegistrations:new Map(),invalidConfigNotified:new Set(),sendTelegramAlert:async()=>{},setMLGateOverride:(t:string,v:any)=>calls.push(['ml',t,v]),syncCorrTickers:()=>{},syncScannerRoster:async(v:any)=>calls.push(['roster',v]),console:{log(){},error(){}}});
 vm.runInContext(script,ctx);(ctx as any).snap={forEach:(fn:any)=>fn({id:ticker,data:()=>raw})};vm.runInContext('consume(snap)',ctx);
 const live=globalState.assetSessionConfigs.get(ticker);assert.equal(live?.enabled,true);
 for(const key of ['minPointsForBuy','minPointsForSell','slBufferPercent','fixedRR','oteEntryPercent','sessions','minimal_roi','maxDailyLossR','maxConsecutiveLosses','maxTradesPerDay','trailingDrawdownR','timesfm','biasConfluence','zoneWeights','vwapPts','tp1StructuralMinRR']) {
  if(raw[key]!==undefined) assert.deepEqual(JSON.parse(JSON.stringify(live[key])),JSON.parse(JSON.stringify(raw[key])),`${ticker} ${key}: listener must consume the evaluated field`);
 }
 assert.ok(calls.some(c=>c[0]==='roster'&&c[1].includes(ticker)),'eligible asset remains in actual scanner roster');
}
console.log('PASS: real live listener consumes all optimized fields for FRA40/NL25/USDJPY, including sessions and management; no network/broker started');
