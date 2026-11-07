import assert from 'node:assert/strict';
import { closedVerifiedSample, candidateEnabled } from './real_candidate_sample.js';
const now = Date.parse('2026-11-07T12:00:00Z');
const valid = {ticker:'EURUSD',ctraderPositionId:'1',ctraderStatus:'EXECUTED',riskAccountingStatus:'VERIFIED',result:'WIN',rMultiple:1,closedAt:new Date(now-1000).toISOString()};
const rows = [valid, {...valid}, ...[
 {isBacktest:true}, {duplicateOf:'x'}, {result:'SKIP'}, {riskAccountingStatus:'UNKNOWN'},
 {rMultiple:null}, {rMultiple:NaN}, {executionIncidentPending:true}, {closeAccountingPending:true},
 {ctraderStatus:'BLOCKED'}, {closedAt:'2020-01-01'}, {closedAt:new Date(now+1000).toISOString()},
 {ctraderPositionId:undefined}, {mode:'backtesting'}, {result:'LOSS',rMultiple:-1,ctraderPositionId:'2'},
].map((patch,i)=>({...valid,ctraderPositionId:String(i+10),...patch}))].map((x,i)=>({id:String(i),data:()=>x}));
assert.deepEqual(closedVerifiedSample(rows,now).get('EURUSD'),{n:2,wins:1});
assert.equal(candidateEnabled({enabled:true}),true);
assert.equal(candidateEnabled({enabled:true,disabledReason:'retirado'}),false);
assert.equal(candidateEnabled({}),false);
console.log('PASS verified closed-only sample, dedupe, time range, finite R, enabled policy');
