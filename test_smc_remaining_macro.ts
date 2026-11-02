import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';
import { shouldFreezeRolloverObservation } from './src/engine/RolloverTriagePolicy.js';

const files = { live: 'src/db/trading.ts', bt: 'jarvis-os/src/services/backtestEngine.ts' };
function source(file: string) {
  const text = fs.readFileSync(file, 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
function nodes(file: string, predicate: (n: ts.Node, ast: ts.SourceFile) => boolean) {
  const ast = source(file); const found: ts.Node[] = [];
  const visit = (n: ts.Node) => { if (predicate(n, ast)) found.push(n); ts.forEachChild(n, visit); };
  visit(ast); return found.map(n => n.getText(ast));
}
function evaluate(code: string, context: any = {}) {
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(output, context, { timeout: 3000 });
}
const alphaNames = ['evaluateMacroStretching', 'isInsideMacroOteZone', 'TF_RANK', 'addScoreEvent', 'gcScore', 'refreshScoreCache', 'computePoints', 'eventTtl', 'EVENT_TTL_MS', 'EVENT_TTL_FALLBACK_MS', 'isValidScoreEvent'];
const alphaCode = source('src/engine/AlphaModel.ts').statements.filter(n => (ts.isFunctionDeclaration(n) && alphaNames.includes(n.name?.text ?? '')) || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => alphaNames.includes(d.name.getText())))).map(n => n.getText().replace(/^export /, '')).join('\n');
const alpha = evaluate(alphaCode + '\n({' + alphaNames.join(',') + '})', { shouldFreezeRolloverObservation, dbg() {} });
function helpers() {
  if (!fs.existsSync('src/engine/MacroImpulse.ts')) return {};
  const ast = source('src/engine/MacroImpulse.ts');
  const code = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast).replace(/^export /, '')).join('\n');
  const names = ast.statements.filter(ts.isFunctionDeclaration).map(n => n.name?.text).filter(Boolean);
  return evaluate(code + '\n({' + names.join(',') + '})', { ...alpha });
}
const now = Date.parse('2026-10-20T12:00:00Z');
function state() { return { activeImpulseBuy: null, activeImpulseSell: null, activeMacroImpulseBuy: null, activeMacroImpulseSell: null, scoreBuy: { points: 0, lastUpdate: 0, events: [] }, scoreSell: { points: 0, lastUpdate: 0, events: [] }, marketBias: {}, zones: [] } as any; }
function producer(kind: keyof typeof files, s: any, tf: string, dir: string) {
  const branches = nodes(files[kind], (n, ast) => ts.isIfStatement(n) && (/^eventTf === '5' \|\| eventTf === '15'$/.test(n.expression.getText(ast)) || /^eventTf === '15' \|\| eventTf === '60'/.test(n.expression.getText(ast)) || /^eventTf === '60' \|\| eventTf === '240'$/.test(n.expression.getText(ast))));
  assert.ok(branches.length, 'real producer branch found');
  const origin = dir === 'BUY' ? 100 : 200, price = dir === 'BUY' ? 200 : 100;
  evaluate(branches.join('\n'), {
    ...alpha, ...helpers(), state: s, oppositeScore: dir === 'BUY' ? s.scoreSell : s.scoreBuy, eventTf: tf, currentDirection: dir, alertText: `ORIGIN: ${origin} Precio: ${price}`, actualPrice: price,
    nowMs: now, ticker: 'EURUSD', isBootstrap: true, isBacktest: true, parsedExecution: {}, incomingPolicy: {}, prefix: 'EVENTO_CHOCH', readableTf: tf + 'M',
    parseTVPrice: parseFloat, getCurrentSession: () => 'NY', telemetry: { oteDeath() {} }, console: { log() {} }, activeTrades: new Map(), config: {},
    store: { activeTrades: new Map() }
  });
}

test('live producer records M15 execution independently and retains macro identities by TF and direction', () => {
  const s = state();
  for (const dir of ['BUY', 'SELL']) {
    producer('live', s, '15', dir);
    assert.equal(s[dir === 'BUY' ? 'activeImpulseBuy' : 'activeImpulseSell']?.dir, dir);
    assert.equal(s.macroImpulses?.['15']?.[dir]?.macroTf, '15');
    for (const tf of ['D', '240', '60']) producer('live', s, tf, dir);
    for (const tf of ['15', '60', '240', 'D']) {
      assert.equal(s.macroImpulses[tf][dir].macroTf, tf);
      assert.equal(s.macroImpulses[tf][dir].dir, dir);
    }
  }
  assert.notEqual(s.macroImpulses['15'].SELL, s.activeImpulseSell, 'execution lifecycle must not alias macro lifecycle');
});

