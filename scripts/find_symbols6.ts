import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    console.log(Object.keys(ctClient.symbols).length > 0 ? Object.keys(ctClient.symbols).slice(0, 5) : ctClient.symbols);
    
    // Dump all symbols to a file to search
    import('fs').then(fs => fs.writeFileSync('symbols_dump.json', JSON.stringify(ctClient.symbols, null, 2)));
}
testSymbols();
