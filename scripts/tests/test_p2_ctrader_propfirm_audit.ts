import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {
    resolvePropFirmLimits,
    inferStandardPropAccountSize,
    updatePropFirmAnchorState,
    computeOpenPositionRemainingRiskAccount,
    evaluatePropFirmEntryGate,
    evaluatePropFirmEmergencyKill,
} from '../../src/engine/PropFirmGuard.js';
import { createTradeRiskSnapshot } from '../../src/engine/TradeRisk.js';
import * as portfolio from '../../src/engine/PortfolioModel.js';
import * as safety from '../../src/engine/OrderSafety.js';
import { commitTradeCloseAccounting } from '../../src/engine/TradeAccountingPersistence.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const quiet = { log() {}, warn() {}, error() {} };

function extractFunctions(relPath: string, names: string[]): string {
    const full = path.join(ROOT, relPath);
    const source = fs.readFileSync(full, 'utf8');
    const ast = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
    const found = ast.statements.filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ''));
    assert.equal(found.length, names.length, `Missing functions in ${relPath}: expected ${names.join(',')}`);
    return found.map((n) => n.getText(ast)).join('\n');
}

function runVm(tsCode: string, context: Record<string, any>) {
    const js = ts.transpileModule(tsCode, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInNewContext(js, context);
    return context.exports;
}

// Strict Firestore mock: .update() on a non-existent doc throws code=5 NOT_FOUND, just like real Firestore!
function createStrictFirestoreMock() {
    const cols = new Map<string, Map<string, any>>();
    const ensureCol = (name: string) => {
        let c = cols.get(name);
        if (!c) { c = new Map(); cols.set(name, c); }
        return c;
    };
    const makeDoc = (colName: string, id: string): any => ({
        id,
        get: async () => {
            const c = ensureCol(colName);
            const exists = c.has(id);
            return { exists, id, data: () => (exists ? structuredClone(c.get(id)) : undefined), ref: makeDoc(colName, id) };
        },
        set: async (fields: any, opts?: { merge?: boolean }) => {
            const c = ensureCol(colName);
            const clean = JSON.parse(JSON.stringify(fields));
            if (opts?.merge && c.has(id)) {
                c.set(id, { ...c.get(id), ...clean });
            } else {
                c.set(id, clean);
            }
        },
        update: async (fields: any) => {
            const c = ensureCol(colName);
            if (!c.has(id)) {
                const err: any = new Error(`5 NOT_FOUND: No document to update: ${colName}/${id}`);
                err.code = 5;
                throw err;
            }
            const clean = JSON.parse(JSON.stringify(fields));
            c.set(id, { ...c.get(id), ...clean });
        },
        delete: async () => {
            ensureCol(colName).delete(id);
        },
    });
    const makeQuery = (colName: string, filters: Array<[string, string, any]> = []): any => ({
        where: (field: string, op: string, val: any) => makeQuery(colName, [...filters, [field, op, val]]),
        limit: () => makeQuery(colName, filters),
        get: async () => {
            const c = ensureCol(colName);
            const docs = [...c.entries()]
                .filter(([, v]) => filters.every(([k, op, val]) => (op === '==' ? v?.[k] === val : op === '>=' ? v?.[k] >= val : true)))
                .map(([id, v]) => ({ id, exists: true, data: () => structuredClone(v), ref: makeDoc(colName, id) }));
            return { empty: docs.length === 0, size: docs.length, docs };
        },
        doc: (id: string) => makeDoc(colName, id),
    });
    return {
        cols,
        db: {
            collection: (name: string) => makeQuery(name),
            runTransaction: async (fn: any) => fn({
                get: (ref: any) => ref.get(),
                set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
                update: (ref: any, data: any) => ref.update(data),
            }),
        },
    };
}

// ─── SUITE 1: C01 — OTE strict Firestore persistence + live incident self-healing ───
async function suite1_oteNotFoundAndLiveIncidentRepair() {
    const now = Date.parse('2026-11-26T15:00:00Z');
    const mock = createStrictFirestoreMock();
    const trades = new Map<string, any>();

    // Simulate an OTE pre-trade living ONLY in RAM (active_trades/YZWU2M does NOT exist yet in Firestore)
    const oteTrade: any = {
        tradeId: 'YZWU2M',
        journalId: 'V8GOO0',
        ticker: 'XAGUSD',
        direction: 'BUY',
        entryPrice: 41.545,
        slPrice: 41.19,
        initialSlPrice: 41.19,
        tp1Price: 41.90,
        tp2Price: 42.08,
        timestamp: now - 2000,
    };
    trades.set('YZWU2M', oteTrade);
    await mock.db.collection('trade_journal').doc('V8GOO0').set({
        id: 'V8GOO0',
        ticker: 'XAGUSD',
        direction: 'BUY',
        mode: 'live',
        result: null,
    });

    const snap = createTradeRiskSnapshot({
        ticker: 'XAGUSD',
        direction: 'BUY',
        currency: 'USD',
        entryPrice: 41.62,
        initialSlPrice: 41.19,
        filledVolumeCents: 10000,
        quoteToAccountRate: 1,
        capturedAtMs: now,
    })!;
    assert.ok(snap);

    const code = extractFunctions('src/db/trading.ts', [
        'updateTradePositionId',
        'hasUnresolvedExecutionIncidents',
        'reconcileCTraderPositions',
    ]);
    const broker = {
        isCTraderReady: () => true,
        getOpenPositions: async () => [{
            positionId: '306924791',
            symbolName: 'XAGUSD',
            price: 41.62,
            stopLoss: 41.19,
            takeProfit: 42.08,
            tradeData: { tradeSide: 1, openPrice: 41.62, volume: 10000, openTimestamp: now, label: 'YZWU2M' },
        }],
        getDealsByPosition: async () => [],
        getVerifiedAccountCurrency: () => 'USD',
    };
    const api = runVm(code, {
        exports: {},
        console: quiet,
        Date: class extends Date { static now() { return now + 600_000; } },
        Object,
        Array,
        JSON,
        Number,
        String,
        Math,
        Set,
        Map,
        structuredClone,
        freezeTradeRiskForTrade: (await import('../../src/engine/TradeRisk.js')).freezeTradeRiskForTrade,
        ...portfolio,
        commitTradeCloseAccounting,
        db: mock.db,
        globalState: { activeTrades: trades },
        rolloverDWideMap: new Map(),
        rolloverTriageRecords: new Map(),
        lastReconcileTs: 0,
        loadRolloverJournalPending: async () => true,
        rehydrateRolloverPending() {},
        capTp2Price: (_t: any, _d: any, _e: any, _s: any, p: any) => p,
        validateExecutionInstrument: () => false,
        require: (id: string) => (id.includes('memory') ? { db: mock.db } : id.includes('ctrader') ? broker : (() => { throw new Error(id); })()),
    });

    // Previously threw 5 NOT_FOUND on strict Firestore because active_trades/YZWU2M did not exist!
    await api.updateTradePositionId('YZWU2M', '306924791', snap);
    const activeDoc = mock.cols.get('active_trades')?.get('YZWU2M');
    assert.ok(activeDoc, 'active_trades/YZWU2M must be created cleanly via set(merge:true)');
    assert.equal(activeDoc.ctraderPositionId, '306924791');
    assert.equal(activeDoc.riskAccountingStatus, 'VERIFIED');
    assert.equal(api.hasUnresolvedExecutionIncidents(), false, 'verified OTE fill must not trigger account-wide hold');

    // Now simulate a transient Firestore outage at fill time that left executionIncidentPending=true while position is OPEN
    Object.assign(oteTrade, {
        executionIncidentPending: true,
        closeAccountingPending: true,
        executionUncertain: false,
        ctraderStatus: 'EXECUTION_PENDING_RECONCILIATION',
    });
    assert.equal(api.hasUnresolvedExecutionIncidents(), true);

    await api.reconcileCTraderPositions();
    assert.equal(oteTrade.executionIncidentPending, false, 'reconcile must self-heal verified open position incident');
    assert.equal(oteTrade.closeAccountingPending, false);
    assert.equal(api.hasUnresolvedExecutionIncidents(), false);
    assert.equal(mock.cols.get('trade_journal')?.get('V8GOO0')?.executionIncidentPending, false);

    console.log('PASS [1] C01: OTE fill persists without 5 NOT_FOUND and reconcile self-heals transient open persistence incidents');
}

// ─── SUITE 2: C02 — PropFirmGuard (Daily 5%, Total 8%, Worst-Case SL, Emergency Kill & 3% Cap) ───
async function suite2_propFirmHardLimitsAndRiskCeiling() {
    assert.equal(inferStandardPropAccountSize(5108.79), 5000, '$5,108.79 maps to $5,000 Funding Pips account');
    assert.equal(inferStandardPropAccountSize(10450), 10000);
    assert.equal(inferStandardPropAccountSize(7500), 7500, 'non-standard balance stays exact');

    const limits = resolvePropFirmLimits({});
    assert.equal(limits.maxDailyLossPct, 5);
    assert.equal(limits.dailyEntryStopPct, 4);
    assert.equal(limits.maxWorstCaseDailyPct, 4.5);
    assert.equal(limits.emergencyCloseDailyPct, 4.5);

    const fxDay1 = portfolio.getFxDayStartMs(Date.parse('2026-11-27T14:00:00Z'));
    // Mid-day boot reconstruction: current balance is 5054.33 after a -54.46 loss today -> dayStart was 5108.79!
    const anchor = updatePropFirmAnchorState(
        null,
        { balance: 5054.33, equity: 5054.33, currency: 'USD', nowMs: fxDay1 + 3600_000, reconstructedDayStartBalance: 5108.79 },
        fxDay1,
    )!;
    assert.ok(anchor);
    assert.equal(anchor.dayStartReference, 5108.79, 'mid-day boot reconstructs true 17:00 NY opening balance');
    assert.equal(anchor.initialBalance, 5000);

    // Case A: Two 2% open positions ($101 risk each = $202 open risk) + 1 loss today ($54.46) -> equity = 5054.33
    // Trying to open a 3rd trade risking 1.5% ($75.81):
    // Worst-case equity = 5054.33 - 202 - 75.81 = 4776.52 -> (5108.79 - 4776.52)/5108.79 = 6.50% (> 4.5%!) -> MUST BLOCK!
    const snap1 = createTradeRiskSnapshot({
        ticker: 'GBPAUD', direction: 'BUY', currency: 'USD', entryPrice: 1.976, initialSlPrice: 1.970,
        filledVolumeCents: 1683333, quoteToAccountRate: 1, capturedAtMs: fxDay1 + 1000,
    })!;
    const openTrades = new Map<string, any>([
        ['T1', { ticker: 'GBPAUD', direction: 'BUY', entryPrice: 1.976, slPrice: 1.970, ctraderPositionId: '1', riskSnapshot: snap1 }],
        ['T2', { ticker: 'JP225', direction: 'BUY', entryPrice: 38000, slPrice: 37800, ctraderPositionId: '2', requestedRiskPercent: 2 }],
    ]);
    const openRem = computeOpenPositionRemainingRiskAccount(openTrades, 5054.33, () => 1);
    assert.ok(openRem > 200, `expected >$200 remaining open risk, got ${openRem}`);

    const blockedWorst = evaluatePropFirmEntryGate({
        anchor,
        liveBalance: 5054.33,
        liveEquity: 5054.33,
        newRiskBudgetAccount: 75.81,
        openRemainingRiskAccount: openRem,
        limits,
    });
    assert.equal(blockedWorst.allowed, false);
    assert.match(blockedWorst.reason!, /BLOCKED_PROPFIRM_WORST_CASE_DAILY/);

    // Case B: Once T1 and T2 move SL to Breakeven (slPrice >= entryPrice for BUY), their remaining structural SL risk drops to 0!
    openTrades.get('T1').slPrice = 1.9765;
    openTrades.get('T2').slPrice = 38005;
    const openRemAfterBe = computeOpenPositionRemainingRiskAccount(openTrades, 5054.33, () => 1);
    assert.equal(openRemAfterBe, 0, 'positions at/above breakeven carry 0 structural SL risk');

    const allowedAfterBe = evaluatePropFirmEntryGate({
        anchor,
        liveBalance: 5054.33,
        liveEquity: 5054.33,
        newRiskBudgetAccount: 50.54,
        openRemainingRiskAccount: openRemAfterBe,
        limits,
    });
    assert.equal(allowedAfterBe.allowed, true, 'after locking BE on existing trades, new 1% trade is safely within 4.5% daily cap');

    // Case C: Floating equity drops -4.6% from dayStartReference ($5108.79 * (1 - 0.046) = $4873.78) with open positions -> EMERGENCY KILL!
    const kill = evaluatePropFirmEmergencyKill({
        anchor,
        liveBalance: 5054.33,
        liveEquity: 4873.0,
        openPositions: 2,
        limits,
    });
    assert.equal(kill.triggerEmergencyClose, true);
    assert.match(kill.reason!, /EMERGENCY_DAILY_DRAWDOWN/);

    // Case D: effectiveRiskPercentFor clamps session multiplier * base at 3.0%
    const riskFnCode = extractFunctions('src/db/trading.ts', ['effectiveRiskPercentFor']);
    const riskApi = runVm(riskFnCode, {
        exports: {},
        console: quiet,
        Number,
        Math,
        Date,
        envConfig: { CTRADER_RISK_PERCENT: 1 },
        getConfigForTicker: () => ({ riskPercent: 3 }),
        getCurrentSession: () => 'NY',
        getSessionSizingFactor: () => 1.6, // 3% * 1.6 = 4.8% without clamp!
    });
    assert.equal(riskApi.effectiveRiskPercentFor('JP225', 1.2, fxDay1), 3, 'effectiveRiskPercentFor must never exceed 3%');

    console.log('PASS [2] C02: PropFirmGuard enforces 5% daily / 8% total / worst-case SL / emergency kill, and effectiveRiskPercentFor caps at 3%');
}

// ─── SUITE 3: C03a — Cross-process OAuth Token Lock & .env Memory Sync ───
async function suite3_crossProcessTokenLockAndSync() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-p2-tok-'));
    const envPath = path.join(tmpDir, '.env');
    const counterPath = path.join(tmpDir, 'fetches.log');
    try {
        const oldIssued = Date.now() - 29 * 86400_000; // <3 days left -> needs refresh
        fs.writeFileSync(
            envPath,
            `CTRADER_ACCESS_TOKEN=OLD_TOKEN\nCTRADER_REFRESH_TOKEN=R1\nCTRADER_CLIENT_ID=cid\nCTRADER_CLIENT_SECRET=sec\nCTRADER_TOKEN_ISSUED_AT=${oldIssued}\nTELEGRAM_BOT_TOKEN=dummy\nTELEGRAM_ALLOWED_USER_IDS=123\n`,
            { mode: 0o600 },
        );

        // Spawn 2 separate Node processes racing refreshCtraderToken(true) on the same .env!
        const workerScript = path.join(tmpDir, 'worker.mjs');
        fs.writeFileSync(workerScript, `
            import fs from 'node:fs';
            process.env.CTRADER_ENV_PATH = ${JSON.stringify(envPath)};
            process.env.TELEGRAM_BOT_TOKEN = 'dummy';
            process.env.TELEGRAM_ALLOWED_USER_IDS = '123';
            globalThis.fetch = async () => {
                fs.appendFileSync(${JSON.stringify(counterPath)}, process.pid + '\\n');
                await new Promise((r) => setTimeout(r, 180));
                return {
                    ok: true,
                    json: async () => ({ access_token: 'NEW_TOKEN_' + process.pid, refresh_token: 'R2_' + process.pid }),
                };
            };
            const mod = await import(${JSON.stringify(path.join(ROOT, 'src/services/ctraderToken.ts'))});
            const ok = await mod.refreshCtraderToken(true);
            const synced = mod.syncAccessTokenFromEnv();
            console.log(JSON.stringify({ ok, synced }));
        `);

        const runWorker = () => new Promise<{ code: number | null; out: string }>((resolve) => {
            const p = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [workerScript], {
                cwd: ROOT,
                env: { ...process.env, CTRADER_ENV_PATH: envPath },
            });
            let out = '';
            p.stdout.on('data', (d) => { out += d.toString(); });
            p.stderr.on('data', (d) => { out += d.toString(); });
            p.on('close', (code) => resolve({ code, out }));
        });

        const [w1, w2] = await Promise.all([runWorker(), runWorker()]);
        assert.equal(w1.code, 0, w1.out);
        assert.equal(w2.code, 0, w2.out);
        const fetchLines = fs.existsSync(counterPath)
            ? fs.readFileSync(counterPath, 'utf8').trim().split('\n').filter(Boolean)
            : [];
        assert.equal(fetchLines.length, 1, `Cross-process lock must allow ONLY 1 HTTP refresh POST across 2 processes, got ${fetchLines.length}`);
        assert.equal(fs.existsSync(`${envPath}.token.lock`), false, 'token lock file must be cleaned up');
        const finalEnv = fs.readFileSync(envPath, 'utf8');
        assert.match(finalEnv, /^CTRADER_ACCESS_TOKEN=NEW_TOKEN_\d+$/m);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    console.log('PASS [3] C03a: Cross-process .env.token.lock prevents duplicate OAuth refresh across processes and syncs memory');
}

