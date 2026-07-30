import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    console.log(Object.keys(ctClient));
    process.exit(0);
}
testSymbols();
