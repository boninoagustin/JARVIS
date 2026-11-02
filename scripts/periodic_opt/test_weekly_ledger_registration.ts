import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as rollout from './weekly_rollout.js';
assert.equal(typeof (rollout as any).registerLiveForecastLedger,'function','TimesFM rollout must register independent append-only future observations');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-ledger-registry-'));
try{
 const cache=path.join(root,'historical.jsonl');fs.writeFileSync(cache,JSON.stringify({ts:1,model_version:'unit-model'})+'\n');
 const report={final_config:{timesfm:{enabled:true,cachePath:cache}},final_asset_config:{timesfm:{enabled:true}},production_asset_snapshot:{timesfm:{enabled:true}}};
 const register=(rollout as any).registerLiveForecastLedger;
 const initial=register('EURUSD',report,root,1000);
 assert.equal(initial.prefix_size_bytes,0);assert.equal(initial.model_version,'unit-model');assert.equal(initial.registered_at_ms,1000);
 assert.equal(initial.prefix_sha256,createHash('sha256').update('').digest('hex'));
 const rows='explicit synthetic observation row\n';fs.appendFileSync(initial.path,rows);
 const later=register('EURUSD',report,root,2000);assert.equal(later.prefix_size_bytes,Buffer.byteLength(rows));
 assert.equal(fs.readFileSync(initial.path,'utf8'),rows,'registration never replaces previous observations');
 assert.equal(register('EURUSD',{final_asset_config:{},production_asset_snapshot:{}},root,3000),null,'disabled TimesFM needs no recorder');
 assert.throws(()=>register('../secret',report,root,4000),/ticker/);
 console.log('PASS: independent ledger registration, pinned model, append-only prefixes, no legacy metadata relabelling');
}finally{fs.rmSync(root,{recursive:true,force:true});}
