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
await client.refreshSymbols();
const want = ['NETHERLANDS 25','ITALY 40','FRANCE 40','GERMANY 40','US 500','JAPAN 225','XPTUSD','XAGUSD'];
for (const s of want) {
  try {
    const info = await client.getSymbolInfo(s);
    console.log(JSON.stringify({sym: s, id: info.symbolId, lotSize: info.lotSize, stepVolume: info.stepVolume, minVolume: info.minVolume, digits: info.digits, pipSize: info.pipSize}));
  } catch(e) { console.log(s, 'ERR:', e.message); }
}
await client.disconnect();
process.exit(0);
