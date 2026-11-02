import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configFingerprint} from '../hyperopt/evaluation_protocol.js';
import {resolveEvaluation} from './eval_production.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-context-synthetic-'));
const manifest = {version:1, ticker:'EURUSD', from_ms:100, train_end_ms:200, validation_end_ms:300, test_end_ms:300, test_independence:'unverified'};
const input:any = {ticker:'EURUSD', minBuyPoints:7, minSellPoints:8, oteEntryPercent:50, entryTrigger:'SMART'};
const calls:any[] = [];
const worker:any = {async call(method:string, params:any) {
  calls.push({method, params});
  const provenance:any = {evaluation_manifest:manifest, dataset_files:[], model_files:[], cache_files:[], manifest_files:typeof params.evaluation_manifest === 'string' ? [{path:params.evaluation_manifest, sha256:'fixture-only'}] : []};
  if (method === 'init') return {evaluation_manifest:manifest, provenance, evaluation_fingerprint:configFingerprint(provenance)};
  assert.equal(method, 'evaluate_final');
  assert.equal(params.config.mlGate, undefined, 'do not inject mtime-derived ML gate');
  const effective = {...params.config, mlGate:{enabled:false}};
  const finalProvenance = {...provenance, manifest_files:[{path:path.join(tmp,'manifest.json'), sha256:'fixture-only'}], cache_files:[{path:'/fixture/cache', sha256:'fixture-only'}]};
  return {effective_config:effective, config_fingerprint:configFingerprint(effective), provenance:finalProvenance, evaluation_fingerprint:configFingerprint(finalProvenance), metrics_validation:{trade_count:0}, metrics_test:{trade_count:0}};
}};
try {
  const result = await resolveEvaluation(worker, {ticker:'EURUSD', config:input, logsDir:'/fixture/logs', manifestOut:path.join(tmp,'manifest.json')});
  assert.deepEqual(calls.map(c=>c.method), ['init', 'init', 'evaluate_final']);
  assert.equal(calls[1].params.evaluation_manifest, path.join(tmp,'manifest.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp,'manifest.json'),'utf8')), manifest);
  assert.deepEqual(result.config.mlGate, {enabled:false});
  assert.equal(result.config_fingerprint, configFingerprint(result.config));
  assert.equal(result.evaluation_fingerprint, configFingerprint(result.provenance));
  assert.notEqual(result.evaluation_fingerprint, configFingerprint(manifest));
  assert.equal(input.mlGate, undefined);
  await assert.rejects(()=>resolveEvaluation({async call(method:string) {if(method==='init') return {evaluation_manifest:manifest, provenance:{}, evaluation_fingerprint:'bad'}; return {};}} as any, {ticker:'EURUSD', config:input, logsDir:'/fixture/logs'}), /provenance/);
  console.log('PASS synthetic RPC contract: worker effective config, provenance hash, one frozen manifest; no network/backtest');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
