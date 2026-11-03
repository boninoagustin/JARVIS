#!/usr/bin/env tsx
/**
 * Refresca scripts/ops/symbol_caps.json (min/max/step/lotSize por símbolo).
 *
 * Para qué: la auditoría post-trade distingue "el bot arriesgó de menos porque el
 * bróker topa el volumen" (caso JP225: maxVolume=10 lotes → ~$13,7 de riesgo máximo)
 * de un desvío real. Si se cambia de bróker o el bróker cambia los topes, correr esto.
 *
 * Uso: npx tsx scripts/ops/symbol_caps_refresh.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/opt/JARVIS';
const ENV = path.join(REPO, '.env');
for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { connect } = await import('ctrader-ts');
const client = await connect({
  clientId: process.env.CTRADER_CLIENT_ID!, clientSecret: process.env.CTRADER_CLIENT_SECRET!,
  accessToken: process.env.CTRADER_ACCESS_TOKEN!, accountId: parseInt(process.env.CTRADER_ACCOUNT_ID!, 10),
  environment: process.env.CTRADER_DEMO === 'true' ? 'demo' : 'live',
});
const names: Record<string, string> = {
  AUDCAD: 'AUDCAD', AUDJPY: 'AUDJPY', AUDNZD: 'AUDNZD', CHFJPY: 'CHFJPY', EUROPE50: 'EUROPE 50',
  EURUSD: 'EURUSD', FRA40: 'FRANCE 40', GBPAUD: 'GBPAUD', GBPUSD: 'GBPUSD', JP225: 'JAPAN 225',
  NL25: 'NETHERLANDS 25', NZDUSD: 'NZDUSD', USDCAD: 'USDCAD', USDJPY: 'USDJPY', USOIL: 'XTIUSD',
  USTECH100: 'US TECH 100', XAGUSD: 'XAGUSD', XAUUSD: 'XAUUSD', XBRUSD: 'XBRUSD',
  XPDUSD: 'XPDUSD', XPTUSD: 'XPTUSD', NATGAS: 'NAT.GAS',
};
const symbols: Record<string, any> = {};
for (const [ticker, brokerName] of Object.entries(names)) {
  try {
    const i = await client.getSymbolInfo(brokerName);
    if (i?.symbolId) symbols[ticker] = { minVolume: i.minVolume, maxVolume: i.maxVolume, stepVolume: i.stepVolume, lotSize: i.lotSize };
  } catch { /* símbolo ausente en este bróker */ }
}
fs.writeFileSync(path.join(REPO, 'scripts/ops/symbol_caps.json'),
  JSON.stringify({ updatedAt: new Date().toISOString(), source: 'cTrader getSymbolInfo', symbols }, null, 2));
console.log(`caps guardados: ${Object.keys(symbols).length} símbolos`);
await client.disconnect();
process.exit(0);
