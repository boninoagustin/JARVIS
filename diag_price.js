import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/JARVIS/.env','utf8').split('\n')) {
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
console.log('account equity:', st.account?.equity, 'balance:', st.account?.balance, 'currency:', st.account?.currencyIsoCode);
// price via account/positions
for (const p of (st.positions||[])) {
  if (p.symbolId === 10092) {
    console.log('XTIUSD position PnL approx: usedMargin', p.usedMargin, 'marginRate', p.marginRate);
  }
}
// find price-related state fields
console.log('state keys:', Object.keys(st));
console.log('account keys:', st.account ? Object.keys(st.account) : null);
// try tick methods
for (const m of ['getTick','getSymbolTick','getSpotPrice','getQuote','getCurrentPrice','getSymbolQuote']) {
  if (typeof client[m] === 'function') {
    try { console.log(m, '→', JSON.stringify(await client[m]('XTIUSD'))); } catch(e) { console.log(m, 'ERR', e.message); }
  }
}
await client.disconnect();
process.exit(0);
