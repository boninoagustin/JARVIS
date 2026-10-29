import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseSmcExportArgs} from '../smc_export_context.js';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'execution-export-'));
try{
 assert.throws(()=>parseSmcExportArgs(['EURUSD','--execution-context'],root),/isolated|output-dir/i);
 const a=parseSmcExportArgs(['EURUSD','--execution-context','--output-dir',path.join(tmp,'new')],root);
 assert.equal(a.executionContext,true);assert.equal(a.profile,undefined,'execution context must not activate the SMC detector variant');
 assert.equal(parseSmcExportArgs(['EURUSD'],root).executionContext,undefined);
 assert.throws(()=>parseSmcExportArgs(['EURUSD','--execution-context','--execution-context','--output-dir',path.join(tmp,'other')],root),/duplicate/i);
 console.log('PASS EX1 export flag isolated, explicit, independent of SMC policy and default absent');
 const raw=path.join(tmp,'raw');fs.mkdirSync(raw);const preset=path.join(tmp,'preset.json');fs.writeFileSync(preset,'{}');
 let previous=1.1;const rows=['timestamp,open,high,low,close,volume'];
 for(let i=0;i<40;i++){const close=1.1+Math.sin(i/4)*.002;rows.push([Date.UTC(2026,0,1)+i*14400000,previous,Math.max(previous,close)+.0005,Math.min(previous,close)-.0005,close,100].join(','));previous=close;}
 fs.writeFileSync(path.join(raw,'history_H4.csv'),rows.join('\n')+'\n');
 const out=path.join(tmp,'actual');const proc=spawnSync(path.join(root,'node_modules/.bin/tsx'),['scripts/export_smc_csv.ts','EURUSD','--input-dir',raw,'--output-dir',out,'--preset-file',preset,'--execution-context','--quiet'],{cwd:root,encoding:'utf8'});
 assert.equal(proc.status,0,proc.stderr+proc.stdout);
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'export_manifest.json'),'utf8'));assert.equal(manifest.execution_context_version,1);
 const csv=fs.readFileSync(path.join(out,'pine-logs-SMC Master_H4.csv'),'utf8');
 const payloads=[...csv.matchAll(/EX1: ([A-Za-z0-9_-]+)/g)].map(m=>JSON.parse(Buffer.from(m[1],'base64url').toString('utf8')));
 assert.ok(payloads.length>=40);
 for(const payload of payloads){assert.equal(payload.schema,1);assert.equal(payload.tf,'240');assert.equal(payload.bar.closed,true);assert.ok(payload.bar.availableAtMs<=payload.observedAtMs);assert.ok(payload.bar.open>0);assert.equal(payload.tickActivity,undefined,'OHLC cannot manufacture broker tick flow');assert.equal(payload.quote,undefined,'export cannot manufacture Bid/Ask');}
 assert.deepEqual(fs.readdirSync(raw),['history_H4.csv']);
 const run=(args:string[])=>spawnSync(path.join(root,'node_modules/.bin/tsx'),['scripts/export_smc_csv.ts','EURUSD','--input-dir',raw,'--preset-file',preset,'--execution-context','--quiet',...args],{cwd:root,encoding:'utf8',timeout:60000});
 assert.notEqual(run(['--output-dir',out]).status,0,'EX1 refuses overwriting existing isolated output');
 assert.equal(fs.readFileSync(path.join(out,'pine-logs-SMC Master_H4.csv'),'utf8'),csv);
 const alias=path.join(tmp,'raw-alias');fs.symlinkSync(raw,alias,'dir');
 for(const args of [['--output-dir',alias],['--output-dir',path.join(tmp,'denied-manifest'),'--manifest-out',path.join(raw,'manifest.json')]]){
  const rejected=run(args);assert.notEqual(rejected.status,0,'EX1 must physically protect frozen input');
  assert.match(rejected.stderr,/frozen|input directory|raw/i);
  assert.deepEqual(fs.readdirSync(raw),['history_H4.csv']);
 }
 console.log('PASS actual isolated EX1 CSV/manifest contains closed source bars, no counterfeit ticks or quotes');
 console.log('PASS EX1 actual CLI rejects overwrite, output symlink into frozen input, and manifest inside frozen input');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