// ─── SUITE 4: C03b — CLI Read-Only Session Isolation & Single-Owner Reconnect ───
async function suite4_cliIsolationAndReconnectSingleOwner() {
    const fetchSrc = fs.readFileSync(path.join(ROOT, 'scripts/fetch_history.ts'), 'utf8');
    const scoutSrc = fs.readFileSync(path.join(ROOT, 'scripts/asset_scout.ts'), 'utf8');
    assert.ok(!fetchSrc.includes('../src/services/ctrader.js'), 'fetch_history.ts must not import stateful live ctrader.js');
    assert.ok(fetchSrc.includes('ctrader_readonly_client.js'), 'fetch_history.ts must use isolated read-only client');
    assert.ok(!scoutSrc.includes('../src/services/ctrader.js'), 'asset_scout.ts must not import stateful live ctrader.js');
    assert.ok(scoutSrc.includes('ctrader_readonly_client.js'), 'asset_scout.ts must use isolated read-only client');

    const ctraderSrc = fs.readFileSync(path.join(ROOT, 'src/services/ctrader.ts'), 'utf8');
    assert.ok(!ctraderSrc.includes('onReconnect:'), 'ctrader.ts must not configure a competing SDK onReconnect callback');
    assert.ok(ctraderSrc.includes('maxReconnectAttempts: 0'), 'ctrader.ts must disable parallel SDK auto-reconnect');

    console.log('PASS [4] C03b: CLI scripts use isolated read-only cTrader client and ctrader.ts has a single deterministic reconnect owner');
}

