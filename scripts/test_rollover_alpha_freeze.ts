import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';
import { resolveExecutionPolicy } from '../src/engine/ExecutionMicrostructure.js';
import { shouldFreezeRolloverObservation } from '../src/engine/RolloverTriagePolicy.js';

// Real declarations only: importing AlphaModel would import telemetry/ML services.
const text = fs.readFileSync(new URL('../src/engine/AlphaModel.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AlphaModel.ts', text, ts.ScriptTarget.Latest, true);
const names = ['evaluateImpulseCore','evaluateMacroStretching','computePoints','eventTtl','EVENT_TTL_MS','EVENT_TTL_FALLBACK_MS','isValidScoreEvent'];
const declarations = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))))).map(n => n.getText(ast).replace(/^export /, '')).join('\n');
const code = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const alpha = vm.runInNewContext(code + '\n({evaluateImpulseCore,evaluateMacroStretching})', { resolveExecutionPolicy, shouldFreezeRolloverObservation, dbg() {}, telemetry: { oteDeath() {} } });
const nowMs = Date.parse('2026-07-13T20:25:00Z');
const freeze = { profile: 'rollover_freeze_v1', ticker: 'EURUSD', metadataAvailable: true, intervals: [{ startMs: nowMs - 60000, endMs: nowMs + 60000 }] } as any;
const state = () => ({ scoreBuy: { points: 0, lastUpdate: 0, events: [] }, scoreSell: { points: 0, lastUpdate: 0, events: [] } });
const leg = () => ({ dir: 'BUY', origin: 90, extreme: 100, createdAt: nowMs - 1000, oteScored: true });

test('Alpha freeze holds the same leg before extreme/origin/expiry mutations, not just emissions', () => {
    const l = leg();
    const before = JSON.stringify(l);
    const ctx = { config: {}, currentSession: 'NY', sessionConfig: null, rolloverFreeze: freeze, observationInterval: { startMs: nowMs - 1000, endMs: nowMs + 1 } };
    assert.equal(alpha.evaluateImpulseCore(l, 100, 120, 80, 'EURUSD', state(), nowMs, ctx).updatedLeg, l);
    assert.equal(JSON.stringify(l), before);
    const expired = { ...leg(), createdAt: nowMs - 9 * 3600000 };
    assert.equal(alpha.evaluateImpulseCore(expired, 100, 120, 80, 'EURUSD', state(), nowMs, ctx).updatedLeg, expired);
    assert.equal(alpha.evaluateImpulseCore({ ...l }, 100, 120, 80, 'EURUSD', state(), nowMs, { ...ctx, rolloverFreeze: undefined }).updatedLeg, null, 'legacy invalidates origin');
    assert.equal(alpha.evaluateMacroStretching(l, 120, 80, nowMs, freeze, ctx.observationInterval), l);
    assert.equal(JSON.stringify(l), before);
    assert.equal(alpha.evaluateMacroStretching(l, 120, 80, nowMs), null, 'legacy macro invalidates');
});
