import assert from 'node:assert/strict';
import { digestJobState, validateTelegramResponse } from './digest_status_core.js';
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
