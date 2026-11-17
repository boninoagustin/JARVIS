import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareEntries } from './backtestEngine.ts';

const payload = 'SYNC_ZONES | TF: 15 | Zones: 2 | TS: 1760000000000';
const run = async (line: string) => {
    const entries = await prepareEntries(new Map([['15', [line]]]) as any);
    return entries.map(e => e.line);
};

test('date-prefixed raw CSV keeps the full payload (detection search regression)', async () => {
    // Regresión 10-nov: sólo se limpiaba si empezaba con comilla; el buscador de
    // detección sintetiza `2026-01-01T..,"PAYLOAD, con comas"` y quedaba sin parsear → 0 trades.
    const lines = await run(`2026-11-17T00:00:00-03:00,"${payload}"`);
    assert.deepEqual(lines, [payload]);
});

test('already-extracted selection payload is not truncated at its first comma', async () => {
    const lines = await run(payload);
    assert.deepEqual(lines, [payload]);
});

test('fully quoted raw CSV row is unwrapped as before', async () => {
    const lines = await run(`"2026-11-17T00:00:00","${payload}"`);
    assert.deepEqual(lines, [payload]);
});

test('non-CSV and unrelated lines stay unparsed instead of inventing entries', async () => {
    assert.deepEqual(await run('texto sin ts'), []);
    assert.deepEqual(await run(''), []);
});
