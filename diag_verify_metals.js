import fs from 'node:fs';
for (const line of fs.readFileSync('.env','utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}
const { connect } = await import('ctrader-ts');
const client = await connect({
  clientId: process.env.CTRADER_CLIENT_ID,
  clientSecret: process.env.CTRADER_CLIENT_SECRET,
  accessToken: process.env.CTRADER_ACCESS_TOKEN,
  accountId: parseInt(process.env.CTRADER_ACCOUNT_ID,10)||0,
  environment: process.env.CTRADER_DEMO === 'true' ? 'demo':'live',
});
const now = Date.now();
const from = now - 30*24*60*60*1000;
// XAU: HW3F7V posID=283375070, ZODQHD posID=283371730, UWQPGY posID=283576698, V6UKF6 posID=283393352, XAIT7J posID=283522214
// BTC: 71E5RV posID=283470583
for (const [id, pid] of [['HW3F7V',283375070],['ZODQHD',283371730],['UWQPGY',283576698],['V6UKF6',283393352],['XAIT7J',283522214],['71E5RV',283470583]]) {
  try {
    const deals = await client.getDealsByPosition(pid, from, now);
    const closeDeal = deals.find(d => d?.closePositionDetail);
    const first = deals[0];
    console.log(`${id} (posID ${pid}): volume=${first?.volume}, symbolId=${first?.symbolId}, pnl=${closeDeal?.closePositionDetail?.grossProfit}`);
  } catch(e) { console.log(`${id} (posID ${pid}): ERROR ${e.message}`); }
}
// lotSize de cada symbol
for (const sym of ['XAUUSD','BTCUSD']) {
  const info = await client.getSymbolInfo(sym);
  console.log(`${sym}: lotSize=${info.lotSize}, stepVolume=${info.stepVolume}`);
}
await client.disconnect();
process.exit(0);
