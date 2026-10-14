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
try {
  const t = await client.getTickData('XTIUSD');
  console.log('XTIUSD tick:', JSON.stringify(t));
} catch(e) { console.log('getTickData ERR:', e.message); }
try {
  const t2 = await client.getTickData(10092);
  console.log('XTIUSD tick(id):', JSON.stringify(t2));
} catch(e) { console.log('getTickData(id) ERR:', e.message); }
await client.disconnect();
process.exit(0);
