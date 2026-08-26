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
const from = now - 7*24*60*60*1000;
// HW3F7V: XAUUSD BUY, journal dice 0.004 lotes, PnL -$10.29
console.log('HW3F7V (XAUUSD) — buscar deal por rango:');
const info = await client.getSymbolInfo('XAUUSD');
console.log('XAUUSD lotSize=', info.lotSize, 'stepVolume=', info.stepVolume, 'minVolume=', info.minVolume);
// buscar deals recientes de XAUUSD
const deals = await client.getDeals(from, now);
const xau = (deals||[]).filter(d => d.symbolId === 41).slice(0,6);
for (const d of xau) {
  console.log(JSON.stringify({dealId:d.dealId, posId:d.positionId, volume:d.volume, filled:d.filledVolume, execPrice:d.executionPrice, side:d.tradeSide, grossProfit:d.closePositionDetail?.grossProfit}));
}
await client.disconnect();
process.exit(0);
