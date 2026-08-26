import fs from 'node:fs';
const env = fs.readFileSync('.env','utf8');
for (const line of env.split('\n')) {
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
console.log('conectado');
const now = Date.now();
const from = now - 7*24*60*60*1000;
for (const pid of ['284035735','283956477','284264030']) {
  try {
    const deals = await client.getDealsByPosition(Number(pid), from, now);
    console.log(`posID ${pid}: ${deals.length} deals`);
    for (const d of deals) {
      console.log('  deal:', JSON.stringify({dealId:d.dealId, filled:d.filledVolume, execPrice:d.executionPrice, commission:d.commission, grossProfit:d.closePositionDetail?.grossProfit, closeTrigger:d.closePositionDetail?.closeTriggerBase, moneyDigits:d.moneyDigits, side:d.tradeSide, status:d.dealStatus}));
    }
  } catch(e) {
    console.log(`posID ${pid} ERROR: ${e.message}`);
  }
}
await client.disconnect();
process.exit(0);
