import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRecalibrateML, type MLCalibrationStatus } from './mlCalibration.ts';
const partition = (accepted: number, wins = 10, losses = accepted - wins) => ({ accepted, missing: Math.max(0, 20 - accepted), wins, losses });
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
