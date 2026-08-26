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
console.log('=== posiciones abiertas AHORA ===');
const st = await client.getState();
console.log('open positions:', (st.positions||[]).map(p=>({posID:p.positionId, sym:p.symbolName, side:p.tradeData?.tradeSide, vol:p.volume, price:p.price})));
console.log('=== deals de posID 284306316 ===');
try {
  const deals = await client.getDealsByPosition(284306316, from, now);
  console.log('deals:', deals.length);
  for (const d of deals) {
    console.log(JSON.stringify({dealId:d.dealId, volume:d.volume, filled:d.filledVolume, execPrice:d.executionPrice, side:d.tradeSide, status:d.dealStatus, closeDetail:d.closePositionDetail?{grossProfit:d.closePositionDetail.grossProfit, trigger:d.closePositionDetail.closeTriggerBase}:null, moneyDigits:d.moneyDigits, symbolId:d.symbolId}));
  }
} catch(e) { console.log('ERROR deals 284306316:', e.message); }
console.log('=== historial de órdenes (últimas) ===');
try {
  const orders = await client.getOrders();
  console.log('orders count:', (orders||[]).length);
  for (const o of (orders||[]).slice(-10)) {
    console.log(JSON.stringify({orderId:o.orderId, posId:o.positionId, sym:o.symbolId, side:o.tradeSide, type:o.orderType, status:o.orderStatus, vol:o.volume}));
  }
} catch(e) { console.log('ERROR orders:', e.message); }
await client.disconnect();
process.exit(0);