test('BT real producer keeps M15 execution plus all macro TFs in both directions', () => {
  const s = state();
  for (const dir of ['BUY', 'SELL']) {
    producer('bt', s, '15', dir);
    assert.equal(s[dir === 'BUY' ? 'activeImpulseBuy' : 'activeImpulseSell']?.dir, dir);
    assert.equal(s.macroImpulses?.['15']?.[dir]?.macroTf, '15');
    for (const tf of ['D', '240', '60']) producer('bt', s, tf, dir);
    for (const tf of ['15', '60', '240', 'D']) assert.equal(s.macroImpulses[tf][dir].macroTf, tf);
  }
});

function consumer(kind: keyof typeof files, s: any, dir = 'BUY', tf = '5', origin = 170, extreme = 130, at = now) {
  const ast = source(files[kind]); let statements: ts.Statement[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isBlock(n)) {
      const i = n.statements.findIndex(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === 'activeMacroLeg'));
      if (i >= 0) {
        const rest = [...n.statements.slice(i)]; const end = rest.findIndex(ts.isIfStatement);
        statements = rest.slice(0, end + 1);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(ast); assert.ok(statements.length >= 2, 'real macro consumer with adjacent declarations');
  const activeScore = dir === 'BUY' ? s.scoreBuy : s.scoreSell;
  activeScore.events = []; activeScore.points = 0;
  return evaluate('let macroOteBonus=0;\n' + statements.map(n => n.getText(ast)).join('\n') + '\n({leg:activeMacroLeg,bonus:activeScore.events.find(e=>e.id === "Macro_OTE_Confluence")?.pts ?? 0})', {
    ...alpha, ...helpers(), state: s, currentDirection: dir, eventTf: tf, nowMs: at, chOrigin: origin, chExtreme: extreme, activeScore
  });
}
function macroLeg(tf: string, dir = 'BUY', extra = {}) {
  return { macroTf: tf, dir, origin: dir === 'BUY' ? 100 : 200, extreme: dir === 'BUY' ? 200 : 100, createdAt: now - 1000, ...extra };
}

test('real live/BT consumers select highest valid strict-superior identity, not newest or opposite leg', () => {
  for (const kind of ['live', 'bt'] as const) for (const dir of ['BUY', 'SELL']) {
    const s = state();
    s.macroImpulses = { '15': { [dir]: macroLeg('15', dir) }, '60': { [dir]: macroLeg('60', dir) }, '240': { [dir]: macroLeg('240', dir) }, D: { [dir]: macroLeg('D', dir) } };
    s[dir === 'BUY' ? 'activeMacroImpulseBuy' : 'activeMacroImpulseSell'] = s.macroImpulses['60'][dir];
    assert.equal(consumer(kind, s, dir).leg, s.macroImpulses.D[dir]);
    assert.equal(consumer(kind, s, dir, 'D').leg, null, 'equal timeframe is not macro');
    s.macroImpulses.D[dir].createdAt = now - 24 * 3600000 - 1;
    assert.equal(consumer(kind, s, dir).leg, s.macroImpulses['240'][dir], 'expired D falls to H4');
    s.macroImpulses['240'][dir] = null;
    assert.equal(consumer(kind, s, dir).leg, s.macroImpulses['60'][dir]);
    s.macroImpulses['60'][dir] = null;
    assert.equal(consumer(kind, s, dir, '15').leg, null);
    assert.equal(consumer(kind, s, dir, '5').leg, s.macroImpulses['15'][dir]);
    s.macroImpulses['15'][dir].createdAt = now + 1;
    assert.equal(consumer(kind, s, dir).leg, null, 'future evidence never revalidates context');
  }
});

function update(kind: keyof typeof files, s: any, high: number, low: number, at = now, freeze?: any, interval?: any) {
  const statements = nodes(files[kind], (n, ast) =>
    (ts.isIfStatement(n) && /^state\.activeMacroImpulse(Buy|Sell)$/.test(n.expression.getText(ast))) ||
    (ts.isExpressionStatement(n) && /^(state\.activeMacroImpulse(Buy|Sell) = evaluateMacroStretching|updateMacroImpulses\()/.test(n.getText(ast))));
  assert.ok(statements.length, 'real lifecycle statements found');
  evaluate(statements.join('\n'), { ...alpha, ...helpers(), state: s, highPrice: high, lowPrice: low, nowMs: at,
    macroRollover: { rolloverFreeze: freeze, observationInterval: interval }, rolloverFreeze: freeze, observationInterval: interval });
}

test('real live/BT lifecycle updates every stored leg with actual stretching, invalidation and 24h expiry', () => {
  for (const kind of ['live', 'bt'] as const) for (const dir of ['BUY', 'SELL']) {
    const s = state();
    s.macroImpulses = { D: { [dir]: macroLeg('D', dir, { origin: 150 }) },
      '240': { [dir]: macroLeg('240', dir, { createdAt: now - 24 * 3600000 - 1 }) },
      '60': { [dir]: macroLeg('60', dir) } };
    s[dir === 'BUY' ? 'activeMacroImpulseBuy' : 'activeMacroImpulseSell'] = s.macroImpulses.D[dir];
    update(kind, s, dir === 'BUY' ? 220 : 180, dir === 'BUY' ? 120 : 80);
    assert.equal(s.macroImpulses.D[dir], null, 'origin invalidation clears actual map slot');
    assert.equal(s.macroImpulses['240'][dir], null, 'expiry clears each map slot, not only selected mirror');
    assert.equal(s.macroImpulses['60'][dir].extreme, dir === 'BUY' ? 220 : 80);
    assert.equal(consumer(kind, s, dir).leg, s.macroImpulses['60'][dir]);
    assert.equal(s[dir === 'BUY' ? 'activeMacroImpulseBuy' : 'activeMacroImpulseSell'], s.macroImpulses['60'][dir]);
    const restarted = JSON.parse(JSON.stringify(s));
    assert.equal(consumer(kind, restarted, dir).leg.macroTf, '60');
  }
});

test('restart legacy identity is never guessed; known legacy fallback works only without native map', () => {
  for (const kind of ['live', 'bt'] as const) for (const dir of ['BUY', 'SELL']) {
    const s = state(), field = dir === 'BUY' ? 'activeMacroImpulseBuy' : 'activeMacroImpulseSell';
    const unknown = { ...macroLeg('240', dir) } as any; delete unknown.macroTf;
    s[field] = JSON.parse(JSON.stringify(unknown));
    assert.equal(consumer(kind, s, dir).leg, null, 'unknown TF cannot prove strict superiority');
    update(kind, s, dir === 'BUY' ? 220 : 180, dir === 'BUY' ? 120 : 80);
    assert.equal(s[field].extreme, dir === 'BUY' ? 220 : 80, 'legacy still receives actual lifecycle');
    assert.equal(Object.hasOwn(s[field], 'macroTf'), false);
    s[field] = macroLeg('240', dir);
    assert.equal(consumer(kind, s, dir).leg, s[field], 'known persisted identity is usable');
    s.macroImpulses = {};
    assert.equal(consumer(kind, s, dir).leg, null, 'empty authoritative map must not resurrect stale mirrors');
    delete s.macroImpulses;
    producer(kind, s, '60', dir);
    assert.equal(s.macroImpulses['240'][dir].macroTf, '240', 'first native registration preserves known older hierarchy');
    assert.equal(consumer(kind, s, dir).leg.macroTf, '240');
  }
});

test('real confluence awards existing six points for LTF origin in macro OTE when extreme is outside, correctly anchored BUY/SELL', () => {
  for (const kind of ['live', 'bt'] as const) for (const dir of ['BUY', 'SELL']) {
    const s = state();
    s.macroImpulses = { D: { [dir]: macroLeg('D', dir) } };
    const inside = dir === 'BUY' ? 130 : 170, outside = dir === 'BUY' ? 180 : 120;
    assert.equal(consumer(kind, s, dir, '5', inside, outside).bonus, 6, 'origin inside, extreme outside');
    assert.equal(consumer(kind, s, dir, '5', outside, inside).bonus, 6, 'existing current/extreme path retained');
    assert.equal(consumer(kind, s, dir, '5', outside, outside).bonus, 0, 'both outside');
    assert.equal(consumer(kind, s, dir, 'D', inside, inside).bonus, 0, 'same TF excluded even inside OTE');
    s.macroImpulses.D[dir].dir = dir === 'BUY' ? 'SELL' : 'BUY';
    assert.equal(consumer(kind, s, dir, '5', inside, inside).bonus, 0, 'wrong direction cannot anchor macro');
  }
});

test('real lifecycle never changes future legacy legs using earlier observations', () => {
  for (const kind of ['live', 'bt'] as const) for (const dir of ['BUY', 'SELL']) {
    const s = state(), field = dir === 'BUY' ? 'activeMacroImpulseBuy' : 'activeMacroImpulseSell';
    s[field] = macroLeg('240', dir, { createdAt: now + 1000 });
    const before = JSON.stringify(s[field]);
    update(kind, s, 300, 50);
    assert.equal(JSON.stringify(s[field]), before);
    assert.equal(consumer(kind, s, dir).leg, null);
  }
});
