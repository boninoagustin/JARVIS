import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=process.cwd();
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'research-export-validation-'));
const header='timestamp,open,high,low,close,volume\n';
const valid='1784059200000,100,101,99,100,10\n';
const invalid='1784059200000,100,99,101,100,10\n';
try {
 const policy=path.join(tmp,'policy.json');
 fs.writeFileSync(policy,JSON.stringify({profile:'rollover_triage_v1',freezeSignals:true}));
 for(const mode of ['rollover','shadow'] as const){
  const raw=path.join(tmp,mode+'-raw');fs.mkdirSync(raw);
  fs.writeFileSync(path.join(raw,'history_M5.csv'),header+invalid);
  const output=path.join(tmp,mode+'-output');
  const flags=mode==='rollover'?['--rollover-policy-file',policy]:['--ml-regime-shadow'];
  const run=spawnSync(path.join(root,'node_modules/.bin/tsx'),['scripts/export_smc_csv.ts','UNKNOWN','--input-dir',raw,'--output-dir',output,'--timeframes','M5','--quiet',...flags],{cwd:root,encoding:'utf8',timeout:60000});
  assert.notEqual(run.status,0,mode+': malformed research OHLC must reject, not emit raw/shadow rows');
  assert.match(run.stderr,/Invalid or duplicate OHLC/);
  assert.ok(!fs.existsSync(path.join(output,'export_manifest.json')));
  assert.ok(!fs.existsSync(path.join(output,'pine-logs-SMC Master_M5.csv')));
  assert.equal(fs.readFileSync(path.join(raw,'history_M5.csv'),'utf8'),header+invalid);
 }
 console.log('PASS research flags reject malformed output OHLC through actual CLI before dataset writes');
 for(const mode of ['rollover','shadow'] as const){
  const raw=path.join(tmp,mode+'-htf-raw');fs.mkdirSync(raw);
  fs.writeFileSync(path.join(raw,'history_M5.csv'),header+valid);
  fs.writeFileSync(path.join(raw,'history_H1.csv'),header+invalid);
  const output=path.join(tmp,mode+'-htf-output');
  const flags=mode==='rollover'?['--rollover-policy-file',policy]:['--ml-regime-shadow'];
  const run=spawnSync(path.join(root,'node_modules/.bin/tsx'),['scripts/export_smc_csv.ts','UNKNOWN','--input-dir',raw,'--output-dir',output,'--timeframes','M5','--quiet',...flags],{cwd:root,encoding:'utf8',timeout:60000});
  assert.notEqual(run.status,0,mode+': malformed research HTF context must reject');
  assert.match(run.stderr,/Invalid or unordered HTF OHLC/);
  assert.ok(!fs.existsSync(path.join(output,'export_manifest.json')));
  assert.ok(!fs.existsSync(path.join(output,'pine-logs-SMC Master_M5.csv')));
  assert.equal(fs.readFileSync(path.join(raw,'history_H1.csv'),'utf8'),header+invalid);
 }
 console.log('PASS research flags reject malformed HTF OHLC through actual CLI before dataset writes');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
