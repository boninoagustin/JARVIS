#!/usr/bin/env tsx
/**
 * H06 (auditoría 2026-11-05): los contadores direccionales/rachas deben devolver `null`
 * (lectura desconocida) y NO `0` cuando Firestore falla. El consumidor live lo convierte en
 * bloqueo; el backtest lo trata como 0 para no sesgar el replay.
 *
 * Uso: npx tsx scripts/ops/test_counters_failclosed.ts
 */
import assert from 'node:assert/strict';
import {
    countDailySellsForTicker,
    countDailyBuysForTicker,
    countConsecutiveLossesForAsset,
} from '../../src/engine/PortfolioModel.js';

const now = Date.now();
const badDb = {
    collection: () => ({
        where: () => ({ get: async () => { throw new Error('firestore down (simulado)'); } }),
    }),
} as any;

console.log('=== H06: contadores con Firestore caído ===');

const sells = await countDailySellsForTicker(badDb, 'EURUSD', now, false);
assert.equal(sells, null, 'sells debe ser null');
console.log('PASS countDailySellsForTicker → null');

const buys = await countDailyBuysForTicker(badDb, 'GBPUSD', now, false);
assert.equal(buys, null, 'buys debe ser null');
console.log('PASS countDailyBuysForTicker → null');

const streak = await countConsecutiveLossesForAsset(badDb, 'USDJPY', 'NY', 'SELL', now, {} as any, false);
assert.equal(streak, null, 'streak debe ser null');
console.log('PASS countConsecutiveLossesForAsset → null');

// db ausente: tampoco es "cero"
const noDb = await countDailySellsForTicker(null as any, 'AUDUSD', now, false);
assert.equal(noDb, null, 'sin db debe ser null');
console.log('PASS sin db → null');

// claves distintas para no compartir caché entre casos
const sells2 = await countDailySellsForTicker(badDb, 'NZDUSD', now + 1, false);
assert.equal(sells2, null, 'segunda consulta distinta también null');
console.log('PASS consulta con clave distinta → null');

console.log('\nAUTOTEST OK');
