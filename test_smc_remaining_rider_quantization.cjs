const ts = require('typescript'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
for (const [mod, names] of [['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']], ['node:http', ['request', 'get']], ['node:https', ['request', 'get']]])
    for (const name of names) require(mod)[name] = () => { throw Error('REAL NETWORK FORBIDDEN'); };
function declarations(file, names) {
    const text = fs.readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(ast).replace(/^export /, '')).join('\n');
}
function compile(code, ctx) {
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, ctx);
}
async function setup(side, digits = 5, entry = 1.1, spread = .00001) {
    const sdk = path.resolve('node_modules/ctrader-ts/dist/src');
    const { CTraderConnection } = await import(sdk + '/core/connection.js');
    const { CTraderAccount } = await import(sdk + '/modules/account.js');
    const { CTraderMarket } = await import(sdk + '/modules/market.js');
    const { encodeMessage, decodeMessage } = await import(sdk + '/protocol/codec.js');
    const { PayloadType } = await import(sdk + '/protocol/enums.js');
    const con = new CTraderConnection({ host: 'OFFLINE.invalid', requestTimeoutMs: 50 });
    let quote = { bid: entry + .005, ask: entry + .005 + spread };
    let durable = {}, rejectActive = false, rejectAmend = false, metadata = { symbolId: 42, digits };
    const writes = [], frames = [], metadataIds = [];
    const position = { positionId: 123, positionStatus: 1, swap: 0, price: entry, stopLoss: side === 'BUY' ? entry - .01 : entry + .01, takeProfit: side === 'BUY' ? entry + .02 : entry - .02,
        tradeData: { symbolId: 42, volume: 1000, tradeSide: side === 'BUY' ? 1 : 2, openTimestamp: 1000 }, trailingStopLoss: true, stopLossTriggerMethod: 1 };
    con.socket = { destroyed: false, write(frame) {
        const msg = decodeMessage(frame.subarray(4)); frames.push(msg);
        let type, payload;
        if (msg.payloadType === PayloadType.RECONCILE_REQ) { type = PayloadType.RECONCILE_RES; payload = { ctidTraderAccountId: 7, position: [structuredClone(position)] }; }
        else if (msg.payloadType === PayloadType.SYMBOL_BY_ID_REQ) { assert.deepEqual(msg.payload.symbolId, [42]); type = PayloadType.SYMBOL_BY_ID_RES; payload = { ctidTraderAccountId: 7, symbol: [{ ...metadata, pipPosition: 4 }] }; }
        else if (msg.payloadType === PayloadType.AMEND_POSITION_SLTP_REQ) {
            if (rejectAmend) { type = PayloadType.OA_ERROR_RES; payload = { ctidTraderAccountId: 7, errorCode: 'TRADING_BAD_STOPS' }; }
            else { position.stopLoss = msg.payload.stopLoss; if (Object.hasOwn(msg.payload, 'takeProfit')) position.takeProfit = msg.payload.takeProfit; else delete position.takeProfit;
                type = PayloadType.EXECUTION_EVENT; payload = { ctidTraderAccountId: 7, executionType: 4 }; }
        } else throw Error('UNEXPECTED MUTATION ' + msg.payloadType);
        setImmediate(() => con.handleData(encodeMessage(type, payload, msg.clientMsgId)));
    }, destroy() { this.destroyed = true; } };
    const account = new CTraderAccount(con, 7);
    const market = new CTraderMarket(con, 7);
    const trade = { tradeId: 'R', ticker: 'EURUSD', direction: side, timestamp: 1000, entryPrice: entry, slPrice: position.stopLoss, tp1Hit: true, tp2Price: position.takeProfit, ctraderPositionId: '123' };
    const ctx = { setTimeout, clearTimeout, Date, console: { warn() {}, log() {}, error() {} }, config: { CTRADER_ACCOUNT_ID: '7' }, PayloadType,
        ctClient: { connection: con, getState: () => account.reconcile(), getPositions: () => account.reconcile() }, isCTraderReady: () => true,
        getSymbolInfo: async id => { metadataIds.push(id); return Number.isInteger(metadata?.digits) && metadata.digits >= 0 && metadata.digits <= 100 ? (await market.getSymbolsById([id]))[0] : metadata; }, symbolToTicker: new Map([[42, 'EURUSD']]),
        getLastBidAsk: () => quote };
    const frictionText = fs.readFileSync('src/engine/FrictionModel.ts', 'utf8'), frictionAst = ts.createSourceFile('FrictionModel.ts', frictionText, ts.ScriptTarget.Latest, true);
    const config = frictionAst.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(frictionAst) === 'defaultFrictionConfig'));
    assert(config, 'actual default friction config missing');
    compile(config.getText(frictionAst).replace(/^export /, '') + declarations('src/engine/FrictionModel.ts', ['getPipValue', 'getAssetClass']), ctx);
    compile('const brokerDispatchGuards=new WeakMap();' + declarations('src/engine/OrderSafety.ts', ['authorizedBrokerRequest']), ctx);
    compile('const digitsCache=new Map();' + declarations('src/services/ctrader.ts', ['getSymbolDigits', 'formatStopLossPrice', 'normalizePositionStopLoss', 'amendSltpChecked', 'verifyPositionProtection', 'modifyStopLoss', 'removeTakeProfitForRider']), ctx);
    const pure = { exports: {} }; compile(fs.readFileSync('src/engine/RiderState.ts', 'utf8'), { module: pure, exports: pure.exports }); Object.assign(ctx, pure.exports);
    ctx.db = { collection: () => ({ doc: () => ({ async update(fields) {
        writes.push(structuredClone(fields));
        if (fields.riderTransition.phase === 'ACTIVE' && rejectActive) throw Error('durability unavailable');
        durable = { ...durable, ...structuredClone(fields) };
    }, async get() { return { exists: true, data: () => structuredClone(durable) }; } }) }) };
    ctx.rolloverBroker = { removeTakeProfitForRider: ctx.removeTakeProfitForRider, normalizePositionStopLoss: ctx.normalizePositionStopLoss };
    compile('const riderInFlight=new Set(),riderValidated=new WeakSet(),rolloverMutationInFlight=new Set();' + declarations('src/db/trading.ts', ['breakevenBufferPrice', 'persistRiderState', 'advanceRiderActivation', 'runNormalStopMutation']), ctx);
    const text = fs.readFileSync('src/db/trading.ts', 'utf8'), ast = ts.createSourceFile('trading.ts', text, ts.ScriptTarget.Latest, true); let caller;
    function visit(n) { if (ts.isIfStatement(n) && n.expression.getText(ast) === 'trade.tp1Hit && !trade.targetSlPending') caller = n.getText(ast); ts.forEachChild(n, visit); } visit(ast); assert(caller);
    Object.assign(ctx, { trade, tradeId: 'R', ticker: 'EURUSD', nowTrade: 3000, mgmtSlModeT: 'breakeven', isBacktest: false, getConfigForTicker: () => ({ riderEnabled: true, riderTf: 'H4' }), getCurrentSession: () => 'NY' });
    compile('globalThis.run=async()=>{let riderReady=false;' + caller + ';return riderReady;};', ctx);
    return { ctx, con, frames, position, trade, writes, metadataIds, get durable() { return durable; },
        set metadata(x) { metadata = x; }, set rejectActive(x) { rejectActive = x; }, set rejectAmend(x) { rejectAmend = x; },
        set spread(x) { quote = { bid: entry + .005, ask: entry + .005 + x }; },
        be: () => ctx.breakevenBufferPrice('EURUSD', entry, side), run: () => ctx.run(),
        amend: async () => { const raw = ctx.breakevenBufferPrice('EURUSD', entry, side); assert.equal(await ctx.modifyStopLoss('123', raw), true); trade.slPrice = raw; return raw; },
        mutations: () => frames.filter(x => x.payloadType === PayloadType.AMEND_POSITION_SLTP_REQ),
        resetRuntime: () => compile('riderValidated.delete(trade);', ctx) };
}
for (const side of ['BUY', 'SELL']) test(`${side}: real BE -> actual amend rounding -> SDK -> durable ACTIVE`, async t => {
    const s = await setup(side); t.after(() => s.con.disconnect());
    const raw = await s.amend(), normalized = s.position.stopLoss;
    assert.equal(normalized, Number(raw.toFixed(5)));
    if (side === 'BUY') assert(raw > normalized, 'review counterexample must remain real');
    assert.equal(await s.run(), true, `confirmed ${side} rounded BE must activate`);
    assert.equal(s.durable.riderTransition.minimumSl, normalized, 'PENDING must persist executable bound');
    assert.equal(s.writes[0].riderTransition.minimumSl, normalized);
    assert.equal(s.durable.riderTransition.phase, 'ACTIVE'); assert.equal(s.trade.managementMode, 'RIDER');
    assert.equal(s.mutations().length, 2); assert.equal(Object.hasOwn(s.mutations()[1].payload, 'takeProfit'), false);
    assert.equal(s.mutations()[1].payload.stopLoss, normalized); assert(s.metadataIds.every(id => id === 42));
});
for (const side of ['BUY', 'SELL']) for (const digits of [2, 3, 5]) test(`${side} digits=${digits}: native metadata, insufficient protection and read-only recovery`, async t => {
    const s = await setup(side, digits, digits === 2 ? 70.1 : digits === 3 ? 150.1 : 1.1, digits === 2 ? .015 : digits === 3 ? .0015 : .000015); t.after(() => s.con.disconnect());
    await s.amend(); const normalized = s.position.stopLoss;
    s.position.stopLoss = Number((normalized + (side === 'BUY' ? -1 : 1) * 10 ** -digits).toFixed(digits));
    assert.equal(await s.run(), false); assert.equal(s.durable.riderTransition.phase, 'PENDING');
    assert.equal(s.durable.riderTransition.minimumSl, normalized); assert.equal(s.mutations().length, 1);
    s.position.stopLoss = normalized; s.spread = .000001;
    assert.equal(await s.run(), false, 'PENDING cannot resend even with valid protection and changed spread');
    assert.equal(s.mutations().length, 1); assert.equal(s.durable.riderTransition.minimumSl, normalized);
    delete s.position.takeProfit;
    assert.equal(await s.run(), true); assert.equal(s.durable.riderTransition.phase, 'ACTIVE'); assert.equal(s.mutations().length, 1);
});
for (const side of ['BUY', 'SELL']) test(`${side}: ambiguous ACTIVE persistence recovers without resend or recalculation`, async t => {
    const s = await setup(side); t.after(() => s.con.disconnect()); await s.amend();
    s.rejectActive = true; assert.equal(await s.run(), false); assert.equal(s.durable.riderTransition.phase, 'PENDING'); assert.equal(s.trade.managementMode, undefined);
    const normalized = s.durable.riderTransition.minimumSl; s.rejectActive = false; s.spread = .01;
    assert.equal(await s.run(), true); assert.equal(s.durable.riderTransition.minimumSl, normalized); assert.equal(s.mutations().length, 2);
    s.resetRuntime(); assert.equal(await s.run(), true); assert.equal(s.mutations().length, 2);
});
for (const digits of [undefined, NaN, -1, 2.5, 101]) test(`invalid/missing precision ${digits}: fail before durable PENDING`, async t => {
    const s = await setup('BUY'); t.after(() => s.con.disconnect()); s.metadata = { symbolId: 42, digits };
    assert.equal(await s.run(), false); assert.equal(s.writes.length, 0); assert.equal(s.mutations().length, 0); assert.equal(s.trade.riderTransition, undefined);
});
for (const side of ['BUY', 'SELL']) test(`${side}: broker rejection retains PENDING and never resends`, async t => {
    const s = await setup(side); t.after(() => s.con.disconnect()); await s.amend(); s.rejectAmend = true;
    assert.equal(await s.run(), false); assert.equal(s.durable.riderTransition.phase, 'PENDING'); assert.equal(s.mutations().length, 2);
    s.rejectAmend = false; assert.equal(await s.run(), false); assert.equal(s.mutations().length, 2);
});
