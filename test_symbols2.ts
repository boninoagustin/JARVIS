import { config } from 'dotenv';
import { ctClient, connectCTrader } from './src/services/ctrader.js';
import * as fs from 'fs';

config();

async function main() {
    try {
        await connectCTrader();
        // The symbolsMap is private/unexported, so let's call API again
        const accountId = parseInt(process.env.CTRADER_ACCOUNT_ID || '0');
        const res = await ctClient.raw.symbol.getLightSymbols({ ctidTraderAccountId: accountId });
        const names = res.symbol.map((s: any) => s.symbolName || s.name);
        fs.writeFileSync('symbols.json', JSON.stringify(names, null, 2));
        console.log("Wrote", names.length, "symbols to symbols.json");
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
main();
