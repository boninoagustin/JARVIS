import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadEnvFile } from 'node:process';
import admin from 'firebase-admin';
import { connect, QuoteType } from 'ctrader-ts';
import { collectTickRange } from './rollover_ticks.js';
import { registerRolloverSchedule, isRolloverBaselineWindow } from '../src/engine/RolloverSpreadGate.js';

// Measurement only. No trading imports, orders, database writes or production configuration changes.
const ROOT = '/opt/JARVIS';
const dates = process.argv.slice(2);
if (!dates.length || dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)))) throw new Error('Pass explicit historical dates YYYY-MM-DD');
const text = fs.readFileSync(ROOT + '/src/services/ctrader.ts', 'utf8');
const ast = ts.createSourceFile('ctrader.ts', text, ts.ScriptTarget.Latest, true);
const mapping = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'mapToCTraderSymbol')!;
const map = vm.runInNewContext(ts.transpileModule(mapping.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nmapToCTraderSymbol', { console });
loadEnvFile(ROOT + '/.env');
const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(ROOT + '/service-account.json', 'utf8'))) }, 'rollover-clean-reference-readonly');
let client: Awaited<ReturnType<typeof connect>> | undefined;
const deadline = setTimeout(() => { client?.disconnect(); console.error('Historical reference collection timed out'); process.exit(2); }, 480_000);
try {
    const docs = await app.firestore().collection('asset_configs').get();
    const tickers = [...new Set([...docs.docs.filter(d => d.id !== 'GLOBAL' && d.data().enabled === true && !d.data().disabledReason).map(d => d.id), 'GBPUSD'])].sort();
    const environment = (process.env.CTRADER_DEMO || 'true').toLowerCase() === 'true' ? 'demo' : 'live';
    client = await connect({ clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
        accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: Number(process.env.CTRADER_ACCOUNT_ID), environment });
    const trader = await client.raw.account.getTrader();
    const rows: any[] = [];
    for (const ticker of tickers) {
        const symbol = await client.getSymbolInfo(map(ticker));
        if (!registerRolloverSchedule(ticker, { scheduleTimeZone: symbol.scheduleTimeZone ?? '', schedule: symbol.schedule ?? [] })) throw new Error(`No verified calendar for ${ticker}`);
        for (const date of dates) {
            const from = Date.parse(date + 'T13:00:00Z'), to = Date.parse(date + 'T13:59:59.999Z');
            if (to > Date.now()) throw new Error('Calibration window is not completely historical');
            const rawPages: any[] = [];
            const quotes: Record<string, any> = {};
            for (const [side, type] of [['bid', QuoteType.BID], ['ask', QuoteType.ASK]] as const) {
                quotes[side] = await collectTickRange(async (fromTimestamp, toTimestamp) => {
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const page = await client!.raw.market.getTickData({ symbolId: symbol.symbolId, type, fromTimestamp, toTimestamp });
                    rawPages.push({ side, fromTimestamp, toTimestamp, ...page });
                    return page;
                }, from, to);
            }
            const events = new Map<number, any>();
            for (const side of ['bid', 'ask']) for (const q of quotes[side].ticks) {
                const event = events.get(q.ts) ?? { ts: q.ts };
                event[side] = q.price;
                events.set(q.ts, event);
            }
            let bid: { ts: number; price: number } | undefined, ask: { ts: number; price: number } | undefined;
            const spreads: number[] = [];
            let crossed = 0, stale = 0, embargo = 0;
            for (const e of [...events.values()].sort((a, b) => a.ts - b.ts)) {
                if (e.bid !== undefined) bid = { ts: e.ts, price: e.bid };
                if (e.ask !== undefined) ask = { ts: e.ts, price: e.ask };
                if (!bid || !ask || e.ts - bid.ts > 10000 || e.ts - ask.ts > 10000) { stale++; continue; }
                if (isRolloverBaselineWindow(ticker, e.ts)) { embargo++; continue; }
                const spread = ask.price - bid.price;
                if (spread < 0) { crossed++; continue; }
                if (spread > 0) spreads.push(spread);
            }
            spreads.sort((a, b) => a - b);
            const percentile = (p: number) => spreads.length ? spreads[Math.floor((spreads.length - 1) * p)] : null;
            const row = { ticker, date, from, to, pairs: spreads.length, crossedExcluded: crossed, staleExcluded: stale, embargoExcluded: embargo,
                medianSpreadPrice: percentile(0.5), p10SpreadPrice: percentile(0.1), p90SpreadPrice: percentile(0.9),
                bidTicks: quotes.bid.ticks.length, askTicks: quotes.ask.ticks.length, requests: quotes.bid.requests + quotes.ask.requests };
            const file = ROOT + `/logs/rollover_safety/${date}_${ticker}_clean_reference.json`;
            fs.writeFileSync(file, JSON.stringify({ source: 'actual historical BID/ASK, normal-session calendar verified, no synthetic spread', brokerName: trader.brokerName, environment, symbol, ...row, ...quotes, rawPages }));
            rows.push({ ...row, file });
            console.log(JSON.stringify({ ticker, date, pairs: row.pairs, medianSpreadPrice: row.medianSpreadPrice }));
        }
    }
    const references: Record<string, any> = {};
    for (const ticker of tickers) {
        const measured = rows.filter(r => r.ticker === ticker);
        if (measured.length !== dates.length || measured.some(r => r.pairs < 100 || !Number.isFinite(r.medianSpreadPrice) || r.medianSpreadPrice <= 0)) throw new Error(`Insufficient clean historical coverage: ${ticker}`);
        const medians = measured.map(r => r.medianSpreadPrice).sort((a, b) => a - b);
        references[ticker] = { cleanBaseline: medians[Math.floor((medians.length - 1) / 2)], historicalDates: dates, pairs: measured.reduce((a, r) => a + r.pairs, 0) };
    }
    const report = { measuredAt: Date.now(), brokerName: trader.brokerName, environment,
        source: 'lower median of per-day historical 13:00-14:00 UTC liquid-session medians; excludes pause, stale and crossed quotes', references, rows };
    const file = ROOT + '/logs/rollover_safety/clean_spread_calibration.json';
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ file, measuredAt: report.measuredAt, brokerName: report.brokerName, environment, references }, null, 2));
} finally { clearTimeout(deadline); client?.disconnect(); await app.delete(); }
