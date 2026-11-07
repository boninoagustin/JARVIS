import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_REPORT_AGE_MS, isFreshReport, reportScope, reportMetrics, metricDelta, pnlChangeLabel, reportVerdict, mlDiagnostic } from './periodicOptPresentation.ts';
const now = Date.UTC(2026, 10, 7, 19, 0);
test('freshness is inclusive at eight days, fails closed for old/missing/future dates', () => {
    assert.equal(isFreshReport(now - MAX_REPORT_AGE_MS, now), true);
    for (const ts of [undefined, null, NaN, Infinity, 0, now + 1, now - MAX_REPORT_AGE_MS - 1, 'bad date']) assert.equal(isFreshReport(ts, now), false);
});
test('only fresh exact active_tickers members can appear current', () => {
    assert.equal(reportScope({ ticker: 'CHFJPY', timestamp: Date.UTC(2026, 9, 31) }, ['CHFJPY'], now).current, true);
    assert.equal(reportScope({ ticker: 'USDCAD', timestamp: Date.UTC(2026, 7, 22) }, ['USDCAD'], now).current, false);
    assert.equal(reportScope({ ticker: 'CHFJPY31oct', timestamp: now }, ['CHFJPY'], now).current, false);
    assert.equal(reportScope({ ticker: 'CHFJPY', timestamp: now }, [], now).current, false);
});
test('validation fields outrank legacy aliases and never claim independent OOS', () => {
    const p = { expectancy: 0.2 }, b = { expectancy: -0.1 };
    const metrics = reportMetrics({ proposal_validation: p, production_validation: b, proposal_oos: { expectancy: 99 } });
    assert.equal(metrics.proposal, p); assert.equal(metrics.production, b);
    assert.match(metrics.label, /NO es OOS independiente/);
    assert.match(reportMetrics({ evaluation_certificate: { validation_role: 'selection_validation' } }).label, /Validación/);
    assert.match(reportMetrics({ certificate: { validation_role: 'selection_validation' } }).label, /Validación/);
    assert.match(reportMetrics({ proposal_oos: p }).label, /independencia no acreditada/);
    assert.equal(reportMetrics({ proposal_validation: p, production_oos: b }).production, undefined);
});
test('metric delta is proposed minus production with missing/nonfinite values excluded', () => {
    assert.equal(metricDelta(6, 2), 4);
    assert.equal(metricDelta(0, 2), -2);
    for (const bad of [undefined, null, NaN, Infinity, '2']) assert.equal(metricDelta(bad, 2), undefined);
});
test('negative drop ratio is improvement, not a 399 percent loss', () => {
    assert.equal(pnlChangeLabel(-3.99), 'PnL mejora: 399% (vs |base|)');
    assert.match(pnlChangeLabel(0.2), /caída: 20%/);
    assert.match(pnlChangeLabel(NaN), /sin comparación/);
});
test('MC holds are inconclusive; historical recommendations never become operational advice', () => {
    assert.match(reportVerdict('HOLD_MC', true), /disponibilidad \/ error técnico/);
    assert.doesNotMatch(reportVerdict('HOLD_MC', true), /SIN EDGE|desactivar/i);
    assert.match(reportVerdict('RECOMMEND', false), /^Histórico:/);
    assert.match(reportVerdict('RECOMMEND', true), /no autoriza operar/);
    assert.equal(reportVerdict('HOLD_INTEGRITY', true), 'HOLD_INTEGRITY');
});
test('ML displays tested threshold and sample without equating a boolean with deployment', () => {
    const text = mlDiagnostic({ bestGate: { umbral: 0.65, n: 32 }, sinGate: { n: 95 } });
    assert.match(text, /0.65/); assert.match(text, /n gate 32 \/ sin gate 95/);
    assert.match(text, /equivalencia con runtime no acreditada/);
});
test('panel has no mutation APIs/handlers and refreshes every diagnostic together', () => {
    const panel = readFileSync(new URL('../components/PeriodicOptPanel.tsx', import.meta.url), 'utf8');
    assert.doesNotMatch(panel, /\b(setDoc|updateDoc|deleteDoc|writeBatch|runTransaction|confirmActivate|confirmDisable|confirmLoserApply|applyExitPolicy|toggleMLGate)\b/);
    assert.match(panel, /Promise\.allSettled/);
    assert.match(panel, /onClick=\{\(\) => void refreshAll\(\)\}/);
    for (const collection of ['opt_reports', 'auto_state', 'asset_configs', 'active_tickers', 'health_check', 'ml_gate_evals', 'corr_gate_evals', 'timesfm_gate_evals', 'blocked_signals_evals', 'exits_gate_evals', 'rollover_evals']) assert.ok(panel.includes(collection));
    assert.match(panel, /validez actual no acreditada/);
    assert.match(panel, /sin confirmación de recepción del bot/);
    assert.match(panel, /href="\/assets"/);
});
