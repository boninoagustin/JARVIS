import assert from 'node:assert/strict';
import {adrUpdateDecision} from './update_adr_guarded.js';
assert.equal(adrUpdateDecision({}).ok,true);
assert.equal(adrUpdateDecision({applied:{EURUSD:{prodOosRef:12}}}).ok,true,'legacy entries do not masquerade as v2 pending review');
assert.equal(adrUpdateDecision({},1).ok,false,'no engine rewrite/restart with positions open');
for(const snapshot of [
 {applied:{EURUSD:{policy_version:2,followup:{status:'PENDING'}}}},
 {reviews:{EURUSD_100:{policy_version:2,followup:{status:'PENDING'}}}},
 {applied:{EURUSD:{policy_version:2,confirmation_pending:true,followup:{status:'KEEP'}}}},
 {applied:{EURUSD:{policy_version:2}}},
])assert.equal(adrUpdateDecision(snapshot).ok,false,'pending original engine versions must remain reviewable');
assert.equal(adrUpdateDecision({applied:{EURUSD:{policy_version:2,followup:{status:'KEEP'}}},reviews:{}}).ok,true,'resume normal calibration after completed reviews');
assert.equal(adrUpdateDecision({reviews:{EURUSD_100:{policy_version:2,followup:{status:'ROLLBACK'}}}}).ok,true);
console.log('PASS: ADR update preserves pending engine identities and open trades; resumes after reviews');
