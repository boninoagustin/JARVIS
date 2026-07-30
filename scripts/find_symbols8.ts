import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    
    // We need to request the symbol list from the broker directly
    const list = await ctClient.connection.send({ payloadType: 2114, reqId: "123", ctIdTraderAccountId: ctClient.accountId });
    if (list && list.symbol) {
        for (const sym of list.symbol) {
            const name = sym.symbolName;
            if (name && (name.includes('500') || name.includes('SPX') || name.includes('US') || name.includes('NAS') || name.includes('NDX'))) {
                console.log(`[FOUND] ${name}`);
            }
        }
    }
    process.exit(0);
}
testSymbols();
