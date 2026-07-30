import { connectCTrader, ctClient } from '../src/services/ctrader.js';

async function testSymbols() {
    await connectCTrader();
    const res = await ctClient.connection.send({ payloadType: 2114, ctIdTraderAccountId: ctClient.accountId });
    import('fs').then(fs => fs.writeFileSync('symbols_proto.json', JSON.stringify(res, null, 2)));
    process.exit(0);
}
testSymbols();
