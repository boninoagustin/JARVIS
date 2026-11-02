import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { tickFlow } from '../src/engine/TickFlow.js';
import { getRolloverSpreadReference } from '../src/engine/RolloverSpreadReference.js';
import { registerRolloverSchedule, evaluateRolloverEntryGate } from '../src/engine/RolloverSpreadGate.js';

// Causal replay of measured liquid-session quotes, not PnL or broker execution.
const root = '/opt/JARVIS';
const report = JSON.parse(fs.readFileSync(root + '/logs/rollover_safety/clean_spread_calibration.json', 'utf8'));
const source = fs.readFileSync(root + '/src/services/ctrader.ts', 'utf8');
const ast = ts.createSourceFile('ctrader.ts', source, ts.ScriptTarget.Latest, true);
const names = ['MAX_QUOTE_AGE_MS', 'lastBidAsk', 'quoteSides', 'ingestSpotQuote', 'getLastBidAsk'];
const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')) ||
    (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))))
    .map(n => n.getText(ast)).join('\n');
const api = vm.runInNewContext(ts.transpileModule(selected.replace(/export /g, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText + '\n({ingestSpotQuote,getLastBidAsk})', { tickFlow, Date, console });
const results: any[] = [];
let quoteUpdates = 0;
for (const ticker of Object.keys(report.references).sort()) {
    let maximumSamples = 0, allowedObservations = 0;
    for (const row of report.rows.filter((r: any) => r.ticker === ticker)) {
        const data = JSON.parse(fs.readFileSync(row.file, 'utf8'));
        registerRolloverSchedule(ticker, data.symbol);
        const events = new Map<number, any>();
        for (const side of ['bid', 'ask']) for (const q of data[side].ticks) {
            const e = events.get(q.ts) ?? { timestamp: q.ts };
            e[side] = Math.round(q.price * 100000);
            events.set(q.ts, e);
            quoteUpdates++;
        }
        for (const e of [...events.values()].sort((a, b) => a.timestamp - b.timestamp)) {
            const reference = getRolloverSpreadReference(ticker, Number(e.bid ?? e.ask) / 100000);
            tickFlow.configureBootstrapSpread(ticker, reference);
            api.ingestSpotQuote(ticker, e, e.timestamp);
            const q = api.getLastBidAsk(ticker, e.timestamp);
            const s = tickFlow.getSpreadSnapshot(ticker, e.timestamp);
            if (!q || !s) continue;
            maximumSamples = Math.max(maximumSamples, s.samples);
            const snapshot = { ...s, bid: q.bid, ask: q.ask, spread: Math.max(s.spread, q.ask - q.bid), ts: Math.min(q.ts, s.ts) };
            const gate = evaluateRolloverEntryGate(ticker, e.timestamp, snapshot, { live: true, ...reference });
            allowedObservations += Number(!gate.blocked);
        }
    }
    if (maximumSamples < 100 || allowedObservations === 0) throw new Error(`Normal-history deadlock: ${ticker}`);
    results.push({ ticker, maximumSamples, allowedObservations, baselineSpreadPrice: tickFlow.getStructuralSpread(ticker) });
}
const out = { type: 'real_liquid_session_replay', source: report.source, dates: ['2026-10-12', '2026-10-13'], pnlEvaluated: false, quoteUpdates, results };
const file = root + '/logs/rollover_safety/clean_replay_post_review.json';
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ file, ...out }, null, 2));
