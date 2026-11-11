import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRecalibrateML, currentMLComparison, type MLCalibrationStatus, type MLCandidateComparison } from './mlCalibration.ts';
const partition = (accepted: number, required: number, wins = 10, losses = accepted - wins) => ({ accepted, required, missing: Math.max(0, required - accepted), wins, losses });
const m = (pnlR: number, n = 30) => ({ n, pnlR, wr: 50, pf: 2, mdd: 3 });
const comparison: MLCandidateComparison = {
    schemaVersion: 2, status: 'valid', ticker: 'JP225', candidate: 'candidates/JP225.json', candidateSha256: 'a'.repeat(64), evaluatedAt: 400,
    selectedThreshold: .65, calibration: { fromMs: 100, toMs: 200, baseline: m(10), runs: [
        { threshold: .5, metrics: m(11), eligible: true }, { threshold: .65, metrics: m(12), eligible: true }, { threshold: .8, metrics: m(9), eligible: true },
    ], selectedMode: 'gate', selectedThreshold: .65, selectionMade: true },
    validation: { fromMs: 200, toMs: 300, baseline: m(10), selected: m(8), deltaR: -2 },
    recommendation: 'KEEP_OFF', reason: 'El umbral elegido resta en validación', scope: 'temporal_threshold_holdout',
};
const compared: MLCalibrationStatus = { state: 'CALIBRATED', ready: false, candidate: { path: comparison.candidate, sha256: comparison.candidateSha256 }, comparison };
const accepts = (c: MLCandidateComparison) => currentMLComparison({ ...compared, comparison: c }, 'JP225');
test('only exact current schema2 candidate numbers are shown', () => {
    assert.equal(currentMLComparison(undefined, 'JP225'), null);
    assert.equal(currentMLComparison(compared, 'JP225'), comparison);
    assert.equal(currentMLComparison(compared, 'EURUSD'), null);
    assert.equal(currentMLComparison({ ...compared, candidate: { ...compared.candidate!, sha256: 'b'.repeat(64) } }, 'JP225'), null);
    assert.equal(accepts({ ...comparison, schemaVersion: 1 } as any), null);
    assert.equal(accepts({ ...comparison, candidate: 'another.json' }), null);
});
test('rejects invalid chronology, stale and inconsistent final metrics', () => {
    for (const status of ['stale', 'error', 'unavailable']) assert.equal(accepts({ ...comparison, status }), null);
    assert.equal(accepts({ ...comparison, scope: 'retrospective_validation' }), null);
    assert.equal(accepts({ ...comparison, validation: { ...comparison.validation, fromMs: 199 } }), null);
    assert.equal(accepts({ ...comparison, validation: { ...comparison.validation, deltaR: 1 } }), null);
    assert.equal(accepts({ ...comparison, calibration: { ...comparison.calibration, baseline: m(Infinity) } }), null);
});
test('winner is based ONLY on calibration; final losses never permit reselecting', () => {
    assert.equal(accepts(comparison), comparison);
    assert.equal(accepts({ ...comparison, selectedThreshold: .5, calibration: { ...comparison.calibration, selectedMode: 'gate', selectedThreshold: .5 } }), null);
    assert.equal(accepts({ ...comparison, calibration: { ...comparison.calibration, runs: comparison.calibration.runs.slice(0, 2) } }), null);
    const runs = comparison.calibration.runs.map(r => ({ ...r, metrics: m(10) }));
    const off: MLCandidateComparison = { ...comparison, selectedThreshold: null, calibration: { ...comparison.calibration, runs, selectedMode: 'off', selectedThreshold: null }, validation: { ...comparison.validation, selected: null, deltaR: null } };
    assert.equal(accepts(off), off); // Ties favor OFF; do not manufacture a gate arm.
    assert.equal(accepts({ ...off, validation: { ...off.validation, selected: m(10), deltaR: 0 } }), null);
    const noSelection: MLCandidateComparison = { ...off, status: 'insufficient', calibration: { ...off.calibration, baseline: m(10, 19), selectionMade: false } };
    assert.equal(accepts(noSelection), noSelection);
    assert.equal(accepts({ ...noSelection, status: 'valid' }), null);
});
test('insufficient final evidence remains visible without being called valid', () => {
    const low: MLCandidateComparison = { ...comparison, status: 'insufficient', recommendation: 'INSUFFICIENT_EVIDENCE', validation: { ...comparison.validation, selected: m(8, 12) } };
    assert.equal(accepts(low), low);
    assert.equal(accepts({ ...low, status: 'valid' }), null);
});
const ready: MLCalibrationStatus = { state: 'READY', ready: true, train: partition(50, 50), calibration: partition(20, 20), validation: partition(30, 30) };
test('requires THREE sufficient partitions, never a total count or old two-window cache', () => {
    assert.equal(canRecalibrateML(ready), true);
    assert.equal(canRecalibrateML({ ...ready, calibration: undefined }), false);
    assert.equal(canRecalibrateML({ ...ready, train: partition(49, 50) }), false);
    assert.equal(canRecalibrateML({ ...ready, calibration: partition(19, 20) }), false);
    assert.equal(canRecalibrateML({ ...ready, validation: partition(29, 30) }), false);
    assert.equal(canRecalibrateML(undefined), false);
    assert.equal(canRecalibrateML({ ...ready, ready: false }), false);
});
test('requires both labels and no active worker', () => {
    assert.equal(canRecalibrateML({ ...ready, train: partition(50, 50, 50, 0) }), false);
    assert.equal(canRecalibrateML({ ...ready, calibration: partition(20, 20, 0, 20) }), false);
    assert.equal(canRecalibrateML({ ...ready, validation: partition(30, 30, 30, 0) }), false);
    for (const state of ['running', 'queued', 'RUNNING', 'QUEUED', 'COMPARING']) assert.equal(canRecalibrateML({ ...ready, job: { state } }), false);
    assert.equal(canRecalibrateML({ ...ready, bootstrapRequired: true }), true);
    assert.equal(canRecalibrateML({ ...ready, train: partition(50, 50, Infinity, 10) }), false);
});
