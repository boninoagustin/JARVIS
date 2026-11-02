// All fixtures below are artificial and exercise certification, not market performance.
import assert from 'node:assert/strict';
import { assetFingerprint, checkCertifiedCandidate } from './weekly_candidate_safety.js';
import { mapAssetConfig } from './selection_context.js';
import { configFingerprint } from '../hyperopt/evaluation_protocol.js';

const current = { ticker: 'EURUSD', enabled: true, sessions: { NY: { bos5m: { enabled: true, minScore: 4 } } }, fixedRR: 1.5 };
const asset = structuredClone(current);
asset.sessions.NY.bos5m.minScore = 5;
const config = {...mapAssetConfig('EURUSD', asset), mlGate: {enabled:false}};
const now = Date.now();
function fixture() {
  const configHash = assetFingerprint(config);
  const evaluationHash = 'e'.repeat(64);
  return {
    ticker: 'EURUSD', timestamp: now, status: 'RECOMMEND', apply_eligible: true,
    production_asset_snapshot: structuredClone(current), production_asset_fingerprint: assetFingerprint(current),
    final_asset_config: structuredClone(asset), final_asset_fingerprint: assetFingerprint(asset),
    final_config: structuredClone(config), evaluation_fingerprint: evaluationHash,
    metrics_test: { trade_count: 20, expectancy: 0.1 },
    test_evidence: {partition:'test', config_fingerprint:configHash, evaluation_fingerprint:evaluationHash, metrics_fingerprint:assetFingerprint({trade_count:20,expectancy:.1}), test_independence:'prospective'},
    montecarlo: { survival: 0.9, config_fingerprint: configHash, evaluation_fingerprint: evaluationHash },
    certificate: {
      version: 1, config_fingerprint: configHash, asset_fingerprint: assetFingerprint(asset),
      evaluation_fingerprint: evaluationHash, montecarlo_config_fingerprint: configHash,
      validation_role: 'selection_validation', test_independence: 'prospective', test_evaluated: true,
    },
  };
}
assert.equal(assetFingerprint({ b: 1, a: { y: 2, x: 3 } }), assetFingerprint({ a: { x: 3, y: 2 }, b: 1 }));
assert.equal(assetFingerprint({minimal_roi: {'0': .015, '30': .005, '120': 0}}), configFingerprint({minimal_roi: {'0': .015, '30': .005, '120': 0}}), 'integer-like ROI keys must use the worker canonical order');
assert.equal(checkCertifiedCandidate(fixture(), current, now).ok, true, 'coherent certificate accepted');
let count = 3;
for (const [name, mutate] of [
  ['legacy report without certificate', (r: any) => { delete r.certificate; }],
  ['changed final strategy', (r: any) => { r.final_config.fixedRR = 2; }],
  ['changed final asset', (r: any) => { r.final_asset_config.fixedRR = 2; }],
  ['individually rehashed asset must still project to evaluated strategy', (r: any) => {
    r.final_asset_config.fixedRR = 999;
    r.final_asset_fingerprint = r.certificate.asset_fingerprint = assetFingerprint(r.final_asset_config);
  }],
  ['Test belongs to another candidate', (r: any) => { r.test_evidence.config_fingerprint = 'a'.repeat(64); }],
  ['Test belongs to another scenario', (r: any) => { r.test_evidence.evaluation_fingerprint = 'a'.repeat(64); }],
  ['Test metrics changed after evaluation', (r: any) => { r.metrics_test.expectancy = 9; }],
  ['different dataset', (r: any) => { r.evaluation_fingerprint = 'f'.repeat(64); }],
  ['MC belongs to another candidate', (r: any) => { r.montecarlo.config_fingerprint = 'a'.repeat(64); }],
  ['MC belongs to another evaluation', (r: any) => { r.montecarlo.evaluation_fingerprint = 'a'.repeat(64); }],
  ['reused test is not independent', (r: any) => { r.certificate.test_independence = 'unverified'; }],
  ['empty future test', (r: any) => { r.certificate.test_evaluated = false; }],
  ['prospectivity not certified by pipeline', (r: any) => { r.apply_eligible = false; }],
  ['empty test observations', (r: any) => { r.metrics_test.trade_count = 0; }],
  ['NaN Monte Carlo', (r: any) => { r.montecarlo.survival = NaN; }],
  ['future dated report', (r: any) => { r.timestamp = now + 86400000; }],
  ['stale report', (r: any) => { r.timestamp = now - 49 * 3600000; }],
  ['wrong ticker config', (r: any) => { r.final_config.ticker = 'GER40'; }],
] as [string, (r: any) => void][]) {
  const report = fixture(); mutate(report);
  assert.equal(checkCertifiedCandidate(report, current, now).ok, false, name); count++;
}
assert.equal(checkCertifiedCandidate(fixture(), { ...current, fixedRR: 2 }, now).ok, false, 'current config changed after snapshot'); count++;
console.log(`PASS: ${count} candidate certification cases`);
