import assert from 'node:assert/strict';
import { evaluateSweepImpulse } from '../../src/engine/smc/math/sweep_absorption.js';
import type { OHLCV, DirectionalImpulseSnapshot } from '../../src/engine/smc/types.js';
const candle: OHLCV = { timestamp: 1, open: 10.7, high: 11, low: 10, close: 10.8, volume: 0 };
const snapshot: DirectionalImpulseSnapshot = { timestamp: 1, sampleCount: 50, ready: true, zUp: 1, zDn: -2, upSmooth: 1, dnSmooth: .1, atr: 1, atrNormalizedRange: 1, volumeRatio: 2, priorVolumeMean: 100 };
const input = { candle, sweptLevel: 10.2, direction: 'Bullish' as const, currentAtr: 1, minWickPct: .4, snapshot };
const result = evaluateSweepImpulse(input);
assert.equal(result.accepted, true);
assert.equal(result.sweepType, 'LIQ_GRAB');
assert.ok(Math.abs(result.score - (.4 / .65 + .35 * .7 / .4 + .25)) < 1e-12);
assert.ok(Math.abs(result.penetrationAtr - .2) < 1e-12);
assert.ok(Math.abs(result.wickPct - .7) < 1e-12);
assert.ok(Math.abs(result.closeLocation - .8) < 1e-12);
assert.equal(result.directionalZ, 1);
console.log('PASS exact sweep score/geometry and neutral missing volume');
for (const bad of [null, { ...snapshot, timestamp: 0 }, { ...snapshot, atr: 2 }, { ...snapshot, ready: false }, { ...snapshot, zUp: NaN }, { ...snapshot, volumeRatio: NaN }]) assert.equal(evaluateSweepImpulse({ ...input, snapshot: bad }).accepted, false);
for (const badCandle of [{ ...candle, high: 10 }, { ...candle, timestamp: Infinity }, { ...candle, low: NaN }, { ...candle, high: 10, low: 10, open: 10, close: 10 }]) assert.equal(evaluateSweepImpulse({ ...input, candle: badCandle }).accepted, false);
for (const currentAtr of [0, NaN, Infinity, -1]) assert.equal(evaluateSweepImpulse({ ...input, currentAtr }).accepted, false);
for (const minWickPct of [0, -1, NaN, 1.1]) assert.equal(evaluateSweepImpulse({ ...input, minWickPct }).accepted, false);
assert.equal(evaluateSweepImpulse({ ...input, sweptLevel: NaN }).accepted, false);
assert.equal(evaluateSweepImpulse({ ...input, direction: 'Invalid' as any }).accepted, false);
assert.deepEqual(snapshot, { timestamp: 1, sampleCount: 50, ready: true, zUp: 1, zDn: -2, upSmooth: 1, dnSmooth: .1, atr: 1, atrNormalizedRange: 1, volumeRatio: 2, priorVolumeMean: 100 });
console.log('PASS sweep fail-closed causal snapshot and invalid geometry');

const mirror = (c: OHLCV): OHLCV => ({ ...c, open: 30-c.open, close: 30-c.close, high: 30-c.low, low: 30-c.high });
const mirrored = evaluateSweepImpulse({ ...input, candle: mirror(candle), direction: 'Bearish', sweptLevel: 30-input.sweptLevel, snapshot: { ...snapshot, zUp: snapshot.zDn, zDn: snapshot.zUp } });
assert.equal(mirrored.accepted, result.accepted);
assert.equal(mirrored.sweepType, result.sweepType);
for (const key of ['score', 'penetrationAtr', 'wickPct', 'closeLocation', 'directionalZ'] as const) assert.ok(Math.abs(mirrored[key]-result[key]) < 1e-12);
for (const scale of [1e-8, 1e8]) {
    const c = { ...candle, open: candle.open*scale, close: candle.close*scale, high: candle.high*scale, low: candle.low*scale };
    const scaled = evaluateSweepImpulse({ ...input, candle: c, sweptLevel: input.sweptLevel*scale, currentAtr: scale, snapshot: {...snapshot, atr: scale} });
    assert.equal(scaled.accepted, true);
    assert.ok(Math.abs(scaled.score-result.score) < 1e-10);
}
const reclaim = { ...candle, open: 10.9, close: 10.7 };
const reclaimed = evaluateSweepImpulse({ ...input, candle: reclaim });
assert.equal(reclaimed.accepted, true, 'reclaim may be wrong color, thin wick');
assert.equal(reclaimed.sweepType, 'LIQ_GRAB');
const thin = { ...candle, open: 10.1, close: 10.9 };
assert.equal(evaluateSweepImpulse({ ...input, candle: thin, snapshot: {...snapshot, zUp: 1.5} }).accepted, true, 'reclaim has no extra wick restriction when score passes');
assert.equal(evaluateSweepImpulse({ ...input, candle: thin, snapshot: {...snapshot, zUp: .99} }).accepted, false);
assert.equal(evaluateSweepImpulse({ ...input, sweptLevel: 10.02 }).accepted, false);
assert.equal(evaluateSweepImpulse({ ...input, sweptLevel: 11.36 }).accepted, false);
for (const volume of [undefined, 0, -1, NaN, Infinity]) assert.equal(evaluateSweepImpulse({ ...input, candle: {...candle, volume} as OHLCV }).score, result.score);
for (const [volumeRatio, factor] of [[.01, .8515], [100, 1.25], [2, 1.15]]) {
    assert.ok(Math.abs(evaluateSweepImpulse({ ...input, candle: {...candle, volume: 100}, snapshot: {...snapshot, volumeRatio} }).score-result.score*factor) < 1e-12);
}
console.log('PASS sweep mirroring, scaling, reclaim, penetration bounds and volume factor');
for(const level of [candle.close,candle.close+.1]){
 assert.equal(evaluateSweepImpulse({...input,sweptLevel:level}).accepted,false,'bull sweep must actually reclaim the swept level');
 assert.equal(evaluateSweepImpulse({...input,candle:mirror(candle),direction:'Bearish',sweptLevel:30-level,
  snapshot:{...snapshot,zUp:snapshot.zDn,zDn:snapshot.zUp}}).accepted,false,'bear sweep must actually reclaim the swept level');
}
console.log('PASS strict reclamation is required independently of favorable morphology');
