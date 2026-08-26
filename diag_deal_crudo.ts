// Verificar deal crudo del parcial USOIL (posID 285032841)
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
const from = Date.now() - 2*864e5;
const deals = await client.getDealsByPosition('285032841', from, Date.now());
for (const d of deals) {
  console.log('=== DEAL crudo ===');
  console.log(JSON.stringify({
    volume: d.volume,
    filledVolume: d.filledVolume,
    executionPrice: d.executionPrice,
    dealStatus: d.dealStatus,
    createTimestamp: d.createTimestamp,
    moneyDigits: d.moneyDigits,
    closePositionDetail: d.closePositionDetail,
  }, null, 1));
}
// Info del símbolo para validar contract size
const info = await client.getSymbolInfo(10092);
console.log('=== SYMBOL INFO (XTIUSD) ===');
console.log(JSON.stringify({symbolId: info?.symbolId, lotSize: info?.lotSize, stepVolume: info?.stepVolume, digits: info?.digits}, null, 1));
await client.disconnect();
process.exit(0);
