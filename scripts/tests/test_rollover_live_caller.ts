import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {runRolloverTriageExecution} from '../../src/engine/RolloverTriageExecutor.js';
import {registerRolloverSchedule} from '../../src/engine/RolloverSpreadGate.js';
import {validateExecutionInstrument} from '../../src/engine/ExecutionCosts.js';
const text=fs.readFileSync('src/db/trading.ts','utf8'),ast=ts.createSourceFile('trading.ts',text,ts.ScriptTarget.Latest,true);
const names=['runLiveRolloverTriage','persistLiveRolloverRecord','buildLiveRolloverContext','usesExperimentalRollover','rolloverTriageRecords'];
const selected=ast.statements.filter(n=>(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text??''))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>names.includes(d.name.getText(ast))))).map(n=>n.getText(ast)).join('\n');
registerRolloverSchedule('EURUSD',{scheduleTimeZone:'America/New_York',schedule:Array.from({length:5},(_,i)=>({startSecond:61205+i*86400,endSecond:145795+i*86400}))});
let now=Date.parse('2026-07-13T20:26:00Z'),bid=98,ask=98.1,sl=90,fail='',send=0,positionsAvailable=true;
const triage={maxExtraRiskR:.3,greenPeakMultiple:1.25,greenMinR:.85,structuralPeakMultiple:1.35,beMinDistancePeakMultiple:1.15,severeLossR:-.8,maxQuoteAgeMs:10000};
const fill={schema:1,ticker:'EURUSD',direction:'BUY',positionId:'42',positionKey:'42:123',openedAtMs:123,capturedAtMs:200,entryPrice:100,initialSlPrice:90,initialRiskPrice:10,policy:{profile:'rollover_triage_v1',triage,peakSpread:{price:8,availableAtMs:100}}};
let trade:any={tradeId:'T1',journalId:'JOURNAL',ticker:'EURUSD',direction:'BUY',ctraderPositionId:'42',slPrice:90,rolloverFill:fill,rolloverTriageDurable:true,rolloverTriageState:{pending:null,widenReference:null}};
const docs=new Map<string,any>([['active_trades/T1',structuredClone(trade)],['trade_journal/JOURNAL',structuredClone(trade)]]);
const snap=(k:string)=>({exists:docs.has(k),data:()=>structuredClone(docs.get(k))});const events:string[]=[];
const db={collection:(c:string)=>({doc:(id:string)=>({key:c+'/'+id,get:async()=>{if(fail==='read')throw Error('read');return snap(c+'/'+id);}})}),runTransaction:async(fn:any)=>{const pending:any[]=[];await fn({get:async(r:any)=>snap(r.key),update:(r:any,v:any)=>{if(fail===r.key)throw Error('durability');pending.push([r.key,v]);}});for(const[k,v]of pending){docs.set(k,{...docs.get(k),...structuredClone(v)});events.push('persist:'+v.rolloverTriagePhase);}}};
const row=()=>({positionId:42,price:100,stopLoss:sl,tradeData:{tradeSide:1,openTimestamp:123,volume:100}});
const globalState:any={activeTrades:new Map([['T1',trade]]),assetSessionConfigs:new Map(),radarStates:new Map(),smcManager:{getEngines:()=>new Map()}};
const instrument={ticker:'EURUSD',source:'broker_metadata',regime:'FOREX',pipSize:.1,tickSize:.1,pipValuePerLotUsd:1,baseSpreadPips:1,exitSlippagePips:0,commissionPerLotSideUsd:0,minStopDistance:.2};
const sandbox:any={exports:{},db,console:{log(){},error(){},warn(){}},Date:{now:()=>now},structuredClone,globalState,runRolloverTriageExecution,rolloverJournalRecoveryReady:true,rolloverDWideMap:new Map(),rolloverMutationInFlight:new Set(),validateExecutionInstrument,getLiveExecutionInstrument:()=>instrument,getRolloverSpreadReference:()=>({baseSpreadPrice:.1,pipSize:.1}),getRolloverQuote:()=>({bid,ask,bidTimestampMs:now,askTimestampMs:now}),tickFlow:{getSpreadSnapshot:()=>({bid,ask,ts:now,ageMs:0,samples:100,spread:ask-bid,baselineSpread:.1})},rolloverBroker:{getOpenPositions:async()=>positionsAvailable?[row()]:null,getDealsByPosition:async()=>[{dealStatus:2,positionId:42,tradeSide:1,filledVolume:100,executionTimestamp:123}],modifyStopLoss:async(_id:string,target:number,_px:any,authorize:any)=>{await Promise.resolve();if(!authorize(row()))return false;send++;events.push('send');sl=target;return true;},closePosition:async()=>{throw Error('unexpected close');}}};
const code=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const api=vm.runInNewContext(code+'\n({run:typeof runLiveRolloverTriage === "function"?runLiveRolloverTriage:undefined,records:typeof rolloverTriageRecords === "object"?rolloverTriageRecords:undefined})',sandbox);
assert.equal(typeof api.run,'function','real live executor adapter missing');
// Missing HTF is unavailable, not a permissive default.
let r=await api.run('T1',trade);assert.equal(r.status,'HOLD');assert.equal(send,0);
globalState.smcManager.getEngines=()=>new Map([['EURUSD:H1',{lastProcessedTs:now-3600000,getState:()=>({simpleTrend:'Bullish'}),getLastRolloverObservation:()=>({excluded:false,candle:{timestamp:now-3600000}})}]]);
fail='trade_journal/JOURNAL';r=await api.run('T1',trade);assert.equal(r.status,'UNCERTAIN');assert.equal(send,0);assert.equal(trade.rolloverTriageState.pending.status,'INTENT');
// Discard failed RAM and restart from independent durable docs.
fail='';trade=structuredClone(docs.get('active_trades/T1'));globalState.activeTrades.set('T1',trade);r=await api.run('T1',trade);assert.equal(r.status,'CONFIRMED');assert.equal(sl,87);assert.equal(send,1);assert.ok(events.indexOf('persist:INTENT')<events.indexOf('send'));
// Journal-only restart INTENT after a confirmed broker amend must reconcile without resend.
const intent=structuredClone(docs.get('trade_journal/JOURNAL'));intent.rolloverTriageState.pending.status='INTENT';intent.rolloverTriageState.widenReference=null;docs.set('active_trades/T1',structuredClone(intent));docs.set('trade_journal/JOURNAL',structuredClone(intent));trade=structuredClone(intent);globalState.activeTrades.set('T1',trade);r=await api.run('T1',trade);assert.equal(r.status,'RECONCILED');assert.equal(send,1);
now=Date.parse('2026-07-14T10:00:00Z');fail='active_trades/T1';r=await api.run('T1',trade);assert.equal(r.status,'UNCERTAIN');assert.ok(trade.rolloverTriageState.pending);fail='';r=await api.run('T1',trade);assert.equal(r.status,'CONFIRMED');assert.equal(sl,90);assert.equal(trade.rolloverTriageState.pending,null);assert.equal(trade.rolloverTriageState.widenReference.widenedSlPrice,87);
positionsAvailable=false;r=await api.run('T1',trade);assert.equal(r.status,'UNCERTAIN');assert.equal('pnl' in r,false);assert.equal('stats' in r,false);
console.log('ROLLOVER_LIVE_CALLER: PASS');
