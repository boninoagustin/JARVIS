import { getCTraderTrendbars } from '../src/services/ctrader.ts';
import { TrendbarPeriod } from 'ctrader-ts';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    console.log("Fetching trendbars for BTCUSD...");
    const { connectCTrader } = await import('../src/services/ctrader.ts');
    await connectCTrader();
    
    setTimeout(async () => {
        try {
            const bars = await getCTraderTrendbars("BTCUSD", TrendbarPeriod.M5, 2);
            console.log(JSON.stringify(bars, null, 2));
        } catch (e: any) {
            console.error(e.message);
        }
        process.exit(0);
    }, 3000);
}
main();
