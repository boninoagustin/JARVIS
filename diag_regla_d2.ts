// Seguimiento post-rollover de los casos 21/08 GBPUSD y 01/09 USDJPY (M5/M15)
import { TrendbarPeriod } from 'ctrader-ts';
import { connectCTrader } from './src/services/ctrader.js';

async function main() {
  await connectCTrader();
  const { ctClient } = await import('./src/services/ctrader.js');
  const gbp = await (ctClient as any).getSymbolInfo('GBPUSD');
  const jpy = await (ctClient as any).getSymbolInfo('USDJPY');
  const divider = 100000;
  const get = async (sid: number, period: TrendbarPeriod, from: number, to: number) => {
    const res = await (ctClient as any).raw.market.getTrendbars({ symbolId: sid, period, fromTimestamp: from, toTimestamp: to });
    return (res.trendbars || []).map((tb: any) => ({
      ts: (tb.utcTimestampInMinutes || 0) * 60000,
      h: (tb.low + (tb.deltaHigh || 0)) / divider,
      l: tb.low / divider,
      c: (tb.low + (tb.deltaClose || 0)) / divider,
    }));
  };

  // 1) GBPUSD 21/08: 21:00-23:00 UTC M5 — ¿el bid bajó de verdad hasta SL 1.36267?
  console.log('=== GBPUSD 21/08 21:00-23:00Z (M5) — BUY SL=1.36267, TP1=1.36583, TP2=1.36730 ===');
  const b1 = await get(gbp.symbolId, TrendbarPeriod.M5, Date.parse('2026-08-21T21:00:00Z'), Date.parse('2026-08-21T23:00:00Z'));
  for (const b of b1) {
    const d = new Date(b.ts);
    console.log(`${d.toISOString().slice(11,16)}Z H=${b.h.toFixed(5)} L=${b.l.toFixed(5)} C=${b.c.toFixed(5)}${b.l <= 1.36267 ? '  << tocó SL' : ''}`);
  }

  // 2) USDJPY 01/09: 21:00-23:59Z M15 — BUY SL=160.126 (real), TP1=160.376, TP2=160.626
  console.log('\n=== USDJPY 01/09 21:00-23:59Z (M15) — BUY SL=160.126, TP1=160.376 ===');
  const b2 = await get(jpy.symbolId, TrendbarPeriod.M15, Date.parse('2026-09-01T21:00:00Z'), Date.parse('2026-09-02T00:00:00Z'));
  for (const b of b2) {
    const d = new Date(b.ts);
    console.log(`${d.toISOString().slice(11,16)}Z H=${b.h.toFixed(3)} L=${b.l.toFixed(3)} C=${b.c.toFixed(3)}${b.l <= 160.126 ? '  << tocó SL' : ''}${b.h >= 160.376 ? '  << tocó TP1' : ''}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
