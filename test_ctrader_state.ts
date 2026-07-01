import { config } from 'dotenv';
config();
import { CTrader } from 'ctrader-ts';

async function run() {
  const ct = new CTrader({
    clientId: process.env.CTRADER_CLIENT_ID!,
    clientSecret: process.env.CTRADER_CLIENT_SECRET!,
    accessToken: process.env.CTRADER_ACCESS_TOKEN!,
    accountId: parseInt(process.env.CTRADER_ACCOUNT_ID!),
    demo: true
  });
  
  await ct.start();
  const state = await ct.getState();
  console.log(JSON.stringify(state.positions, null, 2));
  process.exit(0);
}
run();
