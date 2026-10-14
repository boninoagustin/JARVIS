// probe_symbols2.ts — minVolume/stepVolume/lotSize de los no-forex
import dotenv from 'dotenv';
dotenv.config({ path: '/opt/JARVIS/.env' });
const { connect } = await import('ctrader-ts');
const client = await connect({
  clientId: process.env.CTRADER_CLIENT_ID || '',
  clientSecret: process.env.CTRADER_CLIENT_SECRET || '',
  accessToken: process.env.CTRADER_ACCESS_TOKEN || '',
  accountId: parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10),
  environment: (process.env.CTRADER_DEMO || 'true') === 'true' ? 'demo' : 'live',
});
for (const sym of ['XAGUSD', 'BTCUSD', 'ETHUSD', 'US30', 'US500', 'GER40', 'XTIUSD']) {
  try {
    const info: any = await client.getSymbolInfo(sym);
    console.log(sym, '=> minVolume:', info?.minVolume, '| stepVolume:', info?.stepVolume, '| lotSize:', info?.lotSize, '| maxVolume:', info?.maxVolume);
  } catch (e: any) {
    console.log(sym, '=> ERROR:', e?.message || e);
  }
}
client.disconnect();
process.exit(0);
