#!/usr/bin/env tsx
/**
 * H11 (auditoría 2026-11-05): rotación de tokens cTrader
 *  - singleflight: dos refresh concurrentes → UNA sola llamada a fetch;
 *  - escritura atómica del .env (sin .tmp residual), modo 0600;
 *  - backup con modo 0600;
 *  - `force` sigue funcionando tras liberar el in-flight.
 *
 * No usa tokens reales: `fetch` está mockeado y el .env es temporal
 * (CTRADER_ENV_PATH). Uso: npx tsx scripts/ops/test_token_singleflight.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-token-'));
const envPath = path.join(dir, '.env');
fs.writeFileSync(envPath, 'CTRADER_REFRESH_TOKEN=REFRESH1\nCTRADER_CLIENT_ID=cid\nCTRADER_CLIENT_SECRET=sec\n', { mode: 0o600 });
process.env.CTRADER_ENV_PATH = envPath;   // ANTES del import (ENV_PATH se calcula al cargar)

let fetchCalls = 0;
(globalThis as any).fetch = async () => {
    fetchCalls++;
    await new Promise((r) => setTimeout(r, 60));   // dar tiempo a que el 2º llame durante el 1º
    return { ok: true, json: async () => ({ access_token: 'ACCESS2', refresh_token: 'REFRESH2' }) } as any;
};

const mod = await import('../../src/services/ctraderToken.js');

console.log('=== H11: singleflight ===');
const [a, b] = await Promise.all([mod.refreshCtraderToken(true), mod.refreshCtraderToken(true)]);
assert.equal(fetchCalls, 1, 'dos refresh concurrentes deben compartir UN fetch');
console.log('PASS dos refresh concurrentes → 1 fetch');
assert.equal(a, true);
assert.equal(b, true);
console.log('PASS ambos resuelven true (mismo intento)');

console.log('\n=== H11: escritura atómica ===');
const env = fs.readFileSync(envPath, 'utf8');
assert.match(env, /^CTRADER_ACCESS_TOKEN=ACCESS2$/m);
assert.match(env, /^CTRADER_REFRESH_TOKEN=REFRESH2$/m);
assert.match(env, /^CTRADER_TOKEN_ISSUED_AT=\d+$/m);
console.log('PASS .env contiene el par nuevo');
assert.equal(fs.existsSync(`${envPath}.tmp`), false, 'no debe quedar .tmp residual');
console.log('PASS sin .tmp residual (rename atómico)');
assert.equal(fs.statSync(envPath).mode & 0o777, 0o600, '.env debe quedar 0600');
console.log('PASS .env modo 0600');
const backups = fs.readdirSync(dir).filter((f) => f.startsWith('.env.bak-token-'));
assert.ok(backups.length >= 1, 'debe haber backup');
assert.equal(fs.statSync(path.join(dir, backups[0])).mode & 0o777, 0o600, 'backup 0600');
console.log('PASS backup con modo 0600');

console.log('\n=== H11: reutilización posterior ===');
// el in-flight se liberó: un tercer refresh debe volver a llamar a fetch
await mod.refreshCtraderToken(true);
assert.equal(fetchCalls, 2, 'tras liberar, un nuevo refresh sí llama a fetch');
console.log('PASS in-flight liberado en finally');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nAUTOTEST OK');
