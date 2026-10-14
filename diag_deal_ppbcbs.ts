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
const from = Date.now() - 1*864e5;
for (const posId of ['286652659']) {
  try {
    const deals = await client.getDealsByPosition(posId, from, Date.now());
    console.log(`=== posID ${posId} (${deals.length} deals) ===`);
    for (const d of deals) {
      const ts = new Date(d.createTimestamp).toISOString();
      const arg = new Date(d.createTimestamp - 3*3600e3).toISOString();
      console.log(JSON.stringify({
        tsUTC: ts.slice(11,19), argHora: arg.slice(11,19),
        side: d.tradeSide, vol: d.volume, px: d.executionPrice,
        status: d.dealStatus,
        profit: d.closePositionDetail ? Number(d.closePositionDetail.grossProfit)/100 : null,
        trigger: d.closePositionDetail ? d.closePositionDetail.closeTriggerBase : null,
      }));
    }
  } catch (e) { console.log(`posID ${posId}: error ${e.message}`); }
}
await client.disconnect();
process.exit(0);
