import assert from 'node:assert/strict';
import { digestJobState, summarizeSelection, validateTelegramResponse } from './digest_status_core.js';
for (const [result, active, expected] of [
  ['success', 'inactive', 'finished'], ['exec-condition', 'inactive', 'skipped'],
  ['success', 'activating', 'running'], ['success', 'active', 'running'],
  ['exit-code', 'failed', 'failed'], ['timeout', 'failed', 'failed'],
  ['success', 'failed', 'failed'], ['', 'inactive', 'failed'],
]) { assert.equal(digestJobState(result, active), expected); console.log('PASS', result || 'empty', active, expected); }
validateTelegramResponse(true, { ok: true });
for (const [http, body] of [[false, { ok: true }], [true, { ok: false }], [true, null], [true, {}]] as const) {
  assert.throws(() => validateTelegramResponse(http, body));
}
console.log('PASS Telegram API/HTTP validation (no network calls)');
{
  const ok = summarizeSelection({ status: 'completed', counts: { evaluated: 32, skipped: 0, failed: 0 } });
  assert.equal(ok.complete, true); assert.equal(ok.warning, null); assert.match(ok.line, /32 evaluados · 0 omitidos · 0 fallidos/);
  const skip = summarizeSelection({ status: 'completed', counts: { evaluated: 0, skipped: 32, failed: 0 } });
  assert.equal(skip.complete, false); assert.match(skip.warning!, /regresión de frescura/);
  const fail = summarizeSelection({ status: 'failed', counts: { evaluated: 5, skipped: 0, failed: 3 } });
  assert.equal(fail.complete, false); assert.match(fail.warning!, /3 fallido/);
  const absent = summarizeSelection(undefined);
  assert.equal(absent.complete, true); assert.match(absent.line, /sin resumen/);
}
console.log('PASS selection summary completeness/regression rules');
