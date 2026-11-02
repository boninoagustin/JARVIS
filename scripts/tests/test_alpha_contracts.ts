import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the entire actual Alpha module, replacing only ML/telemetry service boundaries.
// Pure execution, context, costs, types and rollover dependencies remain real.
const root = path.resolve(process.env.ALPHA_SOURCE_ROOT ?? process.cwd());
const pure = async (file: string) => import(pathToFileURL(path.join(root, 'src/engine', file)).href);
const dependencies = Object.assign({}, ...await Promise.all([
    'ExecutionMicrostructure.ts', 'ExecutionContext.ts', 'ExecutionCosts.ts',
    'tp2Cap.ts', 'Types.ts', 'RolloverTriagePolicy.ts',
].map(pure)));
const source = fs.readFileSync(path.join(root, 'src/engine/AlphaModel.ts'), 'utf8');
const ast = ts.createSourceFile('AlphaModel.ts', source, ts.ScriptTarget.Latest, true);
const stripped = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getFullText(ast)).join('\n');

export function loadAlpha(ml: 'off' | 'approve' | 'reject' = 'off') {
    const output: any = {};
    const deaths: string[] = [];
    let predictions = 0;
    const math = Object.create(Math);
    math.random = () => 0.314159265;
    vm.runInNewContext(ts.transpileModule(stripped, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText, {
        ...dependencies, exports: output, Math: math, process: { env: {} },
        console: { log() {}, warn() {}, error() {} },
        telemetry: { oteDeath(_t: string, _s: string, _k: string, reason: string) { deaths.push(reason); }, oteExec() {}, oteMlReject() {} },
        isMLActive: () => ml !== 'off',
        mlPredict: () => { predictions++; return ml === 'off' ? null : { approved: ml === 'approve', probability: ml === 'approve' ? .9 : .1, threshold: .5 }; },
    });
    return { alpha: output, deaths, predictions: () => predictions };
}

export const NOW = 1_000_000_000;
export function fixture(direction = 'BUY', family = 'CHoCH', tf = '5M') {
    const buy = direction === 'BUY';
    const { alpha, deaths, predictions } = loadAlpha();
    const state = alpha.emptyState();
    state.atr14 = .003;
    state.previousPrice = 1.105;
    const leg = { dir: direction, origin: buy ? 1.100 : 1.110, extreme: buy ? 1.110 : 1.100,
        createdAt: NOW - 600_000, isValidated: true, chochPoints: 12, chochEvents: [`${family}_${tf}`] };
    const config = { entryTrigger: 'SMART', oteEntryPercent: 50, slBufferPercent: 0, fixedRR: 2 };
    const key = `ote${family === 'CHoCH' ? 'Choch' : 'Bos'}${tf.toLowerCase()}`;
    const session: any = { [key]: { enabled: true, minScore: 8, entryPercent: 50 } };
    return { alpha, state, leg, config, key, session, deaths, predictions };
}
export const evaluate = (f: ReturnType<typeof fixture>, alpha = f.alpha) => alpha.evaluateImpulseCore(
    f.leg, 1.105, 1.106, 1.104, 'EURUSD', f.state, NOW,
    { config: f.config, sessionConfig: f.session, currentSession: 'NY', prevHigh: 1.106, prevLow: 1.104 },
);

test('disabled OTE cannot emit even when SMART validates the setup', () => {
    const positive = fixture();
    assert.equal(evaluate(positive).triggerOte, true, 'positive control must reach the emission branch');
    const disabled = fixture();
    disabled.session[disabled.key].enabled = false;
    const result = evaluate(disabled);
    assert.notEqual(result.triggerOte, true, 'explicit disabled trigger must veto OTE');
    assert.equal(result.updatedLeg, disabled.leg, 'disabled trigger must not destroy pending setup');
    assert.notEqual((disabled.leg as any).oteScored, true, 'disabled trigger must not consume setup');
    assert.equal(disabled.state.scoreBuy.events.length, 0, 'disabled trigger must not add OTE score');
});

test('old CHoCH plus a later unrelated score update cannot invalidate a new leg', () => {
    const f = fixture();
    f.state.scoreSell.events = [
        { id: 'CHoCH_1H', pts: 3, tf: '60', ts: f.leg.createdAt - 60_000 },
        { id: 'OB_Oro_5M', pts: 2, tf: '5', ts: NOW - 1_000 },
    ];
    f.state.scoreSell.lastUpdate = NOW - 1_000;
    const result = evaluate(f);
    assert.notEqual(result.updatedLeg, null, 'old CHoCH must not become posterior through another event');
    assert.equal(result.triggerOte, true, 'valid pending OTE still reaches emission');
    assert.ok(!f.deaths.includes('chochContrario'));
});

test('explicit disabled veto spans BUY/SELL, CHoCH/BOS, M5/M15 and all OTE modes even with approving ML', () => {
    for (const direction of ['BUY', 'SELL']) for (const family of ['CHoCH', 'BOS'])
    for (const tf of ['5M', '15M']) for (const mode of ['SMART', 'BOTH', 'OTE'])
    for (const ml of ['off', 'approve'] as const) {
        const f = fixture(direction, family, tf);
        f.config.entryTrigger = mode;
        f.session[f.key].enabled = false;
        const model = loadAlpha(ml);
        const result = evaluate(f, model.alpha);
        assert.notEqual(result.triggerOte, true, `${direction}/${family}/${tf}/${mode}/${ml}`);
        assert.notEqual((f.leg as any).oteScored, true);
        assert.equal(model.predictions(), 0, 'explicit veto must run before ML');
        assert.equal(f.state.scoreBuy.events.length + f.state.scoreSell.events.length, 0);
    }
});

test('session family fallback veto applies but an exact enabled trigger takes precedence', () => {
    for (const family of ['CHoCH', 'BOS']) {
        const f = fixture('BUY', family);
        const generic = family === 'CHoCH' ? 'oteChoch' : 'oteBos';
        f.session[generic] = { enabled: false, minScore: 8 };
        assert.equal(evaluate(f).triggerOte, true, 'exact enabled trigger wins over generic disabled');
        const fallback = fixture('BUY', family);
        delete fallback.session[fallback.key];
        fallback.session[generic] = { enabled: false, minScore: 8 };
        assert.notEqual(evaluate(fallback).triggerOte, true, 'generic disabled applies when exact is missing');
    }
});

test('absent enabled flag and absent session preserve the existing mode fallback', () => {
    for (const mode of ['SMART', 'BOTH', 'OTE']) for (const missing of ['flag', 'trigger', 'session']) {
        const f = fixture();
        f.config.entryTrigger = mode;
        if (missing === 'flag') delete f.session[f.key].enabled;
        if (missing === 'trigger') delete f.session[f.key];
        if (missing === 'session') f.session = undefined;
        assert.equal(evaluate(f).triggerOte, true, `${mode}/${missing}`);
    }
});

test('ML rejection and ordinary minimum-score validation still veto enabled OTE', () => {
    const f = fixture();
    assert.notEqual(evaluate(f, loadAlpha('reject').alpha).triggerOte, true);
    assert.equal((f.leg as any).mlRejectedOnce, true);
    const low = fixture(); low.session[low.key].minScore = 30;
    assert.notEqual(evaluate(low).triggerOte, true);
});

test('a genuinely posterior available CHoCH still invalidates regardless of score cache timestamp', () => {
    for (const direction of ['BUY', 'SELL']) for (const id of ['CHoCH_1H', 'CHOCH_15M']) {
        const f = fixture(direction);
        const opposite = direction === 'BUY' ? f.state.scoreSell : f.state.scoreBuy;
        opposite.events = [{ id, pts: 3, tf: '60', ts: f.leg.createdAt + 1 }];
        opposite.lastUpdate = f.leg.createdAt - 1;
        assert.equal(evaluate(f).updatedLeg, null, `${direction}/${id}`);
        assert.deepEqual(f.deaths, ['chochContrario']);
    }
});

test('old, simultaneous, future, missing-time and non-CHoCH evidence cannot cause posterior-CHoCH invalidation', () => {
    for (const direction of ['BUY', 'SELL']) for (const which of ['old', 'equal', 'future', 'missing', 'other']) {
        const f = fixture(direction);
        const opposite = direction === 'BUY' ? f.state.scoreSell : f.state.scoreBuy;
        const event: any = { id: which === 'other' ? 'OB_Oro_1H' : 'CHoCH_1H', pts: 3, tf: '60',
            ts: which === 'old' ? f.leg.createdAt - 1 : which === 'equal' ? f.leg.createdAt : which === 'future' ? NOW + 1 : NOW - 1 };
        if (which === 'missing') delete event.ts;
        opposite.events = [event]; opposite.lastUpdate = NOW;
        const result = evaluate(f);
        assert.notEqual(result.updatedLeg, null, `${direction}/${which}`);
        assert.ok(!f.deaths.includes('chochContrario'));
    }
});

test('explicit session veto also holds in opt-in microstructure with a valid executable snapshot', () => {
    for (const direction of ['BUY', 'SELL']) for (const enabled of [true, false]) {
        const f = fixture(direction);
        const bar = { tf: '5', openTimeMs: NOW, closeTimeMs: NOW + 300_000, availableAtMs: NOW,
            open: 1.105, high: 1.106, low: 1.104, close: 1.105, closed: false };
        f.state.executionContext = { schema: 1, ticker: 'EURUSD', byTf: { '5': {
            atrSeed: 0, atrSamples: 14, atr14: .003, currentBar: bar,
            lastClosedBar: { ...bar, openTimeMs: NOW - 300_000, closeTimeMs: NOW, closed: true },
        } }, quote: { bid: direction === 'SELL' ? 1.105 : 1.1049,
            ask: direction === 'BUY' ? 1.105 : 1.1051, timestampMs: NOW, source: 'broker' }, lastObservedAtMs: NOW };
        (f.config as any).executionPolicy = { profile: 'microstructure_v1', smart: false, targets: false };
        f.session[f.key].enabled = enabled;
        assert.equal(evaluate(f).triggerOte === true, enabled, direction);
        if (!enabled) assert.notEqual((f.leg as any).oteScored, true);
    }
});

test('origin breach, expiry and overwhelming opposite pressure retain their independent vetoes', () => {
    const expired = fixture(); expired.leg.createdAt = NOW - 9 * 3_600_000;
    assert.equal(evaluate(expired).updatedLeg, null);
    const origin = fixture(); origin.leg.origin = 1.1045;
    assert.equal(evaluate(origin).updatedLeg, null);
    const pressure = fixture();
    pressure.state.scoreSell.events = [{ id: 'OB_Oro_1H', pts: 35, tf: '60', ts: NOW - 1 }];
    pressure.state.scoreSell.lastUpdate = NOW - 1; pressure.leg.chochPoints = 8;
    assert.equal(evaluate(pressure).updatedLeg, null);
    assert.deepEqual(pressure.deaths, ['opuesta']);
});
