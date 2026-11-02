import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';
import * as alpha from './src/engine/AlphaModel.js';
import * as macro from './src/engine/MacroImpulse.js';
import * as btTypes from './jarvis-os/src/services/backtestTypes.js';
import * as execution from './src/engine/ExecutionMicrostructure.js';
import * as executionContext from './src/engine/ExecutionContext.js';
import * as friction from './src/engine/FrictionModel.js';
import * as rollover from './src/engine/RolloverRuntimeContext.js';
import * as rolloverPolicy from './src/engine/RolloverTriagePolicy.js';
import { DEFAULT_BIAS_CONFLUENCE } from './src/engine/Types.js';

// Whole real BT caller, parser and calendar helpers. No service-boundary stubs or
// reconstructed algorithm; position/entry gates remain real (disabled fixtures).
const text = fs.readFileSync('jarvis-os/src/services/backtestEngine.ts', 'utf8');
const ast = ts.createSourceFile('bt.ts', text, ts.ScriptTarget.Latest, true);
const names = ['processAlert', 'preParseAlert', 'getSessionForTimestamp', 'getArgentinaDayStr', 'zoneWeightMult'];
const code = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')).map(n => n.getText(ast)).join('\n').replace(/export function/g, 'function');
const { processAlert, preParseAlert } = vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText + '\n({processAlert,preParseAlert})', {
  ...alpha, ...macro, ...btTypes, ...execution, ...executionContext, ...friction, ...rollover, ...rolloverPolicy,
  DEFAULT_BIAS_CONFLUENCE, process: { env: {} }, console, rolloverCleanCloses: new WeakMap()
});
const now = Date.parse('2026-10-20T12:00:00Z');
function fixture() {
  const state = btTypes.emptyState(); const trades: any[] = []; const active = new Map(); const daily = {};
  const config = { ticker: 'EURUSD', entryTrigger: 'CHOCH', minPointsForBuy: 9999, minPointsForSell: 9999,
    sessions: { LONDON: { choch5m: { enabled: false }, choch15m: { enabled: false }, oteChoch5m: { enabled: false }, oteChoch15m: { enabled: false } } } };
  return { state, trades, active, config, send(line: string, at = now) {
    processAlert({ line, timestamp: at, parsed: preParseAlert(line) }, at, state, config, trades, active, daily, 0.0001);
  } };
}

test('full BT caller: native producers → strict hierarchy consumer → actual lifecycle fallback, BUY and SELL', () => {
  for (const dir of ['BUY', 'SELL'] as const) {
    const f = fixture();
    const origin = dir === 'BUY' ? 100 : 200, extreme = dir === 'BUY' ? 200 : 100;
    for (const tf of ['D', '240', '60']) f.send(`EVENTO_CHOCH | EURUSD | TF: ${tf} | Dir: ${dir} | ORIGIN: ${origin} | Precio: ${extreme}`);
    f.send(`EVENTO_CHOCH | EURUSD | TF: 15 | Dir: ${dir} | ORIGIN: ${dir === 'BUY' ? 130 : 170} | Precio: ${dir === 'BUY' ? 180 : 120}`);
    assert.equal(f.state.macroImpulses?.D?.[dir]?.macroTf, 'D');
    assert.equal(f.state.macroImpulses?.['15']?.[dir]?.macroTf, '15');
    const selected = macro.selectMacroImpulse(f.state, dir, '15', now);
    assert.equal(selected?.macroTf, 'D');
    const score = dir === 'BUY' ? f.state.scoreBuy : f.state.scoreSell;
    assert.equal(score.events.find(e => e.id === 'Macro_OTE_Confluence')?.pts, 6);
    assert.equal(f.active.size, 0); assert.equal(f.trades.length, 0, 'disabled strategy not enabled by context');
    // D origin breaks; H4 remains valid and must be selected after a real tick.
    f.state.macroImpulses!.D![dir]!.origin = 150;
    f.send(`PING_PRICE | EURUSD | TF: 5 | Precio: ${dir === 'BUY' ? 170 : 130} | High: ${dir === 'BUY' ? 190 : 180} | Low: ${dir === 'BUY' ? 120 : 110}`, now + 1000);
    assert.equal(f.state.macroImpulses!.D![dir], null);
    assert.equal(macro.selectMacroImpulse(f.state, dir, '5', now + 1000)?.macroTf, '240');
  }
});
