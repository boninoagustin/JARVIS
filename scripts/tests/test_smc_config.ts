import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {loadOptimizedPreset,applySMCSignalOverrides} from '../../src/engine/smc/smc_config.ts';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'smc-config-test-'));
try{
 const file=path.join(tmp,'preset.json');fs.writeFileSync(file,JSON.stringify({Detection:{fvg_min_atr:.1,z_score_window:14}}));
 const legacy=loadOptimizedPreset('FIXTURE','M5','Forex - 3. Balanceado',{presetFile:file});
 assert.equal(legacy.fvg_min_atr,.1);assert.equal(legacy.fvg_min_atr_factor,undefined);assert.equal(legacy.signal_profile,undefined);
 const exp=loadOptimizedPreset('FIXTURE','M5','Forex - 3. Balanceado',{presetFile:file,signalOverrides:{signal_profile:'directional_atr_v1'}});
 assert.equal(exp.fvg_min_atr_factor,.1);assert.equal(exp.signal_profile,'directional_atr_v1');
 assert.equal(exp.signal_impulse,undefined,'old stored window14 must not become directional window');
 assert.throws(()=>applySMCSignalOverrides(exp,{signal_profile:'typo'} as any),/profile/);
 fs.writeFileSync(file,'not json');assert.throws(()=>loadOptimizedPreset('FIXTURE','M5','Forex - 3. Balanceado',{presetFile:file}));
 assert.throws(()=>loadOptimizedPreset('FIXTURE','M5','Forex - 3. Balanceado',{presetFile:path.join(tmp,'missing.json')}));
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log('SMC preset mapping and explicit frozen input tests passed');