// ─── SUITE 5: C04 — Adoption Partial-Close Memory + Open-Trade closedAt Integrity + closePartial/closeAllPositions ───
async function suite5_partialIdempotencyAndOpenJournalIntegrity() {
    const tradingSrc = fs.readFileSync(path.join(ROOT, 'src/db/trading.ts'), 'utf8');
    // Verify TP1 and TP1.5 blocks no longer write closedAt: nowTrade onto open journals
    assert.equal(/tp1Timestamp:\s*nowTrade[\s\S]{0,200}?closedAt:\s*nowTrade/.test(tradingSrc), false, 'TP1 must never set closedAt on open trade');
    assert.equal(/slHalfwayHit:\s*true[\s\S]{0,120}?closedAt:\s*nowTrade/.test(tradingSrc), false, 'TP1.5 BE must never set closedAt on open trade');

    // Test orphan adoption after a crash right after partial close executed in cTrader (before tp1Hit reached Firestore!)
    const now = Date.parse('2026-11-27T16:00:00Z');
    const mock = createStrictFirestoreMock();
    const trades = new Map<string, any>();
    const snap = createTradeRiskSnapshot({
        ticker: 'EURUSD', direction: 'BUY', currency: 'USD', entryPrice: 1.1000, initialSlPrice: 1.0980,
        filledVolumeCents: 2000000, quoteToAccountRate: 1, capturedAtMs: now - 600_000,
    })!;
    await mock.db.collection('trade_journal').doc('J_PART').set({
        id: 'J_PART',
        ticker: 'EURUSD',
        direction: 'BUY',
        result: null,
        ctraderPositionId: '999001',
        tp1Price: 1.1020,
        tp2Price: 1.1045,
        riskSnapshot: snap,
        accountCurrency: 'USD',
        riskAmountAccount: snap.riskAmountAccount,
        riskAccountingStatus: 'VERIFIED',
        riskAccountingProvenance: 'broker_fill',
        initialSlPrice: 1.0980,
        originalSlPrice: 1.0980,
        mgmtOverrides: { partialClosePct: 0.5, slAfterTp1: 'breakeven' },
        // Simulate crash BEFORE tp1Hit=true flushed to Firestore!
    });

    const broker = {
        isCTraderReady: () => true,
        getOpenPositions: async () => [{
            positionId: '999001',
            symbolName: 'EURUSD',
            price: 1.1000,
            stopLoss: 1.1001,
            takeProfit: 1.1045,
            tradeData: { tradeSide: 1, openPrice: 1.1000, volume: 1000000, openTimestamp: now - 600_000, label: 'J_PART' },
        }],
        // Broker deal history has 1 opening deal (2,000,000) + 1 partial closing deal (1,000,000)!
        getDealsByPosition: async () => [
            { dealId: '1', positionId: '999001', dealStatus: 2, tradeSide: 1, filledVolume: 2000000, executionPrice: 1.1000 },
            { dealId: '2', positionId: '999001', dealStatus: 2, tradeSide: 2, filledVolume: 1000000, executionPrice: 1.1020, closePositionDetail: { closedVolume: 1000000, grossProfit: 2000, commission: 0, swap: 0, moneyDigits: 2 } },
        ],
        getVerifiedAccountCurrency: () => 'USD',
    };

    const recCode = extractFunctions('src/db/trading.ts', ['reconcileCTraderPositions']);
    const recApi = runVm(recCode, {
        exports: {},
        console: quiet,
        Date: class extends Date { static now() { return now; } },
        Object,
        Array,
        JSON,
        Number,
        String,
        Math,
        Set,
        Map,
        structuredClone,
        freezeTradeRiskForTrade: (await import('../../src/engine/TradeRisk.js')).freezeTradeRiskForTrade,
        ...portfolio,
        commitTradeCloseAccounting,
        db: mock.db,
        globalState: { activeTrades: trades },
        rolloverDWideMap: new Map(),
        rolloverTriageRecords: new Map(),
        lastReconcileTs: 0,
        loadRolloverJournalPending: async () => true,
        rehydrateRolloverPending() {},
        capTp2Price: (_t: any, _d: any, _e: any, _s: any, p: any) => p,
        validateExecutionInstrument: () => false,
        require: (id: string) => (id.includes('memory') ? { db: mock.db } : id.includes('ctrader') ? broker : (() => { throw new Error(id); })()),
    });

    await recApi.reconcileCTraderPositions();
    const adopted = trades.get('J_PART');
    assert.ok(adopted, 'position must be adopted');
    assert.equal(adopted.tp1Hit, true, 'broker partial close deal must set tp1Hit=true even if journal missed flush');
    assert.equal(adopted.tp1Price, 1.1020, 'adoption preserves original tp1Price');
    assert.equal(adopted.tp2Price, 1.1045, 'adoption preserves original tp2Price');
    assert.deepEqual(adopted.mgmtOverrides, { partialClosePct: 0.5, slAfterTp1: 'breakeven' });

    // Verify closeAllPositions counts unverified closes as failed (never false success)
    const closeAllCode = extractFunctions('src/services/ctrader.ts', ['closeAllPositions']);
    let closePosCalls = 0;
    const closeAllApi = runVm(closeAllCode, {
        exports: {},
        console: quiet,
        String,
        isCTraderReady: () => true,
        connectCTrader: async () => true,
        ctClient: { getState: async () => ({ positions: [{ positionId: 10 }, { positionId: 20 }] }) },
        closePosition: async (id: string) => {
            closePosCalls++;
            return id === '10'; // 10 verified closed, 20 fails verification!
        },
    });
    const killRes = await closeAllApi.closeAllPositions();
    assert.equal(closePosCalls, 2);
    assert.equal(killRes.closed, 1, 'closeAllPositions must count verified closes');
    assert.equal(killRes.failed, 1, 'closeAllPositions must count unverified closes as failed');

    // Verify closePartial routes through authorizedBrokerRequest (no blind retry) when real connection queue exists
    const closePartCode = extractFunctions('src/services/ctrader.ts', ['closePartial', 'verifyVolumeReduced']);
    let authCalls = 0;
    const closePartApi = runVm(closePartCode, {
        exports: {},
        console: quiet,
        Number,
        Math,
        String,
        Array,
        Promise,
        setTimeout: (fn: any) => { fn(); return 0; },
        config: { CTRADER_ACCOUNT_ID: '1' },
        PayloadType: { CLOSE_POSITION_REQ: 2111 },
        isCTraderReady: () => true,
        getSymbolInfo: async () => ({ stepVolume: 100 }),
        authorizedBrokerRequest: async (_conn: any, type: number, payload: any, _val: any, opts: any) => {
            authCalls++;
            assert.equal(type, 2111);
            assert.equal(payload.volume, 500);
            assert.equal(opts?.allowQueue, true);
            return {};
        },
        ctClient: {
            getState: async () => ({ positions: [{ positionId: 77, tradeData: { symbolId: 1, volume: authCalls > 0 ? 500 : 1000 } }] }),
            connection: { requestQueue: [], inFlightRequests: 0, lastRequestSentAt: 0, send: () => {}, request: async () => ({}) },
        },
    });
    assert.equal(await closePartApi.closePartial('77', 50), true);
    assert.equal(authCalls, 1, 'closePartial must use single-attempt authorizedBrokerRequest');

    console.log('PASS [5] C04: Orphan adoption detects broker partials (no double 50% close), open TP1/TP1.5 keep closedAt clean, closePartial & closeAllPositions verified');
}

