import { connectCTrader, ctClient, accountId } from './src/services/ctrader.js';

async function main() {
    try {
        await connectCTrader();
        const res = await ctClient.raw.symbol.getLightSymbols({ ctidTraderAccountId: accountId });
        const names = res.symbol.map((s: any) => s.symbolName || s.name);
        const forexNames = names.filter((n: string) => n.includes('USD') || n.includes('EUR') || n.includes('JPY') || n.includes('CAD'));
        console.log("Forex symbols:", forexNames.slice(0, 50).join(', '));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
main();
