import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    if (ctClient.symbols) {
        for (const sym of ctClient.symbols) {
            const name = sym.symbolName;
            if (name && (name.includes('500') || name.includes('SPX') || name.includes('US'))) {
                console.log(`[FOUND] ${name} -> ID: ${sym.symbolId}`);
            }
        }
    }
    process.exit(0);
}
testSymbols();
