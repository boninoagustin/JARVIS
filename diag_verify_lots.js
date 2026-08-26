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
const from = now - 2*24*60*60*1000;
// BI4OIO: USDJPY SELL, journal dice 27 lotes, PnL real -$24.06
const deals = await client.getDealsByPosition(284264030, from, now);
console.log('BI4OIO deals:');
for (const d of deals) {
  console.log(JSON.stringify({
    volume: d.volume, filled: d.filledVolume,
    execPrice: d.executionPrice, side: d.tradeSide, status: d.dealStatus,
    grossProfit: d.closePositionDetail?.grossProfit,
    moneyDigits: d.moneyDigits,
  }));
}
// consultar symbol info de USDJPY para moneyDigits/pip
const info = await client.getSymbolInfo('USDJPY');
console.log('USDJPY info:', JSON.stringify({lotSize: info.lotSize, digits: info.digits, moneyDigits: info.moneyDigits, tickSize: info.tickSize, pipSize: info.pipSize}));
await client.disconnect();
process.exit(0);
