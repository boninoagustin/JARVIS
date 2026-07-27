import { config } from 'dotenv';
import { connectCTrader, ctClient } from './src/services/ctrader.js';

config();

async function main() {
    try {
        await connectCTrader();
        const info = await ctClient.getSymbolInfo("XAUUSD");
        console.log("XAUUSD INFO:", JSON.stringify(info, null, 2));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
main();
