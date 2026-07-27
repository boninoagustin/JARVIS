import { TrendbarPeriod } from 'ctrader-ts';
import { connectCTrader, getHistoricalCandles } from './src/services/ctrader.js';

async function main() {
    try {
        await connectCTrader();
        const candles = await getHistoricalCandles('EURUSD', TrendbarPeriod.M15, 500);
        console.log("Last 5 candles of 500:");
        candles.slice(-5).forEach(c => {
            const date = new Date(c.timestamp).toISOString();
            console.log(`[${date}] O: ${c.open}, H: ${c.high}, L: ${c.low}, C: ${c.close}`);
        });
        console.log("Total received:", candles.length);
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
main();
