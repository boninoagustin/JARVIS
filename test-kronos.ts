import { processTradingAlert } from './src/db/trading.js';

async function testKronos() {
    console.log("🤖 1. Enviando TOUCH_ZONE... (+2 pts)");
    await processTradingAlert("TOUCH_ZONE, BTCUSDT, BUY");
    await new Promise(r => setTimeout(r, 1000));
    
    console.log("🤖 2. Enviando EVENTO_SWEEP... (+3 pts)");
    await processTradingAlert("EVENTO_SWEEP, BTCUSDT, BUY");
    await new Promise(r => setTimeout(r, 1000));
    
    console.log("🤖 3. Enviando EVENTO_CHOCH BUY... (+2 pts) -> Dispara SETUP con Kronos");
    await processTradingAlert("EVENTO_CHOCH, BTCUSDT, BUY");
    await new Promise(r => setTimeout(r, 5000));
    console.log("✅ FIN DEL TEST");
    process.exit(0);
}

testKronos().catch(console.error);
