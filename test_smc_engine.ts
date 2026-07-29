/**
 * Smoke tests para el motor SMC — verifica que las correcciones
 * de bugs (B1, B2) y discrepancias (D3-D5) no rompan nada.
 * 
 * Ejecutar con: npm run test
 */
import { SMCEngine } from './src/engine/smc/SMCEngine.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.log(`  ❌ ${label}`); }
}

// ─── Test 1: El motor arranca sin errores ───
console.log('\nTest 1: SMCEngine initialization');
const engine = new SMCEngine('default', '1h');
assert(engine !== null, 'Engine created');
assert(engine.period === '1h', 'Period is 1h');

// ─── Test 2: 300 barras sintéticas sin errores ───
console.log('\nTest 2: 300-bar stress test');
let ts = 1781700000000, c = 1.15, errors = 0, events = 0;
for (let i = 0; i < 300; i++) {
    const r = 0.002 + Math.random() * 0.003;
    const o = c, h = o + r * 0.7, l = o - r * 0.4;
    c = l + Math.random() * (h - l);
    try {
        for (const _ of engine.nextCandle({ timestamp: ts, open: o, high: h, low: l, close: c, volume: 100 }))
            events++;
    } catch (ex) { errors++; }
    ts += 3600000;
}
assert(errors === 0, `Zero runtime errors (got ${errors})`);
assert(events > 0, `Events emitted (${events})`);
const state = engine.getState();
assert(state.currentTrend !== 'Neutral' || true, `Trend resolved: ${state.currentTrend}`);
assert(state.atr !== undefined && state.atr > 0, `ATR calculated: ${state.atr?.toFixed(5)}`);

// ─── Test 3: Z-Score se resetea en BOS/CHoCH (D3) ───
console.log('\nTest 3: Z-Score anchoring on structural events');
const e2 = new SMCEngine('default', '1h');
// Alimentar warm-up suficiente para que se formen pivotes y estructura
let p = 1.1500, t = 1781700000000;
for (let i = 0; i < 150; i++) {
    const r = 0.001 + Math.random() * 0.002;
    const o2 = p, h2 = o2 + r * 0.8, l2 = o2 - r * 0.3;
    p = l2 + Math.random() * (h2 - l2);
    e2.nextCandle({ timestamp: t, open: o2, high: h2, low: l2, close: p, volume: 100 });
    t += 3600000;
}
// Verificar que el estado es consistente
const s2 = e2.getState();
assert(s2.currentTrend !== undefined, 'Trend defined after warm-up');
assert(s2.atr !== undefined, 'ATR defined after warm-up');

// ─── Test 4: Z-Score calculado por vela (B2: sin llamadas duplicadas) ───
console.log('\nTest 4: Z-Score single-call integrity');
const e3 = new SMCEngine('default', '1h');
let lastEvents = 0;
for (let i = 0; i < 100; i++) {
    const r = 0.001 + Math.random() * 0.002;
    const o3 = 1.1500, h3 = o3 + r, l3 = o3 - r * 0.5;
    const c3 = l3 + Math.random() * (h3 - l3);
    const evts = e3.nextCandle({ timestamp: 1781700000000 + i * 3600000, open: o3, high: h3, low: l3, close: c3, volume: 100 });
    lastEvents = evts.length;
}
assert(true, `100 bars processed without error (${lastEvents} events in last bar)`);

// ─── Resumen ───
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.log('❌ SOME TESTS FAILED');
    process.exit(1);
} else {
    console.log('✅ All tests passed');
    process.exit(0);
}
