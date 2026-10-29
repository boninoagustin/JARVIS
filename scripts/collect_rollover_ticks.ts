import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { connect, QuoteType } from 'ctrader-ts';
import { collectTickRange } from './rollover_ticks.js';

// Read-only broker requests. No trading.ts import, orders, amendments or database writes.
const dates = process.argv.slice(2);
if (!dates.length || dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`)))) {
    throw new Error('Usage: tsx scripts/collect_rollover_ticks.ts YYYY-MM-DD [...]');
}
loadEnvFile('/opt/JARVIS/.env');
const client = await connect({
    clientId: process.env.CTRADER_CLIENT_ID,
    clientSecret: process.env.CTRADER_CLIENT_SECRET,
    accessToken: process.env.CTRADER_ACCESS_TOKEN,
    accountId: Number(process.env.CTRADER_ACCOUNT_ID),
    environment: (process.env.CTRADER_DEMO ?? 'true').toLowerCase() === 'true' ? 'demo' : 'live',
});
const deadline = setTimeout(() => { client.disconnect(); console.error('Tick collection deadline reached'); process.exit(2); }, 240000);
try {
    const output = '/opt/JARVIS/logs/rollover_safety';
    fs.mkdirSync(output, { recursive: true });
    for (const date of dates) {
        for (const ticker of ['EURUSD', 'AUDJPY', 'GBPUSD', 'XAUUSD']) {
            const symbol = await client.getSymbolInfo(ticker);
            const from = Date.parse(`${date}T19:50:00Z`);
            const to = Date.parse(`${date}T22:40:00Z`);
            const rawPages: any[] = [];
            const quotes: Record<string, any> = {};
            for (const [name, type] of [['bid', QuoteType.BID], ['ask', QuoteType.ASK]] as const) {
                const result = await collectTickRange(async (fromTimestamp, toTimestamp) => {
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const page = await client.raw.market.getTickData({ symbolId: symbol.symbolId, type, fromTimestamp, toTimestamp });
                    rawPages.push({ side: name, fromTimestamp, toTimestamp, ...page });
                    return page;
                }, from, to);
                quotes[name] = result;
            }
            const record = {
                source: 'cTrader historical BID/ASK, read-only',
                collectedAt: Date.now(), date, ticker, from, to,
                symbol: { symbolId: symbol.symbolId, digits: symbol.digits, pipPosition: symbol.pipPosition, scheduleTimeZone: symbol.scheduleTimeZone, schedule: symbol.schedule },
                coverage: 'All requested API pages completed; empty intervals may be market closure or unavailable ticks, not evidence of executable prices.',
                ...quotes, rawPages,
            };
            const file = path.join(output, `${date}_${ticker}_ticks.json`);
            fs.writeFileSync(file, JSON.stringify(record));
            console.log(JSON.stringify({ file, ticker, date, bidTicks: quotes.bid.ticks.length, askTicks: quotes.ask.ticks.length, requests: quotes.bid.requests + quotes.ask.requests }));
        }
    }
} finally {
    clearTimeout(deadline);
    client.disconnect();
}
