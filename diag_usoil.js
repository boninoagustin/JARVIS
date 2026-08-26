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
// 1. ¿Existe el símbolo XTIUSD?
try {
  const info = await client.getSymbolInfo('XTIUSD');
  console.log('XTIUSD info:', JSON.stringify({symbolId: info.symbolId, lotSize: info.lotSize, stepVolume: info.stepVolume, minVolume: info.minVolume, maxVolume: info.maxVolume, digits: info.digits, pipSize: info.pipSize}));
} catch(e) { console.log('XTIUSD ERROR:', e.message); }
// 2. ¿Qué símbolos de oil/WTI hay disponibles?
try {
  const syms = await client.getSymbols();
  const oil = (syms||[]).filter(s => /OIL|XTI|WTI|BRENT|USOIL/i.test(s.symbolName || ''));
  console.log('\nSímbolos OIL disponibles:', (oil||[]).map(s => s.symbolName).join(', ') || 'NINGUNO');
} catch(e) { console.log('getSymbols ERROR:', e.message); }
// 3. Precio actual
try {
  const spot = await client.getSpotPrice('XTIUSD');
  console.log('\nXTIUSD spot:', JSON.stringify(spot));
} catch(e) { console.log('XTIUSD spot ERROR:', e.message); }
await client.disconnect();
process.exit(0);
