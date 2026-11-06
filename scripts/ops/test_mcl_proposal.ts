#!/usr/bin/env tsx
/**
 * Tests de la aplicación de propuestas MCL (H03-b, 2ª revisión de auditoría).
 * Lógica pura, sin Firestore:
 *   - la propuesta se aplica COMPLETA (todos sus diffs) o no se aplica nada;
 *   - si el operador cambió el mismo límite desde la publicación → conflicto;
 *   - `current: null` coincide con un campo ausente.
 *
 * Uso: npx tsx scripts/ops/test_mcl_proposal.ts
 */
import assert from 'node:assert/strict';
import { applyProposalToSessions } from './mcl_proposal_core.js';

function base() {
  return {
    NY: { maxBuyLosses: 2, maxSellLosses: 1 },
    LONDON: { maxBuyLosses: 2 },
  };
}

console.log('=== applyProposalToSessions ===');

// (1) Aplica todos los diffs de la propuesta.
{
  const res = applyProposalToSessions(base(), [
    { session: 'NY', field: 'maxSellLosses', current: 1, proposed: 2 },
    { session: 'LONDON', field: 'maxSellLosses', current: null, proposed: 2 },
  ]);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.sessions.NY.maxSellLosses, 2);
    assert.equal(res.sessions.NY.maxBuyLosses, 2); // no tocado
    assert.equal(res.sessions.LONDON.maxSellLosses, 2);
  }
  console.log('PASS aplica todos los diffs y respeta el resto de la sesión');
}

// (2) Conflicto: el operador cambió el mismo límite después de publicar.
{
  const changed = base();
  changed.NY.maxSellLosses = 2; // el operador ya lo puso en 2
  const res = applyProposalToSessions(changed, [
    { session: 'NY', field: 'maxSellLosses', current: 1, proposed: 2 },
  ]);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.conflict, /NY\.maxSellLosses/);
  console.log('PASS conflicto explícito si el campo cambió desde la publicación');
}

// (3) Atomicidad lógica: si UN diff falla, no se devuelve ninguna mutación.
{
  const res = applyProposalToSessions(base(), [
    { session: 'NY', field: 'maxBuyLosses', current: 2, proposed: 3 },          // ok
    { session: 'NY', field: 'maxSellLosses', current: 9, proposed: 2 },          // mismatch
  ]);
  assert.equal(res.ok, false);
  console.log('PASS falla el segundo diff → no hay aplicación parcial');
}

// (4) null y undefined se tratan igual (campo ausente).
{
  const res = applyProposalToSessions({}, [
    { session: 'OFF', field: 'maxBuyLosses', current: undefined, proposed: 2 },
  ]);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.sessions.OFF.maxBuyLosses, 2);
  console.log('PASS current undefined ≡ null (campo ausente)');
}

// (5) No muta el objeto original (copia).
{
  const s = base();
  applyProposalToSessions(s, [{ session: 'NY', field: 'maxSellLosses', current: 1, proposed: 2 }]);
  assert.equal(s.NY.maxSellLosses, 1);
  console.log('PASS no muta el objeto de entrada');
}

console.log('\nAUTOTEST OK');
