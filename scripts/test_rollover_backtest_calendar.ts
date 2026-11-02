import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import { getRolloverCalendar, registerRolloverSchedule, evaluateRolloverEntryGate } from '../src/engine/RolloverSpreadGate.js';

const source = fs.readFileSync(new URL('../jarvis-os/src/services/backtestEngine.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('backtestEngine.ts', source, ts.ScriptTarget.Latest, true);
let statement: ts.IfStatement | undefined;
function visit(node: ts.Node): void {
    if (ts.isIfStatement(node) && node.expression.getText(ast).includes('rolloverEntryBlock')) statement = node;
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(statement, 'existing backtest rollover gate must be found');
const body = ts.transpileModule(`function probe() { ${statement!.getText(ast)}; return 'ALLOWED'; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function blocked(ticker: string, timestamp: string, enabled = true): boolean {
    const context = vm.createContext({ Date, config: { ticker, rolloverEntryBlock: enabled }, nowMs: Date.parse(timestamp), getRolloverCalendar });
    return vm.runInContext(`${body}; probe()`, context) !== 'ALLOWED';
}

test('an open market without short pauses remains eligible to restore a pending stop', () => {
    const ticker = 'JP225-CALENDAR-NO-PAUSE';
    assert.equal(registerRolloverSchedule(ticker, { scheduleTimeZone: 'UTC', schedule: [
        { startSecond: 86400, endSecond: 5 * 86400 + 22 * 3600 },
    ] }), true);
    const open = getRolloverCalendar(ticker, Date.parse('2026-10-14T13:00:00Z'));
    assert.equal(open.metadataAvailable, true);
    assert.equal(open.marketOpen, true);
    assert.equal(open.pauseStartMs, null);
    assert.equal(open.restoreEligible, true, 'a no-pause schedule orphaned a pending restoration');
    assert.equal(getRolloverCalendar(ticker, Date.parse('2026-10-17T13:00:00Z')).restoreEligible, false);
});

test('a short pause still prevents restoration until exactly reopen plus 15 minutes', () => {
    const ticker = 'EURUSD-CALENDAR-RESTORE-BOUNDARY';
    registerRolloverSchedule(ticker, { scheduleTimeZone: 'America/New_York', schedule: Array.from({ length: 5 }, (_, i) => ({
        startSecond: 61205 + i * 86400, endSecond: 145795 + i * 86400,
    })) });
    const reopen = Date.parse('2026-10-14T21:00:05Z');
    for (const offset of [-1, 0, 15 * 60_000 - 1]) {
        assert.equal(getRolloverCalendar(ticker, reopen + offset).restoreEligible, false);
    }
    assert.equal(getRolloverCalendar(ticker, reopen + 15 * 60_000).restoreEligible, true);
});

test('missing or invalid schedule metadata never permits live entry or restoration', () => {
    const ticker = 'JP225-CALENDAR-MISSING-META';
    const now = Date.parse('2026-10-14T13:00:00Z');
    const config = { live: true, baseSpreadPrice: 1, pipSize: 1 };
    const missing = getRolloverCalendar(ticker, now);
    assert.equal(missing.metadataAvailable, false);
    assert.equal(missing.marketOpen, false);
    assert.equal(missing.restoreEligible, false);
    assert.equal(evaluateRolloverEntryGate(ticker, now, null, config).reason, 'MISSING_SCHEDULE');
    registerRolloverSchedule(ticker, { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }] });
    assert.equal(registerRolloverSchedule(ticker, { scheduleTimeZone: 'invalid-timezone', schedule: [] }), false);
    assert.equal(getRolloverCalendar(ticker, now).restoreEligible, false, 'invalid update retained stale schedule');
    assert.equal(evaluateRolloverEntryGate(ticker, now, null, config).blocked, true);
    const fallback = evaluateRolloverEntryGate('CHFJPY', now, null, config);
    assert.equal(fallback.calendar.marketOpen, true);
    assert.equal(fallback.reason, 'MISSING_SCHEDULE', 'backtest fallback cannot certify a live schedule');
});

test('winter FX blocks real NY rollover rather than previous UTC hour', () => {
    assert.equal(blocked('EURUSD', '2026-01-12T22:15:00Z'), true);
    assert.equal(blocked('EURUSD', '2026-01-12T20:45:00Z'), false);
});
test('gold follows UTC maintenance, not FX fixed window', () => {
    assert.equal(blocked('XAUUSD', '2026-07-13T21:40:00Z'), true);
    assert.equal(blocked('XAUUSD', '2026-07-13T22:40:00Z'), false);
});
test('explicit backtest A/B opt-out is preserved', () => {
    assert.equal(blocked('EURUSD', '2026-01-12T22:15:00Z', false), false);
});
