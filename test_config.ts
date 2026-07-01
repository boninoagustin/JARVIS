import { assetSessionConfigs, dynamicBotConfig } from './src/db/trading.js';
import { db } from './src/db/memory.js';

function getCurrentSession(nowMs?: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' {
    const now = nowMs ? new Date(nowMs) : new Date();
    const dayName = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' });
    if (dayName === 'Sat' || dayName === 'Sun') {
        return 'OFF';
    }
    const arStr = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', minute: 'numeric', hour12: false });
    const [hourStr, minStr] = arStr.split(':');
    const h = parseInt(hourStr);
    const m = parseInt(minStr || '0');
    const t = h + m / 60;
    if (t >= 21 || t < 4) return 'ASIA';
    if (t >= 4 && t < 10.5) return 'LONDON';
    if (t >= 10.5 && t < 17) return 'NY';
    return 'OFF';
}

async function run() {
  if (!db) return;
  const doc = await db.collection('asset_configs').doc('NAS100').get();
  
  const configRaw = doc.data();
  // Simulate getConfigForTicker
  const ticker = 'NAS100';
  const session = 'OFF';
  
  let config = configRaw; // assume assetSessionConfigs.get(ticker) returned this
  
  const sessionConfig = config.sessions ? config.sessions[session] : undefined;
  const result = {
      ...dynamicBotConfig,
      minPointsForBuy: config.minPointsForBuy ?? dynamicBotConfig.minPointsForBuy,
      minPointsForSell: config.minPointsForSell ?? dynamicBotConfig.minPointsForSell,
      slBufferPercent: sessionConfig?.slBufferPercent ?? config.slBufferPercent ?? dynamicBotConfig.slBufferPercent,
      fixedRR: sessionConfig?.fixedRR ?? config.fixedRR ?? dynamicBotConfig.fixedRR,
      oteEntryPercent: config.oteEntryPercent ?? dynamicBotConfig.oteEntryPercent,
      entryTrigger: config.entryTrigger ?? dynamicBotConfig.entryTrigger,
      sessionEnabled: config.enabled ?? true,
      sessions: config.sessions as any
  };
  console.log("sessionEnabled for NAS100 in OFF session:", result.sessionEnabled);
  
  process.exit(0);
}
run();
