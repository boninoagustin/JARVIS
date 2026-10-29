import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as micro from '../../src/engine/ExecutionMicrostructure.js';
import * as context from '../../src/engine/ExecutionContext.js';
import * as costs from '../../src/engine/ExecutionCosts.js';
import * as targets from '../../src/engine/tp2Cap.js';

// Real production function bodies, only external I/O is substituted. Never import services.
function execute(path: string, names: string[], globals: Record<string, unknown> = {}) {
    const source = fs.readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ''));
    assert.equal(nodes.length, names.length);
    const sandbox: any = { exports: {}, console: { log() {}, warn() {}, error() {} }, ...micro, ...context, ...costs, ...targets, ...globals };
    vm.runInNewContext(ts.transpileModule(nodes.map(n => n.getFullText(ast)).join('\n'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, sandbox);
    return sandbox.exports;
}
const api = execute('src/db/trading.ts', ['freezeExecutionFill', 'manageExecutionPosition']);
const at = Date.parse('2026-07-14T15:00:00Z');
const instrument = { ticker: 'EURUSD', regime: 'FOREX', pipSize: .0001, tickSize: .00001, pipValuePerLotUsd: 10, baseSpreadPips: 1, exitSlippagePips: .2, commissionPerLotSideUsd: 3, minStopDistance: 0, source: 'explicit_model' };
function newTrade() {
    const trade: any = { ticker: 'EURUSD', direction: 'BUY', entryPrice: 1.1001, initialSlPrice: 1.099, slPrice: 1.099, tp1Price: 1.101, tp2Price: 1.104, timestamp: at };
    assert.equal(api.freezeExecutionFill(trade, { policy: micro.resolveExecutionPolicy({ profile: 'microstructure_v1' }), instrument,
        executedPrice: 1.1001, filledAtMs: at, lots: 1, quote: { bid: 1.1, ask: 1.1001, timestampMs: at, source: 'broker' } }), true);
    return trade;
}
function harness(options: { staleReads?: number; step?: number; initialVolume?: number } = {}) {
    const initialVolume = options.initialVolume ?? 10000000;
    let actualVolume = initialVolume, previousVolume = actualVolume, staleReads = 0, requests = 0, reject = false, throwRequest = false;
    let now = at + 1000;
    const ct = execute('src/services/ctrader.ts', ['closePartial', 'verifyVolumeReduced'], {
        isCTraderReady: () => true, getSymbolInfo: async () => ({ stepVolume: options.step ?? 1000 }),
        config: { CTRADER_ACCOUNT_ID: '1' }, PayloadType: { CLOSE_POSITION_REQ: 1 }, setTimeout: (fn: () => void) => { fn(); return 0; },
        ctClient: {
            getState: async () => ({ positions: [{ positionId: 9, tradeData: { symbolId: 1, volume: staleReads-- > 0 ? previousVolume : actualVolume } }] }),
            connection: { request: async (_: unknown, payload: any) => {
                requests++;
                if (reject) return { errorCode: 'REJECTED' };
                previousVolume = actualVolume; actualVolume -= payload.volume;
                staleReads = options.staleReads ?? 4;
                if (throwRequest) throw new Error('transport lost AFTER broker acceptance');
                return {};
            } }
        }
    });
    let trade = newTrade();
    let durable = JSON.parse(JSON.stringify(trade));
    let accountingLots: number | undefined;
    let fail: (fields: any) => boolean = () => false;
    const boundary: any = {
        now: () => now, quote: () => ({ bid: 1.102, ask: 1.1021, timestampMs: now, source: 'broker' }), rolloverBlocked: () => false,
        accounting: async () => ({ lots: 1, remainingLots: accountingLots ?? actualVolume / initialVolume, paidCostsUsd: 0 }),
        partial: (percent: number) => ct.closePartial('9', percent),
        readProtection: async () => ({ exists: true, stopLoss: 1.099 }), amend: async () => false,
        persist: async (fields: any) => { if (fail(fields)) throw new Error('persistence failed'); durable = { ...durable, ...JSON.parse(JSON.stringify(fields)) }; }
    };
    return {
        run: async () => { now += 1000; return api.manageExecutionPosition(trade, { atr14: .001 }, now, .7, boundary); },
        boundary, ct, requests: () => requests, volume: () => actualVolume / initialVolume,
        trade: () => trade, durable: () => durable, restart: () => { trade = JSON.parse(JSON.stringify(durable)); },
        setAccounting: (lots?: number) => { accountingLots = lots; }, setFail: (fn: typeof fail) => { fail = fn; },
        setReject: (value: boolean) => { reject = value; }, setThrow: (value: boolean) => { throwRequest = value; }
    };
}
const lag = harness();
const first = await lag.run();
assert.equal(lag.volume(), .3, 'broker accepted the first actual CLOSE_POSITION_REQ');
assert.equal(lag.trade().executionPartialPending, true, 'accepted but unverified false must preserve durable intent');
assert.equal(lag.durable().executionPartialPending, true);
assert.equal(lag.trade().executionState.partialConfirmed, false, 'timeout is NOT a fill confirmation');
const second = await lag.run();
assert.equal(lag.requests(), 1, 'BUG_LIVE_DUPLICATE_PARTIAL_AFTER_READBACK_LAG: never close 70% of the remainder again');
assert.equal(lag.volume(), .3);
assert.equal(lag.trade().executionState.partialConfirmed, true, 'actual observed reduction reconciles durable intent');
console.log('PASS BUG_LIVE_DUPLICATE_PARTIAL_AFTER_READBACK_LAG', JSON.stringify({ first, second, brokerCloseRequests: lag.requests(), remainingLots: lag.volume() }));

const rejected = harness({ staleReads: 0 });
rejected.setReject(true);
rejected.boundary.partial = async (percent: number) => {
    const ok = await rejected.ct.closePartial('9', percent);
    return ok ? { status: 'confirmed' } : { status: 'rejected' }; // fixture knows the explicit broker rejection
};
assert.equal(await rejected.run(), 'PARTIAL_REJECTED');
assert.equal(rejected.trade().executionPartialPending, false, 'only a definitive rejection may release intent');
rejected.setReject(false);
await rejected.run();
assert.equal(rejected.requests(), 2, 'definitive rejection may retry on the next observation');
assert.equal(rejected.trade().executionState.partialConfirmed, true);
console.log('PASS explicit rejection retry');

const stale = harness({ staleReads: 0 });
stale.setAccounting(1);
await stale.run();
assert.equal(stale.requests(), 1);
assert.equal(stale.trade().executionState.partialConfirmed, false, 'even a true broker return cannot substitute for observed reduction');
assert.equal(stale.durable().executionPartialPending, true);
stale.restart();
await stale.run();
assert.equal(stale.requests(), 1, 'restart plus stale accounting must not resubmit');
stale.setAccounting();
await stale.run();
assert.equal(stale.requests(), 1);
assert.equal(stale.trade().executionState.partialConfirmed, true);

const unknown = harness({ staleReads: 0 });
unknown.boundary.partial = async () => false;
await unknown.run(); unknown.restart(); await unknown.run();
assert.equal(unknown.trade().executionPartialPending, true, 'unknown legacy false stays pending indefinitely without evidence');
assert.equal(unknown.trade().executionState.partialConfirmed, false);
assert.equal(unknown.requests(), 0);

const thrown = harness();
thrown.boundary.partial = async () => { throw new Error('unknown transport outcome'); };
await assert.rejects(thrown.run, /unknown transport outcome/);
assert.equal(thrown.durable().executionPartialPending, true, 'throw cannot clear durable intent');
thrown.restart(); await thrown.run();
assert.equal(thrown.trade().executionState.partialConfirmed, false);
assert.equal(thrown.requests(), 0);

const acceptedThrow = harness();
acceptedThrow.setThrow(true);
await acceptedThrow.run(); acceptedThrow.restart(); await acceptedThrow.run();
assert.equal(acceptedThrow.requests(), 1, 'actual broker acceptance followed by transport exception reconciles without resending');
assert.equal(acceptedThrow.trade().executionState.partialConfirmed, true);

const intentFailure = harness({ staleReads: 0 });
intentFailure.setFail(fields => fields.executionPartialPending === true);
await assert.rejects(intentFailure.run, /persistence failed/);
assert.equal(intentFailure.requests(), 0, 'intent must be durable BEFORE the first broker I/O');
intentFailure.restart(); intentFailure.setFail(() => false); await intentFailure.run();
assert.equal(intentFailure.requests(), 1);

const confirmationFailure = harness({ staleReads: 0 });
confirmationFailure.setFail(fields => fields.executionState?.partialConfirmed === true);
await assert.rejects(confirmationFailure.run, /persistence failed/);
assert.equal(confirmationFailure.requests(), 1);
assert.equal(confirmationFailure.durable().executionPartialPending, true);
assert.equal(confirmationFailure.trade().executionState.partialConfirmed, false);
assert.equal(confirmationFailure.trade().slPrice, 1.099);
assert.equal(confirmationFailure.trade().executionState.lastConfirmedSlPrice, 1.099);
confirmationFailure.restart(); confirmationFailure.setFail(() => false); await confirmationFailure.run();
assert.equal(confirmationFailure.requests(), 1, 'restart after failed confirmation persistence must reconcile, not close again');
assert.equal(confirmationFailure.trade().executionState.partialConfirmed, true);
assert.equal(confirmationFailure.trade().slPrice, 1.099, 'failed amend must not mutate confirmed SL');
assert.equal(confirmationFailure.trade().executionState.lastConfirmedSlPrice, 1.099);

const lotStep = harness({ staleReads: 0, initialVolume: 1000, step: 400 });
await lotStep.run();
assert.equal(lotStep.volume(), .6, 'actual closePartial lot-step floor leaves 60%, not the configured 30%');
assert.equal(lotStep.durable().executionRemainingLots, .6, 'persist actual observed quantity, not an inferred percentage');
assert.equal(lotStep.trade().executionState.partialConfirmed, true);
console.log('PASS unknown/throw/timeouts, intent-before-I/O, persisted restart recovery, delayed accounting, actual lot-step reduction and unchanged SL');

// Two simultaneous alerts through the WHOLE production caller, actual ticker locks,
// manager and cTrader closePartial. Halt after management before unrelated scoring.
const concurrent = harness();
const liveTrade = concurrent.trade();
liveTrade.tradeId = 'CONCURRENT'; liveTrade.ctraderPositionId = '9'; liveTrade.isBacktest = false;
const liveState = { zones: [], marketBias: {} };
const store: any = { tickerLocks: new Map(), globalKillswitches: {}, tickerLastSeen: new Map(), localRadarStates: new Map([['EURUSD', liveState]]), activeTrades: new Map([['CONCURRENT', liveTrade]]) };
const errors: string[] = [];
const wallClock = at+2000;
const persisted: any = {};
const fakeDb = { collection: () => ({ doc: () => ({ update: async (fields: any) => { Object.assign(persisted, JSON.parse(JSON.stringify(fields))); } }) }) };
const broker = { closePartial: concurrent.ct.closePartial,
    getOpenPositions: async () => [{ positionId: '9', tradeData: { volume: concurrent.volume()*10000000 } }],
    getDealsByPosition: async () => [{ filledVolume: 10000000 }], getAccountCurrency: () => 'USD', getLastCloseDealForPosition: async () => null,
    readPositionProtection: async () => ({ exists: true, stopLoss: 1.099 }), modifyStopLoss: async () => false };
const whole = execute('src/db/trading.ts', ['processTradingAlert'], {
    db: fakeDb, globalState: store, manageExecutionPosition: api.manageExecutionPosition,
    Date: class extends Date { static now() { return wallClock; } },
    console: { log() {}, warn: (...args: any[]) => errors.push(args.join(' ')), error: (...args: any[]) => errors.push(args.join(' ')) },
    parseTF: (v: string) => v+'M', getFxDayStartMs: () => at, scheduleRawSignalSave() {}, gcScore() {},
    getConfigForTicker: () => ({ sessionEnabled: false }), parseTVPrice: (v: string) => Number(v), tickFlow: { isSpreadAnomalous: () => false },
    getLastBidAsk: () => ({ bid: 1.102, ask: 1.1021, ts: wallClock }),
    getRolloverCalendar: () => ({ metadataAvailable: true, marketOpen: true }), rolloverJournalRecoveryReady: true, rolloverDWideMap: new Map(),
    runNormalStopMutation: async (_id: any, _trade: any, action: () => Promise<unknown>) => action(),
    getBuffer: () => { throw new Error('OFFLINE_STOP_AFTER_MANAGEMENT'); },
    require: (name: string) => { assert.equal(name, '../services/ctrader.js'); return broker; }
});
const ping = `PING_PRICE | EURUSD | TF: 15 | Precio: 1.102 | TS: ${wallClock}`;
await Promise.all([whole.processTradingAlert(ping, store), whole.processTradingAlert(ping, store)]);
assert.equal(concurrent.requests(), 1, 'concurrent whole PINGs must not send duplicate broker partials');
assert.equal(liveTrade.executionState.partialConfirmed, true);
assert.equal(persisted.executionRemainingLots, .3);
assert.equal(liveTrade.slPrice, 1.099);
assert.equal(liveTrade.executionState.lastConfirmedSlPrice, 1.099);
assert.equal(errors.length, 2, JSON.stringify(errors));
assert.ok(errors.every(error => error.includes('OFFLINE_STOP_AFTER_MANAGEMENT')), JSON.stringify(errors));
console.log('PASS whole processTradingAlert concurrent PINGs: actual locks + real closePartial + real management, one CLOSE only');
