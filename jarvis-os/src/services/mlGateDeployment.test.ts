import test from 'node:test';
import assert from 'node:assert/strict';
import {
    configFingerprint, mlConfigFingerprint, ML_GATE_MAX_AGE_MS,
    validateMLGateEvaluation, type MLGateEvaluationV2,
} from './mlGateDeployment.ts';

const now = Date.UTC(2026, 10, 10);
const config = { enabled: true, fixedRR: 2, sessions: { london: true }, maxTradesPerDay: 3 };
const hash = 'a'.repeat(64);
function fixture(): MLGateEvaluationV2 {
    return {
        schemaVersion: 2, ticker: 'EURUSD', evidenceId: 'b'.repeat(64),
        evaluatedAt: now, configFingerprint: configFingerprint(config),
        model: { sha256: hash, trainingCutoffAt: now - 6000, availableAt: now - 5000 },
        selection: { method: 'chronological-holdout', selectedThreshold: 0.6, from: now - 4000, to: now - 3000 },
        validation: {
            independent: true, threshold: 0.6, from: now - 2000, to: now - 1000,
            baseline: { n: 35, wr: 45, pf: 1.1, pnlR: 2, mdd: 5 },
            gate: { n: 30, wr: 55, pf: 1.4, pnlR: 3.1, mdd: 3 },
        },
    };
}
function check(ev: unknown, overrides: Record<string, unknown> = {}) {
    return validateMLGateEvaluation(ev, { ticker: 'EURUSD', config, now, modelSha256: hash, ...overrides });
}
function denied(ev: unknown, overrides: Record<string, unknown> = {}) {
    const result = check(ev, overrides);
    assert.equal(result.ok, false);
    assert.equal(result.deployment, undefined);
    assert.ok(result.reasons.length);
    assert.ok(result.reason.length);
}

