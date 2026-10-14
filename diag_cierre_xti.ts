// Estado post-cierre XTIUSD: posiciones abiertas + deals recientes de XTIUSD
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
console.log('equity:', st.equity, '| balance:', st.balance);
console.log('=== POSICIONES ABIERTAS:', (st.positions||[]).length, '===');
for (const p of (st.positions||[])) {
  console.log(JSON.stringify({posID:p.positionId, symId:p.tradeData?.symbolId, vol:p.volume, price:p.price, sl:p.stopLoss, tp:p.takeProfit}));
}
// deals recientes
try {
  const deals = await client.getDeals?.();
  if (deals?.deals) {
    const recent = (deals.deals||[]).slice(-8);
    for (const d of recent) console.log('DEAL:', JSON.stringify({posID:d.positionId, symId:d.symbolId, side:d.tradeSide, vol:d.volume, price:d.executionPrice, ts:d.executionTimestamp ? new Date(d.executionTimestamp).toISOString() : null}));
  }
} catch(e) { console.log('getDeals ERR:', e.message); }
await client.disconnect();
process.exit(0);
