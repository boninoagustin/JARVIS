// check_symbol_mins.ts — lee minVolume/stepVolume/lotSize REALES del broker para los activos del bot.
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/JARVIS/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { connect } = await import('ctrader-ts');
const client = await connect({
  clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
  accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: parseInt(process.env.CTRADER_ACCOUNT_ID!, 10) || 0,
  environment: process.env.CTRADER_DEMO === 'true' ? 'demo' : 'live',
});
console.log('[SYMS] conectado, consultando símbolos...');

const want = ['XAUUSD', 'XAGUSD', 'USOIL', 'GER40', 'US500', 'JP225', 'NAS100', 'GBPUSD', 'GBPJPY', 'USDJPY', 'EURUSD', 'AUDJPY', 'BTCUSD', 'NZDUSD', 'USDCAD', 'AUDCAD'];
const syms: any[] = await client.getSymbols();
const found = new Map<number, any>();
for (const s of syms) {
  const n = String(s.symbolName ?? '').toUpperCase();
  if (want.includes(n)) found.set(n, s);
}
console.log('\n=== Catálogo (LightSymbol) ===');
for (const n of want) {
  const s = found.get(n);
  console.log(`${n.padEnd(8)} ${s ? `id=${s.symbolId}` : 'NO EN CATÁLOGO'}`);
}

console.log('\n=== Detalle (getSymbolDetails → minVolume/stepVolume/lotSize) ===');
const ids = [...found.values()].map(s => s.symbolId);
const details: any[] = await client.getSymbolDetails(ids);
for (const d of details) {
  const name = String(d.name ?? d.symbolName ?? '?').toUpperCase();
  const lotSize = d.lotSize ?? d.lot_size;
  const minV = d.minVolume ?? d.min_volume;
  const stepV = d.stepVolume ?? d.step_volume;
  console.log(`${name.padEnd(8)} lotSize=${lotSize} minVolume=${minV}${lotSize ? ` (${(minV / lotSize).toFixed(3)} lotes)` : ''} stepVolume=${stepV}`);
}

try { await (client as any).disconnect?.(); } catch { }
console.log('\n[SYMS] desconectado.');
process.exit(0);
