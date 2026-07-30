import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    
    const candidates = [
        'US500', 'US500.c', 'US500.a', 'US500.i', 'SPX500', 'SPX', 'SP500', 'USA500', 'US30', 'DJ30',
        'USOIL', 'USOil', 'USOil.c', 'WTI', 'XTIUSD', 'USOil.a', 'BRENT', 'XBRUSD'
    ];
    
    for (const sym of candidates) {
        try {
            const info = await ctClient.getSymbolInfo(sym);
            if (info && info.symbolId) {
                console.log(`[SUCCESS] Found symbol: ${sym} -> ID: ${info.symbolId}`);
            }
        } catch (e) {
            // failed
        }
    }
    process.exit(0);
}
testSymbols();
