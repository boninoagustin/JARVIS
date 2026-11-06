#!/usr/bin/env tsx
/**
 * H07 (auditoría 2026-11-05): frescura del health.
 * Un doc de `detection_health` sin fecha, viejo o con fecha futura NO es consumible.
 *
 * Uso: npx tsx scripts/ops/test_health_freshness.ts
 */
import assert from 'node:assert/strict';
import { isHealthFresh, HEALTH_MAX_AGE_MS } from './health_freshness_core.js';

const now = Date.parse('2026-11-06T12:00:00Z');
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

console.log('=== H07: frescura de detection_health ===');
assert.equal(isHealthFresh({ evaluatedAt: iso(0) }, now), true);
console.log('PASS recién evaluado → usable');

assert.equal(isHealthFresh({ evaluatedAt: iso(2 * 864e5) }, now), true);
console.log('PASS 2 días → usable');

assert.equal(isHealthFresh({ evaluatedAt: iso(HEALTH_MAX_AGE_MS + 864e5) }, now), false);
console.log('PASS 9 días → stale (SIN_DATOS)');

assert.equal(isHealthFresh({}, now), false);
assert.equal(isHealthFresh({ evaluatedAt: undefined }, now), false);
console.log('PASS sin evaluatedAt → stale');

assert.equal(isHealthFresh({ evaluatedAt: 'no-es-fecha' }, now), false);
console.log('PASS fecha inválida → stale');

assert.equal(isHealthFresh({ evaluatedAt: new Date(now + 864e5).toISOString() }, now), false);
console.log('PASS fecha futura → stale');

console.log('\nAUTOTEST OK');
