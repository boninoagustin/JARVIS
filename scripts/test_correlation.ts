// scripts/test_correlation.ts — smoke test del filtro de correlación (series sintéticas)
import { getCorr, evaluateCorrelationGate, __ingestBarForDiag, CORR_TICKERS } from '../src/services/correlation.js';

let fails = 0;
const check = (name: string, cond: boolean, detail = '') => {
    console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!cond) fails++;
};

// ── 1. Serie sintética: EURUSD y GBPUSD co-movientes (correlación positiva fuerte) ──
let a = 1.10, b = 1.30, ts = 1_700_000_000_000;
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let i = 0; i < 600; i++) {
    const shock = (rnd() - 0.5) * 0.0012;          // shock común
    const rA = shock + (rnd() - 0.5) * 0.0004;      // ruido propio
    const rB = shock + (rnd() - 0.5) * 0.0004;
    a *= (1 + rA); b *= (1 + rB);
    ts += 15 * 60 * 1000;
    __ingestBarForDiag('EURUSD', ts, a);
    __ingestBarForDiag('GBPUSD', ts, b);
}
const rho = getCorr('EURUSD', 'GBPUSD');
check('correlación sintética positiva > 0.8', rho !== undefined && rho > 0.8, `ρ=${rho?.toFixed(3)}`);

// ── 2. Serie negativa: USDCAD vs USDJPY (shocks opuestos, series propias sin resetear) ──
let c = 1.36, j = 150.0;
for (let i = 0; i < 600; i++) {
    const shock = (rnd() - 0.5) * 0.0009;
    c *= (1 + shock + (rnd() - 0.5) * 0.0003);
    j *= (1 - shock + (rnd() - 0.5) * 0.0003);
    ts += 15 * 60 * 1000;
    __ingestBarForDiag('USDCAD', ts, c);
    __ingestBarForDiag('USDJPY', ts, j);
}
const rhoNeg = getCorr('USDCAD', 'USDJPY');
check('correlación sintética negativa < −0.7', rhoNeg !== undefined && rhoNeg < -0.7, `ρ=${rhoNeg?.toFixed(3)}`);

// ── 3. Reglas del gate ──
const cfg = { enabled: true, shadow: true, threshold: 0.70, riskParity: true };

// 3a. EURUSD BUY + GBPUSD SELL abierto (positiva + opuestas) → bloqueo
let v = evaluateCorrelationGate('EURUSD', 'BUY', [{ ticker: 'GBPUSD', direction: 'SELL' }], cfg);
check('regla 1: opuestas en par positivo → wouldBlock', v.wouldBlock, JSON.stringify(v.blockedBy));

// 3b. EURUSD SELL + GBPUSD SELL (positiva + iguales) → risk parity 1/1.5
v = evaluateCorrelationGate('EURUSD', 'SELL', [{ ticker: 'GBPUSD', direction: 'SELL' }], cfg);
check('regla 3: misma dirección en par positivo → riskMult 0.667', !v.wouldBlock && Math.abs(v.riskMult - (1 / 1.5)) < 0.001, `riskMult=${v.riskMult.toFixed(3)}`);

// 3c. USDCAD BUY + USDJPY BUY (negativa + iguales) → bloqueo
v = evaluateCorrelationGate('USDCAD', 'BUY', [{ ticker: 'USDJPY', direction: 'BUY' }], cfg);
check('regla 2: iguales en par negativo → wouldBlock', v.wouldBlock, JSON.stringify(v.blockedBy));

// 3d. USDCAD BUY + USDJPY SELL (negativa + opuestas) → OK, sin riesgo
v = evaluateCorrelationGate('USDCAD', 'BUY', [{ ticker: 'USDJPY', direction: 'SELL' }], cfg);
check('negativa + opuestas → sin bloqueo', !v.wouldBlock && v.riskMult === 1);

// 3e. Mismo ticker → ignorado (anti-pyramid se encarga)
v = evaluateCorrelationGate('EURUSD', 'BUY', [{ ticker: 'EURUSD', direction: 'SELL' }], cfg);
check('mismo ticker ignorado', !v.wouldBlock && v.riskMult === 1);

// 3f. Par sin datos → fail-open + degraded
v = evaluateCorrelationGate('XAUUSD', 'BUY', [{ ticker: 'USOIL', direction: 'SELL' }], cfg);
check('par sin datos → fail-open con degraded', !v.wouldBlock && v.degraded, `degraded=${v.degraded}`);

// 3g. Config deshabilitada → no aplica nada
v = evaluateCorrelationGate('EURUSD', 'BUY', [{ ticker: 'GBPUSD', direction: 'SELL' }], { enabled: false });
check('enabled:false → applied=false', !v.applied);

// 3h. Umbral más alto que |ρ| negativo (−0.7 < 0.85) → no bloquea regla 2
v = evaluateCorrelationGate('USDCAD', 'BUY', [{ ticker: 'USDJPY', direction: 'BUY' }], { ...cfg, threshold: 0.95 });
check('threshold 0.95 > |ρ| → no bloquea regla 2', !v.wouldBlock);

// 3i. Umbral bajo (0.6 < |ρ|) → sí bloquea regla 2
v = evaluateCorrelationGate('USDCAD', 'BUY', [{ ticker: 'USDJPY', direction: 'BUY' }], { ...cfg, threshold: 0.6 });
check('threshold 0.6 < |ρ| → bloquea regla 2', v.wouldBlock);

console.log(`\n${fails === 0 ? '🎉 TODOS LOS TESTS PASARON' : `⛔ ${fails} test(s) fallaron`}`);
process.exit(fails === 0 ? 0 : 1);
