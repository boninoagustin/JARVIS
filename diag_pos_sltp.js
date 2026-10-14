// Diag: posiciones abiertas con SL/TP + symbol info XTIUSD
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
console.log('=== POSICIONES ABIERTAS:', (st.positions||[]).length, '===');
for (const p of (st.positions||[])) {
  console.log(JSON.stringify({
    posID: p.positionId,
    sym: p.symbolName,
    side: p.tradeData?.tradeSide,
    vol: p.volume,
    entry: p.price,
    sl: p.tradeData?.stopLoss,
    tp: p.tradeData?.takeProfit,
    openTs: p.openTimestamp ? new Date(p.openTimestamp).toISOString() : null,
  }, null, 1));
}
try {
  const info = await client.getSymbolInfo('XTIUSD');
  console.log('\n=== XTIUSD symbol info ===');
  console.log(JSON.stringify({symbolId: info.symbolId, lotSize: info.lotSize, stepVolume: info.stepVolume, minVolume: info.minVolume, maxVolume: info.maxVolume, digits: info.digits, pipSize: info.pipSize}, null, 1));
} catch(e) { console.log('XTIUSD info ERROR:', e.message); }
try {
  const spot = await client.getSpotPrice('XTIUSD');
  console.log('\n=== XTIUSD spot ===');
  console.log(JSON.stringify(spot));
} catch(e) { console.log('XTIUSD spot ERROR:', e.message); }
await client.disconnect();
process.exit(0);
