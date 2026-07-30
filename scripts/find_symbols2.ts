import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    try {
        const list = await ctClient.raw.market.getSymbolList({ accountId: ctClient.accountId });
        if (list && list.symbol) {
            const symbols = list.symbol;
            for (const s of symbols) {
                if (s.symbolName && (s.symbolName.includes('500') || s.symbolName.includes('SPX') || s.symbolName.includes('US') || s.symbolName.includes('OIL'))) {
                    console.log(`[CANDIDATE] Name: ${s.symbolName} ID: ${s.symbolId}`);
                }
            }
        }
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
testSymbols();
