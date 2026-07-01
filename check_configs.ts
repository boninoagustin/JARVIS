import { db } from './src/db/memory.ts';
async function test() {
    const tickers = ['BTCUSD', 'EURUSD', 'XAUUSD'];
    for (const t of tickers) {
        const doc = await db.collection('asset_configs').doc(t).get();
        console.log(`--- ${t} ---`);
        console.log(JSON.stringify(doc.data(), null, 2));
    }
    process.exit(0);
}
test();
