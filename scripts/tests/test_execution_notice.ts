import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as risk from '../../src/engine/TradeRisk.js';
import * as portfolio from '../../src/engine/PortfolioModel.js';
import * as notice from '../../src/engine/ExecutionNotice.js';

// Import only pure helpers, never service startup or a live broker.
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const trading = parse('src/db/trading.ts');
const confirmation = parse('src/services/ctrader_confirmation.ts');
function fn(ast: ts.SourceFile, name: string) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `actual production function ${name}`);
    return node.getText(ast);
}
function autoResultBranch() {
    const found: ts.IfStatement[] = [];
    (function visit(n: ts.Node) {
        if (ts.isIfStatement(n) && n.expression.getText(trading) === 'await retainExecutionIncident(oteData.tradeId, journalId, result)') found.push(n);
        ts.forEachChild(n, visit);
    })(trading);
    assert.equal(found.length, 1, 'execute the complete AUTO incident/no-fill AST branch');
    return found[0].getText(trading);
}
async function run(mode: 'AUTO' | 'MANUAL', result: any) {
    const pending = { tradeId: 'T1', journalId: 'J1', ticker: 'EURUSD', direction: 'BUY', entryPrice: 1.1, slPrice: 1.09, tp1Price: 1.12 };
    const trades = new Map<string, any>([['T1', { ...pending }]]);
    const messages: string[] = [], buttons: string[] = [], writes: any[] = [], deletes: string[] = [];
    const db = { collection: (collection: string) => ({ doc: (id: string) => ({
        update: async (fields: any) => { writes.push({ collection, id, fields }); },
        set: async (fields: any) => { writes.push({ collection, id, fields }); },
        delete: async () => { deletes.push(`${collection}/${id}`); },
    }) }) };
    const context: any = {
        exports: {}, ...risk, ...portfolio, ...notice, console: { log() {}, warn() {}, error() {} },
        db, globalState: { activeTrades: trades }, store: { activeTrades: trades },
        result, oteData: pending, journalId: 'J1', ticker: 'EURUSD', isBacktest: false,
        msg: '<b>SEÑAL ORIGINAL</b>', pendingConfirmations: new Map([['T1', pending]]),
        config: { CTRADER_RISK_PERCENT: 1 }, recheckLiveExecutionRisk: async () => null,
        executeMarketOrder: async () => result,
        sendTelegramAlert: async (text: string) => { messages.push(text); },
        bot: { api: {
            sendMessage: async (_: number, text: string) => { messages.push(text); },
            editMessageReplyMarkup: async (_: number, __: number, markup: any) => { buttons.push(markup.reply_markup.inline_keyboard[0][0].text); },
        } },
        require: (id: string) => { throw Error(`Forbidden service import in offline notice test: ${id}`); },
    };
    const shared = ['retainExecutionIncident', 'hasUnresolvedExecutionIncidents'].map(name => fn(trading, name)).join('\n');
    const body = shared + '\n' + (mode === 'AUTO'
        ? `exports.run = async () => { ${autoResultBranch()} };`
        : fn(confirmation, 'handleTradeCallback') + '\nexports.run = () => exports.handleTradeCallback("ctrader_execute_T1", 1, 2, 3);');
    vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
    await context.exports.run();
    return { messages, buttons, writes, deletes, trades };
}

const knownGuards = ['ACCOUNT_STATE', 'METADATA', 'QUOTE', 'STOPS', 'SLIPPAGE', 'CURRENCY', 'CONVERSION', 'COST', 'RISK', 'MIN_VOLUME', 'DISPATCH', 'UNBOUNDED_MARKET', 'LEVELS', 'TARGETS', 'RR', 'SESSION', 'KILLSWITCH', 'EXECUTION_INCIDENT', 'RACHA', 'VIX', 'SPREAD', 'ROLLOVER', 'GLOBAL', 'ASSET'];

