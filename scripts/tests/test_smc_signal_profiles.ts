import assert from 'node:assert/strict';
import { resolveSignalPolicy, DIRECTIONAL_SIGNAL_THRESHOLDS } from '../../src/engine/smc/signal_profiles.js';

const legacy = resolveSignalPolicy({});
assert.equal(legacy.experimental, false);
assert.equal(legacy.profile, 'legacy_v1');
for (const key of ['directionalMomentum', 'sweepAbsorption', 'sameBarSweeps', 'plateauPivots', 'fvgQuality'] as const) assert.equal(legacy[key], false);
const experimental = resolveSignalPolicy({ signal_profile: 'directional_atr_v1', z_score_window: 14 });
assert.equal(experimental.experimental, true);
assert.equal(experimental.impulse.window, 50);
assert.deepEqual(experimental.impulse, { window: 50, decay: .8, wickWeight: .35, volWindow: 20 });
assert.deepEqual(experimental.fvg, { minAtr: .5, maxAtr: 3, minBodyFraction: .55 });
for (const key of ['directionalMomentum', 'sweepAbsorption', 'sameBarSweeps', 'plateauPivots', 'fvgQuality'] as const) assert.equal(experimental[key], true);
assert.deepEqual(DIRECTIONAL_SIGNAL_THRESHOLDS, { displZ: 1.35, chochZ: 1.10, bodyFraction: .50, sweepMinPenAtr: .03, sweepMaxPenAtr: 1.35, sweepRangeScaleAtr: .65, sweepScore: 1, reclaimClose: .70, reclaimZ: 1 });
console.log('PASS profile legacy/default experimental contract');

assert.throws(() => resolveSignalPolicy({ signal_profile: 'typo' } as any), /profile/i);
assert.throws(() => resolveSignalPolicy({ signal_ablation: { directionalMomentum: false } }), /experimental/i);
assert.throws(() => resolveSignalPolicy({ signal_profile: 'directional_atr_v1', signal_ablation: { unknown: false } } as any), /unknown/i);
assert.throws(() => resolveSignalPolicy({ signal_profile: 'directional_atr_v1', signal_ablation: { directionalMomentum: 0 } } as any), /boolean/i);
assert.equal(resolveSignalPolicy({ signal_profile: 'directional_atr_v1', signal_ablation: { directionalMomentum: false } }).directionalMomentum, false);
console.log('PASS profile strict selection and ablations');

const profile = 'directional_atr_v1' as const;
assert.deepEqual(resolveSignalPolicy({ signal_profile: profile, signal_impulse: { window: 4, decay: .5, wickWeight: .2, volWindow: 3 }, signal_fvg: { minAtr: .2, maxAtr: 2, minBodyFraction: .6 } }).impulse, { window: 4, decay: .5, wickWeight: .2, volWindow: 3 });
assert.equal(resolveSignalPolicy({ signal_profile: profile, fvg_min_atr_factor: .3 }).fvg.minAtr, .3);
assert.equal(resolveSignalPolicy({ signal_profile: profile, fvg_min_atr: .4 }).fvg.minAtr, .4);
assert.throws(() => resolveSignalPolicy({ signal_profile: profile, fvg_min_atr: .4, fvg_min_atr_factor: .3 }), /conflict/i);
assert.equal(resolveSignalPolicy({ signal_profile: profile, fvg_min_atr: .4, fvg_min_atr_factor: .3, signal_fvg: { minAtr: .1 } }).fvg.minAtr, .1);
for (const config of [{window: 1}, {window: 2.5}, {window: NaN}, {decay: 1}, {decay: -.1}, {wickWeight: -1}, {wickWeight: Infinity}, {volWindow: 0}, {volWindow: 1.5}, {foo: 2}, {window: null}]) {
    assert.throws(() => resolveSignalPolicy({ signal_profile: profile, signal_impulse: config } as any));
}
for (const config of [{minAtr: -1}, {maxAtr: 0}, {minAtr: 4}, {minBodyFraction: 1.1}, {minBodyFraction: NaN}, {foo: 2}]) {
    assert.throws(() => resolveSignalPolicy({ signal_profile: profile, signal_fvg: config } as any));
}
console.log('PASS profile threshold overrides, aliases and invalid config rejection');
