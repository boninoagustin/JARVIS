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
const st = await client.getState();
console.log('posiciones abiertas:', (st.positions||[]).length);
for (const p of (st.positions||[])) {
  console.log(JSON.stringify({posID:p.positionId, sym:p.symbolName, side:p.tradeData?.tradeSide, vol:p.volume, price:p.price, openTs:p.openTimestamp}));
}
await client.disconnect();
process.exit(0);
