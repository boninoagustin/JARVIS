// diag_dxy3.js — volcar nameToId completo y buscar dollar/index
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
await client.refreshSymbols();

const n2i = client.symbols?.nameToId;
const i2s = client.symbols?.idToSymbol;
console.log('nameToId:', n2i instanceof Map ? `Map(${n2i.size})` : typeof n2i, '| idToSymbol:', i2s instanceof Map ? `Map(${i2s.size})` : typeof i2s);

if (i2s instanceof Map && i2s.size > 0) {
  const all = [...i2s.values()].map(v => typeof v === 'object' ? (v.symbolName ?? v.name) : v);
  console.log(`\n=== TODOS LOS SIMBOLOS (${all.length}) ===`);
  console.log(all.sort().join(', '));
} else if (n2i instanceof Map) {
  console.log('\n=== nameToId keys ===');
  console.log([...n2i.keys()].sort().join(', '));
}
await client.disconnect();
process.exit(0);
