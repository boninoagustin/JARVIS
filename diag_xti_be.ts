// Fix XTIUSD (divider 100) + chequeo retrace a BE post-20:20 para EURUSD 08-20 WIN
import { TrendbarPeriod } from 'ctrader-ts';
import { connectCTrader } from './src/services/ctrader.js';

async function main() {
  await connectCTrader();
  const { ctClient } = await import('./src/services/ctrader.js');

  // 1) XTIUSD 08-21: M5 19:30-21:15
  const info1 = await (ctClient as any).getSymbolInfo('XTIUSD');
  const res1 = await (ctClient as any).raw.market.getTrendbars({
    symbolId: info1.symbolId, period: TrendbarPeriod.M5,
    fromTimestamp: Date.parse('2026-08-21T19:30:00Z'), toTimestamp: Date.parse('2026-08-21T21:15:00Z')
  });
  const bars1 = (res1.trendbars || []).map((tb: any) => ({
    ts: (tb.utcTimestampInMinutes || 0) * 60000,
    close: (tb.low + (tb.deltaClose || 0)) / 100, // oil: 2 decimales
  }));
  const find = (min: number) => bars1.find(b => { const d = new Date(b.ts); return d.getUTCHours() === 20 && d.getUTCMinutes() === min; });
  for (const m of [20, 25, 29]) {
    const b = find(m);
    if (b) {
      const exit = b.close - 0.03; // spread oil ~3 centavos
      const pnl = (exit - 87.23) * 100 * 0.3; // $1 por centavo? oil: 1 cent = $10/lot → 0.3 lots = $3/cent... cTrader XTIUSD 1 lot = 1000 barriles? 0.3*1000*0.01=3
      console.log(`XTIUSD 08-21 20:${m}Z close=${b.close} → PnL sim (3$/cent)=${pnl.toFixed(2)} vs real -54.78`);
    }
  }

  // 2) EURUSD 08-20 20:20 → 08-21 08:45: ¿tocó bid <= 1.1675 (BE)?
  const info2 = await (ctClient as any).getSymbolInfo('EURUSD');
  const res2 = await (ctClient as any).raw.market.getTrendbars({
    symbolId: info2.symbolId, period: TrendbarPeriod.M5,
    fromTimestamp: Date.parse('2026-08-20T20:20:00Z'), toTimestamp: Date.parse('2026-08-21T08:50:00Z')
  });
  const bars2 = (res2.trendbars || []).map((tb: any) => ({
    ts: (tb.utcTimestampInMinutes || 0) * 60000,
    low: tb.low / 100000,
  }));
  const touchBE = bars2.filter(b => b.low <= 1.1675);
  console.log(`\nEURUSD 08-20→08-21: ${bars2.length} velas M5 | velas con low <= BE(1.1675): ${touchBE.length}`);
  if (touchBE.length) {
    const first = new Date(touchBE[0].ts);
    console.log(`  → PRIMERA vez que toca BE: ${first.toISOString().slice(5,16)}Z (low=${touchBE[0].low.toFixed(5)})`);
  }
  const roll21 = bars2.filter(b => { const d = new Date(b.ts); return d.getUTCHours() === 21; });
  if (roll21.length) {
    const lo = Math.min(...roll21.map(b => b.low));
    console.log(`  → low mínimo de la hora 21:00-21:59 UTC: ${lo.toFixed(5)} (BE=1.1675, SL=1.16622) — ¿el barrido alcanzó SL/BE? ${lo <= 1.1675 ? 'SÍ tocó BE' : 'NO'}`);
  }

  // 3) EURUSD 08-18: ¿el barrido de las 21:00 estuvo cerca del SL 1.15644?
  const res3 = await (ctClient as any).raw.market.getTrendbars({
    symbolId: info2.symbolId, period: TrendbarPeriod.M5,
    fromTimestamp: Date.parse('2026-08-18T20:20:00Z'), toTimestamp: Date.parse('2026-08-18T22:30:00Z')
  });
  const bars3 = (res3.trendbars || []).map((tb: any) => ({
    ts: (tb.utcTimestampInMinutes || 0) * 60000,
    low: tb.low / 100000,
  }));
  if (bars3.length) {
    const lo = Math.min(...bars3.map(b => b.low));
    console.log(`\nEURUSD 08-18 20:20-22:30: low mínimo=${lo.toFixed(5)} | SL=1.15644 → distancia mínima al SL: ${((lo-1.15644)*10000).toFixed(1)} pips`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