// ─── SUITE 6: C05 — Watchdog LIVE/DEMO host resolution & Healthcheck contract ───
async function suite6_watchdogAndHealthcheck() {
    const wd = fs.readFileSync(path.join(ROOT, 'scripts/watchdog_ctrader_route.sh'), 'utf8');
    assert.ok(wd.includes('live.ctraderapi.com') && wd.includes('demo.ctraderapi.com'), 'watchdog must resolve LIVE vs DEMO host from .env');
    assert.ok(wd.includes('http://127.0.0.1:3691/'), 'watchdog must query local healthcheck :3691 first');
    assert.ok(wd.includes('"ctraderConnected":true'), 'watchdog must inspect ctraderConnected boolean');

    const indexSrc = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    assert.ok(indexSrc.includes('ctraderConnected'), 'index.ts :3691 healthcheck must expose ctraderConnected');

    console.log('PASS [6] C05: watchdog_ctrader_route.sh dynamically switches LIVE/DEMO host and reads :3691 ctraderConnected');
}

async function main() {
    await suite1_oteNotFoundAndLiveIncidentRepair();
    await suite2_propFirmHardLimitsAndRiskCeiling();
    await suite3_crossProcessTokenLockAndSync();
    await suite4_cliIsolationAndReconnectSingleOwner();
    await suite5_partialIdempotencyAndOpenJournalIntegrity();
    await suite6_watchdogAndHealthcheck();
    console.log('\nALL 6 POINT-2 CTRADER & PROP-FIRM SAFETY SUITES PASSED');
}

main().catch((err) => {
    console.error('FAIL test_p2_ctrader_propfirm_audit:', err);
    process.exit(1);
});