for (const mode of ['AUTO', 'MANUAL'] as const) {
    test(`${mode}: broker/unknown/near-match errors retain execution error notices`, async () => {
        for (const raw of ['TRADING_BAD_STOPS', 'MARKET_RANGE rechazada (INVALID_VOLUME)', 'BLOCKED_PAYLOAD_TYPE', 'BLOCKED_FUTURE', 'BLOCKED_STOPS_EXTRA', 'BLOCKED_STOPS trailing junk', 'broker says BLOCKED_STOPS', 'broker transport timeout', undefined]) {
            const h = await run(mode, Object.freeze({ success: false, error: raw }));
            assert.match(h.messages[0], mode === 'AUTO' ? /ERROR AUTO-EJECUCIÓN/ : /ERROR DE EJECUCIÓN/, raw);
            assert.doesNotMatch(h.messages[0], /ENTRADA DESCARTADA POR SEGURIDAD|FALLO TÉCNICO DE ENVÍO/);
            assert.equal(h.writes.find(w => w.collection === 'trade_journal').fields.ctraderError, raw ?? (mode === 'AUTO' ? null : undefined));
        }
    });
    test(`${mode}: ambiguous and identity-bearing outcomes still retain reconciliation instead of a no-fill notice`, async () => {
        for (const result of [null, { success: false, executionUncertain: true, error: 'BLOCKED_STOPS' }, { success: false, positionId: 'P1', error: 'BLOCKED_STOPS' }]) {
            const h = await run(mode, result);
            assert.match(h.messages[0], /pendiente de reconciliación/);
            assert.doesNotMatch(h.messages[0], /ENTRADA DESCARTADA|ERROR.*EJECUCIÓN|FALLO TÉCNICO DE ENVÍO/);
            assert.equal(h.trades.has('T1'), true);
            assert.equal(h.trades.get('T1').executionIncidentPending, true);
            assert.equal(h.deletes.length, 0);
            assert.ok(h.writes.every(w => w.fields.ctraderStatus === 'EXECUTION_PENDING_RECONCILIATION'));
        }
    });
    test(`${mode}: Telegram escapes error details without changing raw broker/audit evidence`, async () => {
        for (const prefix of ['MARKET_RANGE rechazada (TRADING_BAD_STOPS)', 'BLOCKED_STOPS']) {
            const raw = `${prefix}: <bad>&"quotes" &amp;`;
            const result = Object.freeze({ success: false, error: raw });
            const h = await run(mode, result);
            assert.ok(h.messages[0].includes(`${prefix}: &lt;bad&gt;&amp;"quotes" &amp;amp;`));
            assert.doesNotMatch(h.messages[0], /<bad>/);
            if (prefix.startsWith('MARKET_RANGE')) {
                assert.match(h.messages[0], mode === 'AUTO' ? /ERROR AUTO-EJECUCIÓN/ : /ERROR DE EJECUCIÓN/);
                assert.doesNotMatch(h.messages[0], /ENTRADA DESCARTADA/);
                if (mode === 'MANUAL') assert.equal(h.buttons.at(-1), '❌ ERROR DE EJECUCIÓN');
            }
            assert.equal(h.writes.find(w => w.collection === 'trade_journal').fields.ctraderError, raw);
            assert.equal(result.error, raw);
        }
    });
    test(`${mode}: dispatch admission timeout is a technical send failure, not a strategy discard`, async () => {
        const raw = 'BLOCKED_DISPATCH: admission wait timed out before submission';
        const h = await run(mode, Object.freeze({ success: false, error: raw }));
        assert.match(h.messages[0], /FALLO TÉCNICO DE ENVÍO/);
        assert.match(h.messages[0], /tiempo de espera/);
        assert.doesNotMatch(h.messages[0], /ENTRADA DESCARTADA POR SEGURIDAD/);
        if (mode === 'MANUAL') assert.equal(h.buttons.at(-1), '⚠️ FALLO TÉCNICO DE ENVÍO');
        assert.equal(h.writes.find(w => w.collection === 'trade_journal').fields.ctraderError, raw);
    });
    test(`${mode}: known local guard allowlist renders Spanish safe discard wording`, async () => {
        for (const guard of knownGuards) {
            for (const raw of [`BLOCKED_${guard}`, `BLOCKED_${guard}: local preflight detail`]) {
                const h = await run(mode, Object.freeze({ success: false, error: raw }));
                assert.match(h.messages[0], /ENTRADA DESCARTADA POR SEGURIDAD/, raw);
                assert.match(h.messages[0], /descartada de forma segura/, raw);
                assert.doesNotMatch(h.messages[0], /ERROR.*EJECUCIÓN/, raw);
            }
        }
    });
    test(`${mode}: existing spread SL preflight text is a safe discard`, async () => {
        const raw = 'SL (1.09) no despeja el spread vivo (bid=1.08, ask=1.10) para BUY. Trade abortado antes del broker.';
        const h = await run(mode, Object.freeze({ success: false, error: raw }));
        assert.match(h.messages[0], /ENTRADA DESCARTADA POR SEGURIDAD/);
        assert.match(h.messages[0], /spread vivo/);
        assert.equal(h.writes.find(w => w.collection === 'trade_journal').fields.ctraderError, raw);
    });
    test(`${mode}: known local stop rejection is a safe discard, not an execution error`, async () => {
        const raw = 'BLOCKED_STOPS: SL no despeja el spread vivo';
        const result = Object.freeze({ success: false, error: raw });
        const h = await run(mode, result);
        assert.equal(h.messages.length, 1, 'actual caller must send a notice');
        assert.match(h.messages[0], /ENTRADA DESCARTADA POR SEGURIDAD/);
        assert.match(h.messages[0], /spread vivo/);
        assert.doesNotMatch(h.messages[0], /ERROR.*EJECUCIÓN/);
        if (mode === 'AUTO') assert.match(h.messages[0], /<b>SEÑAL ORIGINAL<\/b>/);
        else assert.equal(h.buttons.at(-1), '🛡️ ENTRADA DESCARTADA');
        assert.equal(result.error, raw, 'raw result.error is immutable audit evidence');
        const journal = h.writes.find(w => w.collection === 'trade_journal');
        assert.equal(journal.fields.ctraderError, raw);
        assert.equal(journal.fields.result, 'SKIP');
        assert.equal(journal.fields.ctraderStatus, mode === 'AUTO' ? 'ABORTED' : 'EXECUTION_FAILED');
        assert.equal(journal.fields.skipReason, mode === 'AUTO' ? `Ejecución abortada en cTrader: ${raw}` : `Ejecución fallida en cTrader: ${raw}`);
        assert.equal(h.trades.has('T1'), false);
        assert.deepEqual(h.deletes, ['active_trades/T1']);
    });
}
