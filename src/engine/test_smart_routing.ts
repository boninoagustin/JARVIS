import assert from 'node:assert/strict';
import { routeSmartEntry, resolveDirectTrigger, computeFinalScore } from './SmartRouting.js';

const base = {
  direction: 'BUY' as const, currentSession: 'NY', totalPoints: 10, minPtsRequired: 8,
  riskDist: 50, currentPrice: 100, signalTfMinutes: 5, decimals: 2, nowMs: 1000000,
  zones: [], biasTs: {}, atr14: 10, climaxRange: 5, alertLine: 'TEST', config: {},
};

// Zona propia con ATR grande (sin pared opuesta) → rrChoch=3.0 >= 1.5 y riskDist<max → directa.
const noWall = routeSmartEntry({ ...base, zones: [{ tf: '5', dir: 'BUY', atr: 100 } as any] });
assert.equal(noWall.takeChoch, true);
assert.equal(noWall.disableOte, true);
assert.equal(noWall.rrChoch, 3.0);

// Riesgo excesivo: sin zona (atr=0 → limitByPercent=0.15) y riskDist=50 → OTE.
const risky = routeSmartEntry(base);
assert.equal(risky.takeChoch, false);
assert.equal(risky.reason, 'ote_risk');

// smartOteOnly → OTE puro.
const oteOnly = routeSmartEntry({ ...base, config: { smartOteOnly: true } });
assert.equal(oteOnly.takeChoch, false);
assert.equal(oteOnly.reason, 'ote_only');

// Momentum extremo: totalPoints alto y pared con rr<umbral → directa por momentum.
const momentum = routeSmartEntry({ ...base, totalPoints: 20, riskDist: 10, zones: [
  { tf: '5', dir: 'SELL', btm: 110, top: 105, atr: 100 } as any,
] });
assert.equal(momentum.takeChoch, true);
assert.equal(momentum.reason, 'direct_momentum');

// Pared opuesta con rr bajo (< 1.5) sin momentum → OTE.
const wall = routeSmartEntry({ ...base, totalPoints: 10, riskDist: 100, zones: [
  { tf: '5', dir: 'SELL', btm: 110, top: 105, atr: 100 } as any, // rewardDist=10, riskDist=100 → rr=0.1
] });
assert.equal(wall.takeChoch, false);
assert.equal(wall.reason, 'ote_else');

// resolveDirectTrigger: umbral por gatillo y dirección.
const trigChoch = resolveDirectTrigger({ direction: 'BUY', entryTrigger: 'SMART', isChoch: true, eventTf: '5', assetMinBuy: 4, assetMinSell: 4,
  sessionConfig: { choch5m: { enabled: true, minScoreBuy: 12, minScore: 8 } } });
assert.equal(trigChoch.triggerEnabled, true);
assert.equal(trigChoch.minPtsRequired, 12);
assert.equal(trigChoch.liveTriggerCfg.minScoreBuy, 12);

const trigSell = resolveDirectTrigger({ direction: 'SELL', entryTrigger: 'SMART', isChoch: true, eventTf: '5', assetMinBuy: 4, assetMinSell: 5,
  sessionConfig: { choch5m: { enabled: true, minScoreSell: 16 } } });
assert.equal(trigSell.minPtsRequired, 16);

// Sin sessionConfig → entryTrigger decide (CHoCH/SMART → enabled).
const trigNoSes = resolveDirectTrigger({ direction: 'BUY', entryTrigger: 'SMART', isChoch: true, eventTf: '5', assetMinBuy: 4, assetMinSell: 4, sessionConfig: undefined });
assert.equal(trigNoSes.triggerEnabled, true);
assert.equal(trigNoSes.minPtsRequired, 4);

// computeFinalScore: orden del vivo (espacial → bias → trampa) + penalización huérfano.
const s1 = computeFinalScore({ computePointsValue: 3, baseBiasPoints: 0, hasSpatialBacking: false, spatialBonus: 0,
  hasSequentialBacking: false, isDAgainst: false, is4HAgainst: false, is1HAgainst: false, trapZoneCount: 1, isCrypto: false, biasGateStrict: false });
assert.equal(s1.totalPoints, 0); // 3+2=5 → -3 huérfano → 2 → -2 trampa → 0
assert.equal(s1.orphanPenalty, 3);
assert.equal(s1.trapPenalty, 2);

// High-score bypass: raw 3 se anula (totalPoints>=12 y post>=5).
const s2 = computeFinalScore({ computePointsValue: 20, baseBiasPoints: 0, hasSpatialBacking: false, spatialBonus: 0,
  hasSequentialBacking: false, isDAgainst: false, is4HAgainst: false, is1HAgainst: false, trapZoneCount: 0, isCrypto: false, biasGateStrict: false });
assert.equal(s2.totalPoints, 22); // 20+2, sin penalización por bypass
assert.equal(s2.orphanPenalty, 0);

console.log('PASS routeSmartEntry + resolveDirectTrigger + computeFinalScore: decisión SMART compartida (hermético)');
