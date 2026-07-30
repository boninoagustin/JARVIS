import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    console.log(Object.keys(ctClient.raw.market));
    process.exit(0);
}
testSymbols();
