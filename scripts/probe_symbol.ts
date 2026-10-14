// probe_symbol.ts — minVolume/stepVolume/lotSize reales de XAUUSD y EURUSD
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
for (const sym of ['XAUUSD', 'EURUSD']) {
  try {
    const info = await client.getSymbolInfo(sym);
    const pick = (o: any, keys: string[]) => {
      const out: any = {};
      for (const k of keys) { const v = o?.[k]; if (v !== undefined && v !== null) out[k] = v; }
      return out;
    };
    console.log(sym, '=>', JSON.stringify(pick(info, ['symbolId', 'minVolume', 'stepVolume', 'lotSize', 'maxVolume', 'pipValue', 'quoteSessions'])));
  } catch (e: any) {
    console.log(sym, '=> ERROR:', e?.message || e);
  }
}
client.disconnect();
process.exit(0);
