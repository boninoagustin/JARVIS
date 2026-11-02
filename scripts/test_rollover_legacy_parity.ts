import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';
import { resolveExecutionPolicy } from '../src/engine/ExecutionMicrostructure.js';
import { shouldFreezeRolloverObservation } from '../src/engine/RolloverTriagePolicy.js';

const preRoot = process.env.ROLLOVER_PRE_ROOT;
const preset: any = { name: 'parity', risk_level: 3, asset_type: 'forex', override_choch: true, require_displacement: false, require_fvg_after_ob: false, strict_breaker: false, strict_sweep: false, confirm_close: true, min_score: 0, choch_require_sweep: false, choch_require_momentum: false, valid_bos_displacement: false };
const t0 = Date.parse('2026-07-13T10:00:00Z');
const bars = Array.from({ length: 90 }, (_, i) => {
    const close = 100 + Math.sin(i * Math.PI / 10) * 5 + i * 0.02;
    return { timestamp: t0 + i * 300000, open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 100 + i % 7 };
});
function snapshot(e: any) { return structuredClone(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'rolloverRawObservation'))); }

test('legacy actual SMCEngine events and complete internal mutations equal dirty PRE on each bar', async () => {
    assert.ok(preRoot, 'set ROLLOVER_PRE_ROOT to extracted immutable PRE source');
    const { SMCEngine: Pre } = await import(pathToFileURL(path.join(preRoot!, 'src/engine/smc/SMCEngine.ts')).href);
    const e = new SMCEngine(preset, 'M5');
    const before = new Pre(preset, 'M5');
    const wallClock = Date.now;
    Date.now = () => t0;
    let eventCount = 0;
    try {
        for (const bar of bars) {
            const actual = e.nextCandle({ ...bar });
            const expected = before.nextCandle({ ...bar });
            eventCount += actual.length;
            assert.deepEqual(actual, expected, `events at ${bar.timestamp}`);
            assert.deepEqual(snapshot(e), snapshot(before), `all state at ${bar.timestamp}`);
        }
    } finally { Date.now = wallClock; }
    assert.ok(eventCount > 0, 'legacy parity must exercise positive events');
});

test('freeze excluded shock cannot contaminate accepted post-window events/state; actual positive events resume', () => {
    const e: any = new SMCEngine(preset, 'M5');
    const clean: any = new SMCEngine(preset, 'M5');
    const freeze = { profile: 'rollover_freeze_v1' as const, ticker: 'EURUSD', metadataAvailable: true,
        intervals: [{ startMs: bars[40].timestamp, endMs: bars[42].timestamp }] };
    let postEvents = 0;
    const wallClock = Date.now;
    Date.now = () => t0;
    try {
        for (let i = 0; i < bars.length; i++) {
            const excluded = i >= 40 && i < 42;
            const b = excluded ? { ...bars[i], high: 1000, low: 1, close: 800 } : { ...bars[i] };
            const result = e.nextCandle(b, freeze);
            const expected = excluded ? [] : clean.nextCandle({ ...bars[i] });
            assert.deepEqual(result, expected);
            assert.deepEqual(snapshot(e), snapshot(clean), 'raw frozen extrema never enter any structural/calculator buffer');
            if (i >= 42) postEvents += result.length;
        }
    } finally { Date.now = wallClock; }
    assert.ok(postEvents > 0, 'positive post-freeze events required, not a perpetual HOLD');
});

function alpha(text: string) {
    const ast = ts.createSourceFile('AlphaModel.ts', text, ts.ScriptTarget.Latest, true);
    const names = ['evaluateImpulseCore','evaluateMacroStretching','computePoints','eventTtl','EVENT_TTL_MS','EVENT_TTL_FALLBACK_MS','isValidScoreEvent'];
    const source = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))))).map(n => n.getText(ast).replace(/^export /, '')).join('\n');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    return vm.runInNewContext(code + '\n({evaluateImpulseCore,evaluateMacroStretching})', { resolveExecutionPolicy, shouldFreezeRolloverObservation, dbg() {}, telemetry: { oteDeath() {} } });
}

test('Alpha legacy origin invalidation and stretching equal PRE with absent opt-in', () => {
    assert.ok(preRoot);
    const current = alpha(fs.readFileSync(new URL('../src/engine/AlphaModel.ts', import.meta.url), 'utf8'));
    const previous = alpha(fs.readFileSync(path.join(preRoot!, 'src/engine/AlphaModel.ts'), 'utf8'));
    for (const direction of ['BUY', 'SELL']) for (const low of [85, 95]) for (const high of [99, 115]) {
        const leg = { dir: direction, origin: direction === 'BUY' ? 90 : 110, extreme: 100, createdAt: t0, oteScored: true };
        const state = { scoreBuy: { points: 0, lastUpdate: 0, events: [] }, scoreSell: { points: 0, lastUpdate: 0, events: [] } };
        const args = () => [structuredClone(leg), 100, high, low, 'EURUSD', structuredClone(state), t0 + 1000, { config: {}, currentSession: 'NY', sessionConfig: null }];
        assert.deepEqual(structuredClone(current.evaluateImpulseCore(...args())), structuredClone(previous.evaluateImpulseCore(...args())));
        assert.deepEqual(structuredClone(current.evaluateMacroStretching({ ...leg }, high, low, t0 + 1000)), structuredClone(previous.evaluateMacroStretching({ ...leg }, high, low, t0 + 1000)));
    }
});
