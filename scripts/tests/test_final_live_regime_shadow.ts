import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import './test_ml_native14.js'; // Memory-only declared fixture candidate; never trains/writes a model.
import {context} from './test_ml_regime.js';
import {predictRegime,regimeUnavailable,REGIME_FEATURE_SCHEMA,REGIME_VELOCITY_PROFILE} from '../../src/engine/MLRegimeFeatures.js';
const src=fs.readFileSync('src/db/trading.ts','utf8'),ast=ts.createSourceFile('trading.ts',src,ts.ScriptTarget.Latest,true);
const stmt=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='evaluateLiveRegimeShadow');assert.ok(stmt,'missing live opt-in regime shadow caller');
const code=ts.transpileModule(stmt!.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const sample=context();let quoteReads=0,failQuote=false;
const api=vm.runInNewContext(code+'\n({evaluateLiveRegimeShadow})',{predictRegime,regimeUnavailable,REGIME_FEATURE_SCHEMA,REGIME_VELOCITY_PROFILE,getLastBidAsk:()=>{quoteReads++;if(failQuote)throw new Error('quote unavailable');return{bid:1.1,ask:1.1002,ts:sample.nowMs-100};},tickFlow:{getTickVelocitySnapshot:()=>({zScore:-2,samples:100,baselineVarianceMs2:25,observedAtMs:sample.nowMs-100,availableAtMs:sample.nowMs-50,baselineHourUtc:13})}});
const state={mlRegimeObservations:sample},signal={direction:'BUY',tf:'15M',entryPrice:1.1,stopLoss:'1.098',points:0};const before=JSON.stringify({state,signal});
assert.equal(api.evaluateLiveRegimeShadow('EURUSD',state,signal,sample.nowMs,{mlRegimeShadow:false}),undefined);assert.equal(quoteReads,0,'default-off does not even read quote/velocity');
const predicted=api.evaluateLiveRegimeShadow('EURUSD',state,signal,sample.nowMs,{mlRegimeShadow:true});assert.equal(predicted.status,'PREDICTED');assert.equal(predicted.features.smc_score_excess,-6);
assert.equal(JSON.stringify({state,signal}),before,'shadow helper does not alter legacy state/signal');
const missing=api.evaluateLiveRegimeShadow('EURUSD',{},signal,sample.nowMs,{mlRegimeShadow:true});assert.equal(missing.status,'UNAVAILABLE');assert.equal('probability'in missing,false);
failQuote=true;assert.doesNotThrow(()=>assert.equal(api.evaluateLiveRegimeShadow('EURUSD',state,signal,sample.nowMs,{mlRegimeShadow:true}).status,'UNAVAILABLE'),'shadow telemetry fault must never become an entry veto');
assert.ok(src.includes('const mlRegimeShadow = evaluateLiveRegimeShadow('),'real dispatch must call the helper, not leave it unused');
console.log('FINAL_LIVE_REGIME_SHADOW: PASS');
