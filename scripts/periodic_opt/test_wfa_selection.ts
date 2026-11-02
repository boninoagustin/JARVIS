import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as selection from './selection_context.js';
const api:any=selection;
assert.equal(typeof api.selectionReplayOptions,'function','selection replay CLI is not wired');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wfa-selection-'));
try {
 const file=path.join(dir,'replay.json');
 const m={version:1,ticker:'TEST',from_ms:100,train_end_ms:200,validation_end_ms:300,test_end_ms:300,test_independence:'unverified'};
 const replay={warmupStartMs:0,evaluationStartMs:100,evaluationEndMs:200,
  statePolicy:'context-only-reset-execution-v1',minContextObservations:{'5':1}};
 fs.writeFileSync(file,JSON.stringify(replay));
 const args=selection.parseSelectionArgs(['TEST','--evaluation-manifest','unused','--wfa-replay-window',file,'--dry-run']);
 assert.equal(args.wfaReplayFile,file);
 assert.deepEqual(api.selectionReplayOptions(args,m),replay);
 const entries=[{ts:0},{ts:99},{ts:100},{ts:199},{ts:200},{ts:250}];
 assert.deepEqual(selection.selectionEntries(entries,m,args).map(e=>e.ts),[0,99,100,199]);
 assert.deepEqual(selection.selectionEntries(entries,m).map(e=>e.ts),[100,199]);
 fs.writeFileSync(file,JSON.stringify({...replay,evaluationEndMs:300}));
 assert.throws(()=>api.selectionReplayOptions(args,m),/window|Train|train|bounds/);
 for(const relative of ['../per_trigger_tune.ts','../killswitch_tune.ts','../directional_mcl_tune.ts',
                        '../bias_confluence_tune.ts','loser_triggers_proposal.ts']){
  const text=fs.readFileSync(new URL(relative,import.meta.url),'utf8');
  assert.match(text,/selectionReplayOptions\(selection, manifest\)/,relative+' must forward shared phase options');
  assert.match(text,/undefined, prepared, replayOptions\)/,relative+' must pass phases to real engine');
 }
 console.log('WFA selection CLI/context tests passed');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
