import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    const keys = ctClient.symbols.nameToId instanceof Map ? Array.from(ctClient.symbols.nameToId.keys()) : Object.keys(ctClient.symbols.nameToId);
    console.log("Matched 500:");
    console.log(keys.filter(k => k.includes('500')));
    console.log("Matched OIL:");
    console.log(keys.filter(k => k.includes('OIL') || k.includes('WTI') || k.includes('XTI')));
    process.exit(0);
}
testSymbols();
