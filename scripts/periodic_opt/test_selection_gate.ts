import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readSelectionConfig} from './selection_context.js';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'selection-gate-'));
try {
  const file=path.join(tmp,'base.json');
  const args={ticker:'EURUSD',backtestConfigFile:file};
  fs.writeFileSync(file,JSON.stringify({ticker:'EURUSD',mlGateEnabled:false,mlGate:{enabled:true,modelPath:'/missing'}}));
  assert.throws(()=>readSelectionConfig(args,{}),/permission/, 'ML permission must precede model IO');
  fs.writeFileSync(file,JSON.stringify({ticker:'EURUSD',mlGateEnabled:true,mlGate:{enabled:true,modelPath:path.join(tmp,'model.json'),trainedAt:200}}));
  fs.writeFileSync(path.join(tmp,'model.json'),JSON.stringify({metadata:{}}));
  assert.throws(()=>readSelectionConfig(args,{}),/metadata/);
  fs.writeFileSync(file,JSON.stringify({ticker:'EURUSD',mlGateEnabled:'true',mlGate:{enabled:false}}));
  assert.throws(()=>readSelectionConfig(args,{}),/permission/);
  console.log('PASS selection ML gate permission and unknown metadata fail closed');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