test('v2 deploys exactly the selected AND independently tested threshold and raw model identity', () => {
    const ev = fixture();
    const result = check(ev);
    assert.equal(result.ok, true);
    assert.equal(result.reason, '');
    assert.ok(Math.abs(result.delta! - 1.1) < 1e-12);
    assert.deepEqual(result.deployment, {
        schemaVersion: 2, modelSha256: hash, threshold: 0.6, evidenceId: ev.evidenceId,
        configFingerprint: ev.configFingerprint, evaluatedAt: now,
    });
    assert.deepEqual(ev, fixture(), 'validation never mutates evidence');
});
test('legacy positive sweep, boolean flags and missing v2 evidence fail closed', () => {
    for (const ev of [undefined, null, {}, { schemaVersion: 1 }, { delta: 99, bestGate: { umbral: 0.6, n: 100 }, sinGate: { n: 100 }, evaluatedAt: now }]) denied(ev);
});
test('threshold selection cannot substitute for heldout validation or change threshold', () => {
    for (const value of [undefined, null, NaN, Infinity, -0.1, 1.1, '0.6', 0.65]) {
        const ev = fixture(); (ev.validation as any).threshold = value; denied(ev);
    }
    const ev = fixture(); ev.validation.independent = false as true; denied(ev);
    const ev2 = fixture(); ev2.selection.method = 'best-on-validation' as any; denied(ev2);
});
test('all cutoff and interval fields must exist, be finite and chronological', () => {
    const locations = [
        ['model', 'trainingCutoffAt'], ['model', 'availableAt'],
        ['selection', 'from'], ['selection', 'to'], ['validation', 'from'], ['validation', 'to'],
    ];
    for (const [section, field] of locations) {
        for (const bad of [undefined, null, NaN, Infinity, 0, '123']) {
            const ev = fixture() as any; ev[section][field] = bad; denied(ev);
        }
    }
    const mutations = [
        (ev: MLGateEvaluationV2) => { ev.model.trainingCutoffAt = ev.model.availableAt + 1; },
        (ev: MLGateEvaluationV2) => { ev.model.availableAt = ev.selection.from + 1; },
        (ev: MLGateEvaluationV2) => { ev.selection.to = ev.selection.from; },
        (ev: MLGateEvaluationV2) => { ev.validation.from = ev.selection.to; },
        (ev: MLGateEvaluationV2) => { ev.validation.from = ev.selection.from; },
        (ev: MLGateEvaluationV2) => { ev.validation.to = ev.validation.from; },
        (ev: MLGateEvaluationV2) => { ev.validation.to = ev.evaluatedAt + 1; },
    ];
    for (const mutate of mutations) { const ev = fixture(); mutate(ev); denied(ev); }
});
test('freshness includes exactly eight days but rejects stale/future/non-numeric times', () => {
    const ev = fixture();
    assert.equal(check(ev, { now: now + ML_GATE_MAX_AGE_MS }).ok, true);
    denied(ev, { now: now + ML_GATE_MAX_AGE_MS + 1 });
    denied(ev, { now: now - 1 });
    for (const bad of [undefined, null, NaN, Infinity, 0, '123']) {
        const altered = fixture(); (altered as any).evaluatedAt = bad; denied(altered);
    }
    for (const bad of [null, NaN, Infinity, 0, '123']) denied(ev, { now: bad });
});
test('sample floor applies independently to BOTH baseline and gate, integer finite only', () => {
    for (const side of ['baseline', 'gate'] as const) {
        for (const bad of [undefined, null, NaN, Infinity, -1, 0, 29, 30.1, '30']) {
            const ev = fixture(); (ev.validation[side] as any).n = bad; denied(ev);
        }
    }
    const ev = fixture(); ev.validation.baseline.n = 30;
    assert.equal(check(ev).ok, true);
});
test('every validation metric must be numeric and finite in both arms', () => {
    for (const side of ['baseline', 'gate'] as const) {
        for (const metric of ['wr', 'pf', 'pnlR', 'mdd'] as const) {
            for (const bad of [undefined, null, NaN, Infinity, -Infinity, '1']) {
                const ev = fixture(); (ev.validation[side] as any)[metric] = bad; denied(ev);
            }
        }
        for (const [metric, bad] of [['wr', -1], ['wr', 101], ['pf', -1], ['mdd', -1]]) {
            const ev = fixture(); (ev.validation[side] as any)[metric] = bad; denied(ev);
        }
    }
});
test('computes positive delta from heldout metrics; ignores untrusted stored delta', () => {
    for (const pnlR of [2, 1, -10]) {
        const ev = fixture() as any; ev.delta = 999; ev.validation.gate.pnlR = pnlR; denied(ev);
    }
    const ev = fixture() as any; ev.delta = -999;
    assert.equal(check(ev).ok, true);
    ev.validation.baseline.pnlR = -Number.MAX_VALUE;
    ev.validation.gate.pnlR = Number.MAX_VALUE; denied(ev);
});
test('disable still requires v2 evidence but accepts zero/negative heldout delta, without deployment', () => {
    for (const pnlR of [2, -10]) {
        const ev = fixture(); ev.validation.gate.pnlR = pnlR;
        const result = check(ev, { intent: 'disable' });
        assert.equal(result.ok, true); assert.equal(result.deployment, undefined);
    }
    const ev = fixture(); ev.validation.baseline.n = 29; denied(ev, { intent: 'disable' });
    denied({}, { intent: 'disable' });
});
test('exact active ticker, SHA identities, available raw model hash and frozen config are bound', () => {
    for (const ticker of ['eurusd', 'USDJPY', '', undefined]) {
        const ev = fixture(); (ev as any).ticker = ticker; denied(ev);
    }
    for (const bad of ['', 'a'.repeat(63), 'A'.repeat(64), '../model.json', null]) {
        const ev = fixture(); (ev.model as any).sha256 = bad; denied(ev);
        const ev2 = fixture(); (ev2 as any).evidenceId = bad; denied(ev2);
    }
    denied(fixture(), { modelSha256: 'c'.repeat(64) });
    denied(fixture(), { modelSha256: 'bad' });
    denied(fixture(), { config: { ...config, fixedRR: 3 } });
    denied(fixture(), { config: { ...config, newRiskParameter: true } });
    const ev = fixture(); ev.configFingerprint = ''; denied(ev);
});
test('canonical config is deterministic, browser safe, and excludes ONLY explicit root controls/audit', () => {
    assert.equal(configFingerprint({ b: { z: 1, a: 2 }, a: [3, 4] }), '{"a":[3,4],"b":{"a":2,"z":1}}');
    assert.equal(mlConfigFingerprint({ b: 2, a: 1 }), configFingerprint({ a: 1, b: 2 }));
    assert.equal(configFingerprint({ ...config, mlGateEnabled: true, mlGateDeployment: { anything: true }, updatedAt: new Date(), updatedBy: 'bob', lastModifiedAt: 5, lastModifiedBy: 'joe' }), configFingerprint(config));
    const nested = { ...config, sessions: { ...config.sessions, updatedAt: 3, mlGateEnabled: true } };
    assert.notEqual(configFingerprint(nested), configFingerprint(config));
    for (const change of [{ maxTradesPerDay: 4 }, { fixedRR: 0 }, { enabled: false }, { sessions: { london: false } }, { audit: { fixedRR: 3 } }, { createdAt: 1 }]) {
        assert.notEqual(configFingerprint({ ...config, ...change }), configFingerprint(config));
    }
    assert.notEqual(configFingerprint({ a: [1, 2] }), configFingerprint({ a: [2, 1] }));
    assert.notEqual(configFingerprint({ a: null }), configFingerprint({}));
    const protoKey = JSON.parse('{"__proto__":{"polluted":true}}');
    assert.equal(configFingerprint(protoKey), '{"__proto__":{"polluted":true}}');
});
test('canonical config rejects unsafe/non-JSON data instead of dropping trading fields', () => {
    const circular: any = {}; circular.self = circular;
    for (const bad of [null, [], undefined, new Date(), { risk: undefined }, { risk: NaN }, { risk: Infinity }, { risk: 1n }, { risk: () => 1 }, { risk: new Date() }, { risk: new Map() }, { risk: [, 2] }, circular, { [Symbol('risk')]: 1 }]) {
        assert.throws(() => configFingerprint(bad));
        denied(fixture(), { config: bad });
    }
});
