// ¿A qué hora se corta el feed cada día (gap pre-rollover)? M1, últimos 12 días
import { TrendbarPeriod } from 'ctrader-ts';
import { connectCTrader } from './src/services/ctrader.js';

async function getChunk(symbolId: number, from: number, to: number): Promise<any[]> {
  const { ctClient } = await import('./src/services/ctrader.js');
  const res = await (ctClient as any).raw.market.getTrendbars({
    symbolId, period: TrendbarPeriod.M1, fromTimestamp: from, toTimestamp: to
  });
  if (!res || !res.trendbars) return [];
  return res.trendbars.map((tb: any) => (tb.utcTimestampInMinutes || 0) * 60000);
}

async function main() {
  await connectCTrader();
  const { ctClient } = await import('./src/services/ctrader.js');
  const info = await (ctClient as any).getSymbolInfo('GBPUSD');
  const sid = info.symbolId;

  // ventana 19:30–22:30 UTC de cada día (M1), últimos 12 días hábiles
  for (let d = 0; d < 12; d++) {
    const dayStart = Date.UTC(2026, 8, 7, 0, 0) - d * 864e5;
    const from = dayStart + 19.5 * 3600e3;
    const to = dayStart + 22.5 * 3600e3;
    const ts = await getChunk(sid, from, to);
    if (!ts.length) { console.log(`${new Date(dayStart).toISOString().slice(0,10)}: sin datos`); continue; }
    // encontrar el gap más grande
    let gaps: Array<[number, number]> = [];
    for (let i = 1; i < ts.length; i++) {
      const g = ts[i] - ts[i-1];
      if (g > 120000) gaps.push([ts[i-1], ts[i]]);
    }
    const last = new Date(ts[ts.length-1]);
    console.log(`${new Date(dayStart).toISOString().slice(0,10)}: velas=${ts.length} | ultima=${last.toISOString().slice(11,16)}Z` + gaps.map(g => ` | GAP ${new Date(g[0]).toISOString().slice(11,16)}Z→${new Date(g[1]).toISOString().slice(11,16)}Z (${Math.round((g[1]-g[0])/60000)}min)`).join(''));
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
