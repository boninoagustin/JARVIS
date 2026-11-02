// Synthetic fixtures: operational authorization/integrity, not strategy profitability.
import assert from 'node:assert/strict';
import * as safety from './weekly_candidate_safety.js';
import {mapAssetConfig} from './selection_context.js';
const now=Date.now();
const before={ticker:'EURUSD',enabled:true,fixedRR:2,sessions:{NY:{bos5m:{enabled:true,minScore:4}}}};
function fixture():any {
 const asset={...structuredClone(before),fixedRR:2.5};
 const config={...mapAssetConfig('EURUSD',asset),mlGate:{enabled:false}};
 const hash=safety.assetFingerprint(config);
 return {ticker:'EURUSD',timestamp:now,status:'RECOMMEND',apply_eligible:false,
  production_asset_snapshot:structuredClone(before),production_asset_fingerprint:safety.assetFingerprint(before),
  final_asset_config:asset,final_asset_fingerprint:safety.assetFingerprint(asset),final_config:config,
  evaluation_fingerprint:'e'.repeat(64),
  proposal_validation:{trade_count:12,expectancy:.3,net_pnl_r:3.6,max_drawdown_r:2},
  production_validation:{trade_count:12,expectancy:.1,net_pnl_r:1.2,max_drawdown_r:3},
  montecarlo:{survival:.95,config_fingerprint:hash,evaluation_fingerprint:'e'.repeat(64),partition:'validation'},
  certificate:{version:1,config_fingerprint:hash,asset_fingerprint:safety.assetFingerprint(asset),evaluation_fingerprint:'e'.repeat(64),montecarlo_config_fingerprint:hash,validation_role:'selection_validation',test_independence:'unverified',test_evaluated:false}};
}
assert.equal(typeof (safety as any).checkWeeklyCandidate,'function','weekly operational authorization must exist independently of prospective certification');
const check=(safety as any).checkWeeklyCandidate;
assert.equal(check(fixture(),before,now).ok,true,'user-authorized weekly historical candidate can apply');
assert.equal(safety.checkCertifiedCandidate(fixture(),before,now).ok,false,'must never forge prospective certification');
let n=2;
for(const [name,mutate] of [
 ['legacy',(r:any)=>delete r.certificate],
 ['hold',(r:any)=>r.status='HOLD'],
 ['changed asset',(r:any)=>r.final_asset_config.fixedRR=9],
 ['changed strategy',(r:any)=>r.final_config.fixedRR=9],
 ['wrong MC',(r:any)=>r.montecarlo.config_fingerprint='a'.repeat(64)],
 ['nonfinite MC',(r:any)=>r.montecarlo.survival=NaN],
 ['weak MC',(r:any)=>r.montecarlo.survival=.79],
 ['stale',(r:any)=>r.timestamp=now-49*3600000],
 ['future',(r:any)=>r.timestamp=now+1],
 ['no validation',(r:any)=>delete r.proposal_validation],
 ['invalid metrics',(r:any)=>r.proposal_validation.expectancy=Infinity],
 ['empty metrics',(r:any)=>r.proposal_validation.trade_count=0],
 ['false recommendation',(r:any)=>r.proposal_validation={...r.production_validation}],
 ['control-plane change',(r:any)=>{r.final_asset_config.autoTrading=true;r.final_config.autoTrading=true; r.certificate.config_fingerprint=safety.assetFingerprint(r.final_config); r.certificate.montecarlo_config_fingerprint=r.montecarlo.config_fingerprint=r.certificate.config_fingerprint;r.certificate.asset_fingerprint=r.final_asset_fingerprint=safety.assetFingerprint(r.final_asset_config);}]
] as [string,(r:any)=>void][]){const r=fixture();mutate(r);assert.equal(check(r,before,now).ok,false,name);n++;}
assert.equal(check(fixture(),{...before,fixedRR:9},now).ok,false,'concurrent config changed');n++;
for(const current of [{...before,enabled:false},{...before,disabledReason:'manual stop'}]){const r=fixture();r.production_asset_snapshot=current;r.production_asset_fingerprint=safety.assetFingerprint(current);assert.equal(check(r,current,now).ok,false,'never activate disabled/manual assets');n++;}
console.log(`PASS: ${n} weekly authorization cases; prospective certification remains separate`);
