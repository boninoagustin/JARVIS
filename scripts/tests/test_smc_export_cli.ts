import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';
const ROOT=path.resolve(import.meta.dirname,'../..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'smc-export-cli-'));
const ticker='SMCEXPORTFIXTURE';assert.equal(fs.existsSync(path.join(ROOT,'logs',ticker.toLowerCase())),false);
const source=path.join(tmp,'raw');fs.mkdirSync(source);
const B=1700000000000;
for(const [tf,dt,start] of [['M5',300000,B],['H1',3600000,B-100*3600000]] as const){
 const rows=['timestamp,open,high,low,close,volume'];
 for(let i=0;i<80;i++){const p=100+Math.sin(i/4)*.1;rows.push([start+i*dt,p,p+.1,p-.1,p+.02,100+i].join(','));}
 fs.writeFileSync(path.join(source,`history_${tf}.csv`),rows.join('\n')+'\n');
}
const preset=path.join(tmp,'preset.json');fs.writeFileSync(preset,JSON.stringify({Detection:{pivot_len:3,fvg_min_atr:.1}}));
function run(extra:string[],input=source){return spawnSync(path.join(ROOT,'node_modules/.bin/tsx'),[path.join(ROOT,'scripts/export_smc_csv.ts'),ticker,'--input-dir',input,'--preset-file',preset,'--timeframes','M5','--quiet',...extra],{cwd:ROOT,encoding:'utf8',timeout:60000});}
try{
 const legacyOut=path.join(tmp,'legacy');const r=run(['--output-dir',legacyOut,'--profile','legacy_v1']);
 assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
 const lm=JSON.parse(fs.readFileSync(path.join(legacyOut,'export_manifest.json'),'utf8'));
 assert.equal(lm.kind,'smc_signal_export_v1');assert.equal(lm.profile,'legacy_v1');assert.equal(lm.apply_eligible,false);
 assert.equal(lm.exports[0].candles,80);assert.equal(lm.exports[0].policy.experimental,false);
 assert.ok(fs.readFileSync(lm.exports[0].path,'utf8').includes('Z-Up: 0 | Z-Dn: 0'));
 const before=fs.readFileSync(lm.exports[0].path,'utf8');
 assert.notEqual(run(['--output-dir',legacyOut,'--profile','legacy_v1']).status,0,'refuse overwrite');
 assert.equal(fs.readFileSync(lm.exports[0].path,'utf8'),before);
 const bad=run(['--profile','directional_atr_v1']);assert.notEqual(bad.status,0);assert.match(bad.stderr,/output-dir/);
 const out=path.join(tmp,'experimental');const good=run(['--output-dir',out,'--profile','directional_atr_v1']);
 assert.equal(good.status,0,good.stderr+'\n'+good.stdout);
 const m=JSON.parse(fs.readFileSync(path.join(out,'export_manifest.json'),'utf8'));
 assert.equal(m.profile,'directional_atr_v1');assert.equal(m.exports[0].policy.impulse.window,50);
 assert.equal(m.exports[0].effectivePreset.fvg_min_atr_factor,.1);assert.equal(m.changes_production,false);
 assert.equal(m.ml_channels,'unchanged_legacy');assert.ok(m.sources['src/engine/smc/SMCEngine.ts']);
 const broken=path.join(tmp,'malformed');fs.mkdirSync(broken);
 fs.copyFileSync(path.join(source,'history_H1.csv'),path.join(broken,'history_H1.csv'));
 fs.writeFileSync(path.join(broken,'history_M5.csv'),'timestamp,open,high,low,close,volume\n1700000000000,100,99,98,100,1\n');
 const rejected=run(['--output-dir',path.join(tmp,'bad-output'),'--profile','directional_atr_v1'],broken);
 assert.notEqual(rejected.status,0,'malformed OHLC must fail, not emit fake zero-signal dataset');
 assert.match(rejected.stderr,/candle|OHLC/i);
 fs.copyFileSync(path.join(source,'history_M5.csv'),path.join(broken,'history_M5.csv'));
 fs.writeFileSync(path.join(broken,'history_H1.csv'),'timestamp,open,high,low,close,volume\n1700000000000,100,99,98,100,1\n');
 const rejectedHtf=run(['--output-dir',path.join(tmp,'bad-htf-output'),'--profile','directional_atr_v1'],broken);
 assert.notEqual(rejectedHtf.status,0,'malformed HTF must not certify valid causal context');
 assert.match(rejectedHtf.stderr,/candle|OHLC/i);
 const escapes:{label:string,status:number|null,unchanged:boolean,error:string}[]=[];
 for(const label of ['symlink-output','manifest-inside-raw']){
  const raw=path.join(tmp,label+'-raw');fs.mkdirSync(raw);
  for(const file of ['history_M5.csv','history_H1.csv'])fs.copyFileSync(path.join(source,file),path.join(raw,file));
  const inventory=fs.readdirSync(raw).sort();
  let target=path.join(tmp,label+'-out');
  if(label==='symlink-output')fs.symlinkSync(raw,target,'dir');
  const flags=['--output-dir',target,'--profile','directional_atr_v1'];
  if(label==='manifest-inside-raw')flags.push('--manifest-out',path.join(raw,'review-manifest.json'));
  const denied=run(flags,raw);
  escapes.push({label,status:denied.status,unchanged:JSON.stringify(fs.readdirSync(raw).sort())===JSON.stringify(inventory),error:denied.stderr});
 }
 for(const e of escapes){assert.notEqual(e.status,0,`${e.label}: must refuse frozen-input mutation`);assert.equal(e.unchanged,true,e.label);assert.match(e.error,/frozen|input directory|raw/i);}
 console.log('PASS actual CLI protects raw inputs against output symlinks and manifest destinations');
 console.log('Actual isolated SMC exporter CLI passed (legacy, experiment, overwrite, missing isolation)');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
