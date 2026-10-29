import assert from 'node:assert/strict';
import fs from 'node:fs';
import {configFingerprint} from '../hyperopt/evaluation_protocol.js';
const moduleFile='/opt/JARVIS/scripts/hyperopt/wfa_window.ts';
assert.ok(fs.existsSync(moduleFile),'WFA window authorization module is missing');
const {validateWfaPlan,foldWindow,m5Coverage}=await import('../hyperopt/wfa_window.js');
const D=86400000,H=3600000,B=1700000000000;
const policy={is_days:21,oos_days:7,step_days:7,history_days:56,warmup_days:14,gap_hours:8,embargo_hours:12,
 inner_validation_days:7,min_context_observations:{'5':60,'15':60,'60':60,'240':60,'D':60}};
let rows:any[]=[];
for(let end=B+49*D;end-7*D-8*H-21*D>=B;end-=7*D){
 const os=end-7*D,ie=os-8*H,vs=ie-7*D;
 rows.unshift({is_start_ms:ie-21*D,is_end_ms:ie,inner_train_end_ms:vs-12*H,inner_validation_start_ms:vs,
  oos_start_ms:os,oos_end_ms:end,fit_asof_ms:ie,context_policy:'context-only-reset-execution-v1'});
}
rows=rows.map((row,i)=>({...row,id:i+1}));
const raw:any={version:2,kind:'rolling_wfa_shadow',ticker:'FIXTURE',clock:'M5',
 coverage:{m5_start_ms:B,m5_end_ms:B+56*D},policy,folds:rows,
 vault:{from_ms:B+49*D,to_ms:B+56*D,independence:'unverified',access:'blocked'},apply_eligible:false};
raw.fingerprint=configFingerprint(raw);
const plan=validateWfaPlan(raw,'FIXTURE');
assert.equal(foldWindow(plan,1,'outer_oos').from_ms,B+28*D);
assert.throws(()=>foldWindow(plan,0,'outer_oos'),/Vault|vault|blocked/);
assert.equal(foldWindow(plan,0,'is').to_ms,B+49*D-8*H);
assert.throws(()=>foldWindow(plan,1,'bogus'),/role/);
const tamper=structuredClone(raw);tamper.folds[0].oos_end_ms++;
assert.throws(()=>validateWfaPlan(tamper,'FIXTURE'),/fingerprint|window|fold/);
const events=[{ts:B,parsed:{eventTf:'5',prefix:'PING_PRICE'}},
 {ts:B+56*D-1,parsed:{eventTf:'5',prefix:'PING_PRICE'}},
 {ts:B+70*D,parsed:{eventTf:'240',prefix:'PING_PRICE'}}];
assert.equal(m5Coverage(events).to_ms,B+56*D);
assert.equal(m5Coverage(events).from_ms,B);
const withNonPrices=[{ts:B-100,parsed:{eventTf:'5',prefix:'HEARTBEAT'}},...events,
 {ts:B+80*D,parsed:{eventTf:'5',prefix:'HEARTBEAT'}}];
assert.equal(m5Coverage(withNonPrices).from_ms,B,'M5 anchor must use prices only');
assert.equal(m5Coverage(withNonPrices).to_ms,B+56*D);
const zero=structuredClone(raw);zero.policy.warmup_days=0;
delete zero.fingerprint;zero.fingerprint=configFingerprint(zero);
assert.doesNotThrow(()=>validateWfaPlan(zero,'FIXTURE'));
console.log('WFA Node window authorization tests passed');
