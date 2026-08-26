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
// Consultar deals de las 4 posiciones del incidente para ver label/volumen/pnl
for (const pid of [284437469, 284437471, 284438141, 284438142]) {
  try {
    const deals = await client.getDealsByPosition(pid, from, now);
    const d0 = deals[0];
    const close = deals.find(d => d?.closePositionDetail);
    console.log(`posID ${pid}: vol=${d0?.volume} label=${d0?.label} symId=${d0?.symbolId} pnl=${close?.closePositionDetail?.grossProfit}`);
  } catch(e) { console.log(`posID ${pid}: ERROR ${e.message}`); }
}
await client.disconnect();
process.exit(0);
