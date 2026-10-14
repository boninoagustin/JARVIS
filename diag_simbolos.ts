// Listar símbolos del broker para evaluar nuevos activos
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/JARVIS/.env','utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}
const { connect } = await import('ctrader-ts');
const client = await connect({
  clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
  accessToken: process.env.CTRADER_ACCESS_TOKEN,
  accountId: parseInt(process.env.CTRADER_ACCOUNT_ID,10)||0,
  environment: process.env.CTRADER_DEMO === 'true' ? 'demo':'live',
});
try {
  const syms: any[] = await client.getSymbols();
  console.log('total símbolos:', syms.length);
  const nombres = syms.map((s: any) => String(s.symbolName || s.name || '').toUpperCase());
  const candidatos = ['GBPJPY','AUDUSD','XAGUSD','GER40','DE40','US30','USDCHF','ETHUSD','AUDJPY','NZDJPY','EURGBP','EURJPY','EURCHF','GBPCHF','XNGUSD','US2000','NAS100','US100','SPX500'];
  console.log('=== candidatos ===');
  for (const c of candidatos) {
    const hits = nombres.filter(n => n.includes(c)).slice(0, 3);
    console.log(c, '→', hits.length ? hits.join(' | ') : 'NO ESTÁ');
  }
  console.log('=== forex (pares 6 letras) ===');
  console.log(nombres.filter(n => /^[A-Z]{6}$/.test(n)).sort().join(' '));
} catch (e: any) { console.log('ERROR:', e.message); }
await client.disconnect();
process.exit(0);
