// Offline integration: real Python Recorder bytes into the real TS consumer.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {evaluateFollowup} from './weekly_followup.js';
import {RpcWorker} from './eval_production.js';
const dir=mkdtempSync(path.join(tmpdir(),'recorder-consumer-'));
const start=Date.parse('2026-07-14T15:00:00Z');
try {
 const fixture=JSON.parse(execFileSync('python3',['-c',`
import sys, json, io, hashlib
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'scripts/periodic_opt'))
from timesfm_followup_recorder import Recorder
root=Path(sys.argv[1]); now=int(sys.argv[2]); initial=now
reports=root/'reports'; (reports/'rollouts').mkdir(parents=True)
ledger=root/'logs/usdjpy/forecasts/live_followup_ledger.jsonl'
registration=dict(path=str(ledger),model_version='integration-v2',registered_at_ms=now,
                  prefix_sha256=hashlib.sha256(b'').hexdigest(),prefix_size_bytes=0)
(reports/'rollouts/test.json').write_text(json.dumps(dict(ticker='USDJPY',beforeAsset=dict(timesfm=dict(enabled=True)),live_forecast_ledger=registration)))
# Preserve Python float forms in actual HTTP envelopes, including exponent boundaries
# and a large integer whose JS Number is rounded. No ledger rows are hand-built.
numbers=[149.0, 1e-7, 1e-6, 1e20, 1e21, -0.0, 5e-324, 1.7976931348623157e308, 9007199254740993]
def envelope(tf):
 ts=initial-initial%(tf*60000)-tf*60000
 return dict(ticker='usdjpy',tf=tf,schema_version=2,timestamp_convention='context_close_ms_v2',
 ts=ts,contextCloseTimeMs=ts,computedAt=initial-20,availableAt=initial-10,
 model_version='integration-v2',horizon=len(numbers),point=numbers,q10=numbers,q50=numbers,q90=numbers,
 extra={'astral':'🧭','é':'sí','controls':'\\n\\t','nested':[False,None,{'2':-0.0,'10':1e-8}], '🧭':True, '\\ue000':False})
def opener(url, timeout):
 from urllib.parse import parse_qs,urlsplit
 return io.BytesIO(json.dumps(envelope(int(parse_qs(urlsplit(url).query)['tf'][0]))).encode())
recorder=Recorder(reports,root/'logs',opener=opener,clock=lambda:now)
for offset in (0,15000,30000):
 now=initial+offset
 result=recorder.run_once()
 assert not result['errors'], result
print(json.dumps(dict(registration=registration,envelopes={str(tf):envelope(tf) for tf in (5,15)},initial=initial)))
`,dir,String(start)],{encoding:'utf8'}));
 const ledger=fixture.registration.path;
 const original=readFileSync(ledger);
 const rows=original.toString().trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(rows.filter(r=>r.tf===5).map(r=>r.kind),['unavailable','forecast','heartbeat','heartbeat']);
 for(const tf of [5,15]){
  const row=rows.find(r=>r.tf===tf&&r.kind==='forecast');
  assert.deepEqual(row.forecast,fixture.envelopes[String(tf)],'raw native envelope, not reconstructed availability');
  assert.equal(row.observedAt,start);
 }
 const ping=(t:number)=>`PING_PRICE | TF: 5 | Precio: 149 | High: 149.1 | Low: 148.9 | TS: ${t}`;
 writeFileSync(path.join(dir,'M5.csv'),[ping(start-300000),ping(start),ping(start+300000)].join('\n'));
 const worker=new RpcWorker();let init:any;
 try{init=await worker.call('init',{ticker:'USDJPY',log_dir:dir});}finally{worker.close();}
 const asset={mlGateEnabled:false,timesfm:{enabled:true,cachePath:path.join(dir,'must-not-exist.jsonl')}};
 const input={ticker:'USDJPY',appliedAt:start,priorEvaluatedEndMs:start,beforeAsset:asset,appliedAsset:asset,
  logsDir:dir,outputDir:path.join(dir,'evidence'),worker:{call:async()=>init},expectedSourceFiles:init.provenance.source_files,
  expectedLiveLedger:fixture.registration,minIntervalMs:1,warmupDays:0,minContextObservations:{'5':1}};
 const result=await evaluateFollowup(input);
 assert.equal(result.reason,'insufficient_trades',`actual Recorder stream must pass native forecast and heartbeat fingerprints: ${result.reason}`);
 assert.ok(result.before&&result.applied,'both actual engine replays consumed the stream');
 assert.equal(result.window.from_ms,start);
 assert.equal(result.window.to_ms,start+30001,'observation timestamps bound availability; no fabricated future coverage');
 assert.deepEqual(readFileSync(ledger),original,'consumer never rewrites raw observations');
 // Keep strict checks: tampered fingerprints, model identities and registered bytes fail.
 for(const field of ['forecastFingerprint','model_version','forecastFingerprintVersion','heartbeat','futureAvailability','number']){
  const changed=structuredClone(rows),row=changed.find(r=>r.kind==='forecast');
  if(field==='forecastFingerprint')row.forecastFingerprint='0'.repeat(64);
  else if(field==='model_version')row.forecast.model_version='wrong';
  else if(field==='forecastFingerprintVersion')row.forecastFingerprintVersion='unknown';
  else if(field==='heartbeat')changed.find(r=>r.kind==='heartbeat').forecastFingerprint='0'.repeat(64);
  else if(field==='futureAvailability')row.forecast.availableAt=row.observedAt+1;
  else row.forecast.point[0]=150;
  writeFileSync(ledger,changed.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const rejected=await evaluateFollowup(input);
  assert.equal(rejected.decision,'PENDING');assert.match(rejected.reason,/fingerprint|model|disponibilidad/);
 }
 writeFileSync(ledger,original);
 const registered=await evaluateFollowup({...input,expectedLiveLedger:{...fixture.registration,prefix_size_bytes:1,prefix_sha256:'0'.repeat(64)}});
 assert.match(registered.reason,/prefix/);
 console.log('PASS actual Recorder → actual consumer: integral/exponent/negative-zero/subnormal/large numeric values, heartbeats, strict identity and honest availability');
} finally {rmSync(dir,{recursive:true,force:true});}
