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
const to = Date.now(), from = to - 30*24*3600*1000;
const deals = await client.getDealsByPosition(300802673, from, to).catch(e=>({err:String(e)}));
if (!Array.isArray(deals)) { console.log('ERROR:', JSON.stringify(deals)); process.exit(1); }
console.log('deals:', deals.length);
for (const d of deals) {
  console.log(JSON.stringify({
    dealId: d.dealId, pos: d.positionId, status: d.dealStatus, side: d.tradeSide,
    vol: d.filledVolume, exec: d.executionPrice, sym: d.symbolId, moneyDigits: d.moneyDigits,
    cp: d.closePositionDetail ? {vol: d.closePositionDetail.closedVolume, gross: d.closePositionDetail.grossProfit, comm: d.closePositionDetail.commission, swap: d.closePositionDetail.swap, digits: d.closePositionDetail.moneyDigits} : null,
  }));
}
await client.disconnect();
process.exit(0);
