// Simulación: cerrar todo a las 20:20 UTC (17:20 ARG) vs resultado real
import { TrendbarPeriod } from 'ctrader-ts';
import { connectCTrader } from './src/services/ctrader.js';

const SIMS = [
  { sym: 'GBPUSD', day: '2026-08-21', dir: 'BUY', entry: 1.36445, lots: 0.36, real: -51.8 },
  { sym: 'USDJPY', day: '2026-09-01', dir: 'BUY', entry: 160.251, lots: 0.33, real: -31.12 },
  { sym: 'USDJPY', day: '2026-08-26', dir: 'SELL', entry: 159.365, lots: 0.33, real: 0 },
  { sym: 'GBPUSD', day: '2026-09-07', dir: 'SELL', entry: 1.35396, lots: 0.36, real: -47.31 },
];

async function main() {
  await connectCTrader();
  const { ctClient } = await import('./src/services/ctrader.js');
  for (const s of SIMS) {
    const info = await (ctClient as any).getSymbolInfo(s.sym);
    const dayStart = Date.parse(s.day + 'T00:00:00Z');
    // M5 desde 19:30 a 21:15 UTC
    const res = await (ctClient as any).raw.market.getTrendbars({
      symbolId: info.symbolId, period: TrendbarPeriod.M5, fromTimestamp: dayStart + 19.5 * 3600e3, toTimestamp: dayStart + 21.25 * 3600e3
    });
    if (!res || !res.trendbars) { console.log(`${s.day} ${s.sym}: sin datos`); continue; }
    const divider = 100000;
    const bars = res.trendbars.map((tb: any) => ({
      ts: (tb.utcTimestampInMinutes || 0) * 60000,
      close: (tb.low + (tb.deltaClose || 0)) / divider,
    }));
    // candle de las 20:20
    const bar2020 = bars.find(b => new Date(b.ts).getUTCHours() === 20 && new Date(b.ts).getUTCMinutes() === 20);
    const bar2025 = bars.find(b => new Date(b.ts).getUTCHours() === 20 && new Date(b.ts).getUTCMinutes() === 25);
    const pip = s.sym.includes('JPY') ? 0.01 : 0.0001;
    const spreadPips = 0.5; // costo de cierre
    const sim = (bar: any, label: string) => {
      if (!bar) { console.log(`${s.day} ${s.sym}: sin vela ${label}`); return; }
      const px = bar.close;
      const exit = s.dir === 'BUY' ? px - spreadPips * pip : px + spreadPips * pip;
      const diff = (exit - s.entry) * (s.dir === 'BUY' ? 1 : -1);
      const pnl = diff / pip * 10 * s.lots;
      console.log(`${s.day} ${s.sym} ${s.dir}: ${label} close=${px.toFixed(5)} → exit=${exit.toFixed(5)} | PnL sim=${pnl.toFixed(2)} vs real=${s.real}`);
    };
    sim(bar2020, '20:20Z');
    sim(bar2025, '20:25Z');
    // última vela antes del gap
    const before = bars.filter(b => { const d = new Date(b.ts); return d.getUTCHours() === 20 && d.getUTCMinutes() <= 29; });
    if (before.length) sim(before[before.length-1], 'última');
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
