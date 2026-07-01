import { connect } from 'ctrader-ts';
import { config } from '../src/config.js';

async function run() {
    const ctClient = await connect({
        clientId: config.CTRADER_CLIENT_ID,
        clientSecret: config.CTRADER_CLIENT_SECRET,
        accountId: config.CTRADER_ACCOUNT_ID,
        accessToken: config.CTRADER_ACCESS_TOKEN,
        demo: true
    });
    console.log("Connected");
    const info = await ctClient.getSymbolInfo("US TECH 100");
    console.log(JSON.stringify(info, null, 2));
    process.exit(0);
}
run();
