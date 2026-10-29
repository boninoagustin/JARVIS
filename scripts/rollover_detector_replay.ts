import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { tickFlow } from '../src/engine/TickFlow.js';
import { registerRolloverSchedule, evaluateRolloverEntryGate, isSpreadNormalized } from '../src/engine/RolloverSpreadGate.js';

// Detector/calendar replay, NOT a PnL backtest or reconstruction of SpotEvent packets.
const root = '/opt/JARVIS/logs/rollover_safety';
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'baseline_snapshot.json'), 'utf8'));
const oldSource = fs.readFileSync(path.join(baseline.root, 'src/engine/TickFlow.ts'), 'utf8');
const oldJs = ts.transpileModule(oldSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const files = fs.readdirSync(root).filter(x => /^2026-\d\d-\d\d_.*_ticks\.json$/.test(x)).sort();
const results: any[] = [];
let totalTicks = 0;
for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const key = `REPLAY_${data.ticker}_${data.date}`;
    registerRolloverSchedule(key, data.symbol);
    const pip = data.ticker.includes('JPY') ? 0.01 : data.ticker === 'XAUUSD' ? 0.1 : 0.0001;
    const basePips = data.ticker === 'XAUUSD' ? 1 : 0.1;
    tickFlow.configureBootstrapSpread(key, { baseSpreadPrice: basePips * pip, pipSize: pip });
    const sandbox: any = { exports: {}, console, Date };
    vm.runInNewContext(oldJs, sandbox);
    const before = sandbox.exports.tickFlow;
    const events = new Map<number, any>();
    for (const side of ['bid', 'ask']) for (const quote of data[side].ticks) {
        const event = events.get(quote.ts) ?? { ts: quote.ts };
        event[side] = quote.price;
        events.set(quote.ts, event);
        totalTicks++;
    }
    const ordered = [...events.values()].sort((a, b) => a.ts - b.ts);
    let cursor = 0;
    const sides: any = {};
    const stats = { gridPoints: 0, oldAllowed: 0, newAllowed: 0, oldAllowedWideQuote: 0,
        newAllowedWideQuote: 0, oldAllowedWithoutFreshQuote: 0, newAllowedWithoutFreshQuote: 0,
        validPairsFed: 0, crossedPairsExcluded: 0, reasons: {} as Record<string, number> };
    for (let now = data.from; now <= data.to; now += 30000) {
        while (cursor < ordered.length && ordered[cursor].ts <= now) {
            const event = ordered[cursor++];
            for (const side of ['bid', 'ask']) if (event[side] !== undefined) sides[side] = { ts: event.ts, price: event[side] };
            const bid = sides.bid && event.ts - sides.bid.ts <= 10000 ? sides.bid.price : NaN;
            const ask = sides.ask && event.ts - sides.ask.ts <= 10000 ? sides.ask.price : NaN;
            if (Number.isFinite(bid) && Number.isFinite(ask) && ask < bid) {
                stats.crossedPairsExcluded++;
                tickFlow.onTick(key, event.ts, bid, NaN);
                continue;
            }
            tickFlow.onTick(key, event.ts, bid, ask, {
                bidTick: event.bid !== undefined,
                quoteTs: Math.min(sides.bid?.ts ?? event.ts, sides.ask?.ts ?? event.ts),
            });
            if (Number.isFinite(bid) && Number.isFinite(ask) && ask > bid) {
                // Same causally merged quote pairs feed both detectors, isolating EWMA logic.
                before.onTick(key, event.ts, bid, ask);
                stats.validPairsFed++;
            }
        }
        const raw = tickFlow.getSpreadSnapshot(key, now);
        const quoteTs = sides.bid && sides.ask ? Math.min(sides.bid.ts, sides.ask.ts) : 0;
        const fresh = raw && now - quoteTs <= 10000 ? { ...raw, ts: quoteTs, ageMs: now - quoteTs } : null;
        const calendarOptions = { live: true, enabled: true, pipSize: pip, baseSpreadPrice: basePips * pip };
        const gate = evaluateRolloverEntryGate(key, now, fresh, calendarOptions);
        const date = new Date(now), mins = date.getUTCHours() * 60 + date.getUTCMinutes();
        const oldWindow = date.getUTCDay() >= 1 && date.getUTCDay() <= 5 && mins >= 20 * 60 + 29 && mins <= 21 * 60 + 30;
        const oldAllowed = !oldWindow && !before.isSpreadAnomalous(key);
        const wide = fresh !== null && !isSpreadNormalized(fresh, now, basePips * pip, pip);
        stats.gridPoints++;
        stats.oldAllowed += Number(oldAllowed);
        stats.newAllowed += Number(!gate.blocked);
        stats.oldAllowedWideQuote += Number(oldAllowed && wide);
        stats.newAllowedWideQuote += Number(!gate.blocked && wide);
        stats.oldAllowedWithoutFreshQuote += Number(oldAllowed && !fresh);
        stats.newAllowedWithoutFreshQuote += Number(!gate.blocked && !fresh);
        const reason = gate.reason ?? 'ALLOWED';
        stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
    }
    if (stats.newAllowedWideQuote || stats.newAllowedWithoutFreshQuote) throw new Error('Replay found unsafe gate allowance');
    results.push({ ticker: data.ticker, date: data.date, scheduleTimeZone: data.symbol.scheduleTimeZone,
        baselineCommit: baseline.commit, oldBaselinePips: (before.getStructuralSpread(key) ?? 0) / pip,
        newBaselinePips: (tickFlow.getStructuralSpread(key) ?? 0) / pip, ...stats });
}
const report = { type: 'real_bid_ask_detector_calendar_replay', pnlEvaluated: false,
    limitation: 'Eight symbol-days, 30-second decision grid; side streams merged causally, not original SpotEvent packet replay. No assumption about positions, fills or hypothetical R.',
    totalFiles: files.length, totalTicks, results };
fs.writeFileSync(path.join(root, 'detector_replay_ab.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
