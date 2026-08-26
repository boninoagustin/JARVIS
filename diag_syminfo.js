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
for (const sym of ['USDJPY','EURUSD','GBPUSD','XAUUSD','USDCAD']) {
  try {
    const info = await client.getSymbolInfo(sym);
    console.log(sym, '=>', JSON.stringify({
      symbolId: info.symbolId,
      lotSize: info.lotSize,
      stepVolume: info.stepVolume,
      minVolume: info.minVolume,
      maxVolume: info.maxVolume,
      digits: info.digits,
      tickSize: info.tickSize,
      pipSize: info.pipSize,
    }));
  } catch(e) { console.log(sym, 'ERROR', e.message); }
}
await client.disconnect();
process.exit(0);
