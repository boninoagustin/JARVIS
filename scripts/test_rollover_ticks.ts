import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const modulePath = new URL('./rollover_ticks.ts', import.meta.url);
const helpers: any = existsSync(modulePath) ? await import('./rollover_ticks.js') : {};

test('decodes actual cTrader delta sample in chronological order', () => {
    assert.equal(typeof helpers.decodeTickPage, 'function', 'decoder must exist');
    const ticks = helpers.decodeTickPage([
        { timestamp: 1791926131731, tick: 111997 },
        { timestamp: -10265, tick: -2 },
    ]);
    assert.deepEqual(ticks, [
        { ts: 1791926121466, price: 1.11995 },
        { ts: 1791926131731, price: 1.11997 },
    ]);
});

test('splits incomplete pages without losing boundary ticks', async () => {
    assert.equal(typeof helpers.collectTickRange, 'function', 'collector must exist');
    const requests: any[] = [];
    const result = await helpers.collectTickRange(async (from: number, to: number) => {
        requests.push([from, to]);
        if (from === 1000 && to === 1003) return { ticks: [{ timestamp: 1003, tick: 110003 }], hasMore: true };
        if (from === 1000) return { ticks: [{ timestamp: 1001, tick: 110001 }, { timestamp: -1, tick: -1 }], hasMore: false };
        return { ticks: [{ timestamp: 1003, tick: 110003 }, { timestamp: -1, tick: -1 }], hasMore: false };
    }, 1000, 1003);
    assert.deepEqual(requests, [[1000, 1003], [1000, 1001], [1002, 1003]]);
    assert.equal(result.ticks.length, 4);
    assert.deepEqual(result.ticks.map((x: any) => x.ts), [1000, 1001, 1002, 1003]);
});
