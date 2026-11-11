import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRecalibrateML, currentMLComparison, type MLCalibrationStatus, type MLCandidateComparison } from './mlCalibration.ts';
const partition = (accepted: number, wins = 10, losses = accepted - wins) => ({ accepted, missing: Math.max(0, 20 - accepted), wins, losses });
const comparison: MLCandidateComparison = { schemaVersion: 1, status: 'valid', ticker: 'JP225', candidate: 'candidates/JP225.json', candidateSha256: 'a'.repeat(64), threshold: .65, evaluatedAt: 300, fromMs: 100, toMs: 200, baseline: { n: 41, pnlR: 10, wr: 50, pf: 2, mdd: 3 }, gate: { n: 18, pnlR: 8, wr: 60, pf: 3, mdd: 2 }, deltaR: -2, recommendation: 'KEEP_OFF', reason: 'El gate resta', scope: 'retrospective_validation' };
const compared: MLCalibrationStatus = { state: 'CALIBRATED', ready: false, candidate: { path: comparison.candidate, sha256: comparison.candidateSha256 }, comparison };
test('never displays legacy or another candidate return numbers', () => {
    assert.equal(currentMLComparison(undefined, 'JP225'), null);
    assert.equal(currentMLComparison({ state: 'READY', ready: true }, 'JP225'), null);
    assert.equal(currentMLComparison(compared, 'JP225'), comparison);
    assert.equal(currentMLComparison(compared, 'EURUSD'), null);
    assert.equal(currentMLComparison({ ...compared, candidate: { ...compared.candidate!, sha256: 'b'.repeat(64) } }, 'JP225'), null);
    assert.equal(currentMLComparison({ ...compared, comparison: { ...comparison, candidate: 'another.json' } }, 'JP225'), null);
});
test('rejects stale, invalid and inconsistent comparison metrics', () => {
    for (const changed of [{ status: 'stale' }, { status: 'error' }, { deltaR: 18 }, { fromMs: 200 }, { threshold: NaN }, { scope: 'training' }, { baseline: { ...comparison.baseline, pnlR: Infinity } }]) {
        assert.equal(currentMLComparison({ ...compared, comparison: { ...comparison, ...changed } }, 'JP225'), null);
    }
});
const ready: MLCalibrationStatus = { state: 'READY', ready: true, train: partition(50), validation: partition(20) };
test('requires both partitions, not total count', () => {
    assert.equal(canRecalibrateML(ready), true);
    assert.equal(canRecalibrateML({ ...ready, train: partition(48), validation: partition(19) }), false);
    assert.equal(canRecalibrateML(undefined), false);
    assert.equal(canRecalibrateML({ ...ready, ready: false }), false);
});
test('requires both labels and no active job', () => {
    assert.equal(canRecalibrateML({ ...ready, train: partition(50, 50, 0) }), false);
    assert.equal(canRecalibrateML({ ...ready, train: partition(49) }), false);
    assert.equal(canRecalibrateML({ ...ready, validation: partition(20, 0, 20) }), false);
    for (const state of ['running', 'queued', 'RUNNING', 'QUEUED']) assert.equal(canRecalibrateML({ ...ready, job: { state } }), false);
    assert.equal(canRecalibrateML({ ...ready, bootstrapRequired: true }), true);
    assert.equal(canRecalibrateML({ ...ready, train: partition(20, Infinity, 10) }), false);
    assert.equal(canRecalibrateML({ ...ready, train: partition(20, 1, 1) }), false);
});
