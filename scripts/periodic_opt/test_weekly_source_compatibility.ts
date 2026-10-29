// Synthetic source bytes: accept ONLY an exact, independently exercised additive-hook migration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assetFingerprint} from './weekly_candidate_safety.js';
import {verifyEvaluationArtifacts} from './weekly_rollout.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-compat-'));
const sha=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try{
 const source=path.join(root,'engine.ts'),baseline=path.join(root,'baseline.ts'),data=path.join(root,'events.csv'),proof=path.join(root,'verification.json');
 fs.writeFileSync(source,'before additive hook');fs.copyFileSync(source,baseline);fs.writeFileSync(data,'artificial events');
 const old=sha(source),provenance={source_files:[{path:source,sha256:old}],dataset_files:[{path:data,sha256:sha(data)}]};
 const report={evaluation_provenance:provenance,evaluation_fingerprint:assetFingerprint(provenance)};
 fs.writeFileSync(source,'after additive hook');const after=sha(source);
 assert.equal(verifyEvaluationArtifacts(report).ok,false,'unreviewed source drift always rejects');
 fs.writeFileSync(proof,JSON.stringify({passed:true,exit_code:0,files:{[source]:{before:old,after}},tests:['synthetic compatibility fixture']}));
 const compatibilityManifest={version:1,valid_until_ms:Date.now()+3600000,changes:[{path:source,from_sha256:old,to_sha256:after,baseline_path:baseline,verification_path:proof,verification_sha256:sha(proof)}]};
 assert.equal((verifyEvaluationArtifacts as any)(report,{compatibilityManifest}).ok,true,'exact tested additive hook can preserve a prior evaluation without relabelling provenance');
 fs.writeFileSync(source,'unreviewed third code');assert.equal((verifyEvaluationArtifacts as any)(report,{compatibilityManifest}).ok,false,'another current source hash is not compatible');
 fs.writeFileSync(source,'after additive hook');fs.appendFileSync(proof,' ');assert.equal((verifyEvaluationArtifacts as any)(report,{compatibilityManifest}).ok,false,'changed proof bytes reject');
 console.log('PASS: exact source migration evidence, reject unreviewed drift and tampered proof');
}finally{fs.rmSync(root,{recursive:true,force:true});}
