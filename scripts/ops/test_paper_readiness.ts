import assert from 'node:assert/strict';
import { paperReadiness } from './paper_readiness.js';
import { configFingerprint } from '../hyperopt/evaluation_protocol.js';

const now = Date.parse('2026-11-20T00:00:00Z');
const registeredAt = Date.parse('2026-11-08T00:00:00Z');
const snap = { ticker: 'EURUSD', enabled: true, sessions: {} };
const candFp = configFingerprint(snap);
const regFp = configFingerprint({ ticker: 'EURUSD', registered_at_ms: registeredAt });

function cert(over: any = {}) {
  return {
    ticker: 'EURUSD', status: 'CERTIFIED', registered_at_ms: registeredAt,
    candidate_fingerprint: candFp, registration_fingerprint: regFp,
    candidate_asset_snapshot: snap,
    latest: { verdict: 'CERTIFIED', evaluated_at_ms: now - 864e5,
      candidate: { n: 10, expectancy: 0.3 }, production: { n: 10, expectancy: 0.1 } },
    ...over,
  };
}
function paper(over: any = {}) {
  const trades = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`, ticker: 'EURUSD', candidateFingerprint: candFp, mode: 'paper', isPaper: true,
    timestamp: registeredAt + (i + 1) * 1000, closedAt: registeredAt + (i + 2) * 1000,
    rMultiple: i < 6 ? 0.5 : -0.2, result: i < 6 ? 'WIN' : 'LOSS',
  }));
  return {
    ticker: 'EURUSD', evidenceKind: 'forward_paper_v1', temporalMode: 'future_observation',
    status: 'OBSERVED', generatedAt: new Date(now - 864e5).toISOString(),
    candidateFingerprint: candFp, registrationFingerprint: regFp, registeredAtMs: registeredAt,
    window: { from_ms: registeredAt, to_ms: registeredAt + 8 * 864e5 },
    trades, n: trades.length, wr: 0.6, expectancy: 0.2,
    ...over,
  };
}

// Ready (6 wins/4 losses: wr 0.6, exp 0.22 > 0, n=10)
assert.equal(paperReadiness('EURUSD', paper(), cert(), now).ready, true);
// Losing paper fails
assert.equal(paperReadiness('EURUSD', paper({ trades: paper().trades.map(t => ({ ...t, rMultiple: -0.5 })) }), cert(), now).ready, false);
// Wrong candidate fingerprint fails
assert.equal(paperReadiness('EURUSD', paper({ candidateFingerprint: 'x'.repeat(64) }), cert(), now).ready, false);
// No certification fails
assert.match(paperReadiness('EURUSD', paper(), null, now).reason!, /certificación/i);
// Certification not CERTIFIED fails
assert.match(paperReadiness('EURUSD', paper(), cert({ status: 'SHADOW' }), now).reason!, /certificación/i);
// Stale certification (>28d) fails
assert.match(paperReadiness('EURUSD', paper(), cert({ latest: { ...cert().latest, evaluated_at_ms: now - 30 * 864e5 } }), now).reason!, /Certificación/i);
// Invalid paper (historical reconstruction) fails
assert.match(paperReadiness('EURUSD', paper({ evidenceKind: 'historical_reconstruction', status: 'OBSERVED' }), cert(), now).reason!, /histórico/i);
// Insufficient sample fails
const few = paper({ trades: paper().trades.slice(0, 5), n: 5 });
assert.match(paperReadiness('EURUSD', few, cert(), now).reason!, /muestra/i);

console.log('PASS paperReadiness: certificación + evidencia paper del MISMO candidato, fail-closed');
