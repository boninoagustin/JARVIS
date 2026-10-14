// Simulación completa: flatten a 20:20 / 20:25 / 20:29 UTC en el día de entrada
import { TrendbarPeriod } from 'ctrader-ts';
import { connectCTrader } from './src/services/ctrader.js';

const SIMS = [
  { sym: 'GBPUSD', day: '2026-08-20', dir: 'BUY', entry: 1.36263, lots: 0.3, real: -1.1, note: 'SKIP dup A' },
  { sym: 'GBPUSD', day: '2026-08-20', dir: 'BUY', entry: 1.36263, lots: 0.3, real: -2.19, note: 'dup B' },
  { sym: 'GBPUSD', day: '2026-08-21', dir: 'BUY', entry: 1.36445, lots: 0.28, real: -51.8, note: 'hasta 08-23' },
  { sym: 'XTIUSD', day: '2026-08-21', dir: 'BUY', entry: 87.23, lots: 0.3, real: -54.78, note: 'hasta 08-24' },
  { sym: 'EURUSD', day: '2026-08-18', dir: 'BUY', entry: 1.15793, lots: 0.31, real: 120.54, note: 'WIN r2.61' },
  { sym: 'EURUSD', day: '2026-08-18', dir: 'BUY', entry: 1.15789, lots: 0.3, real: 0, note: 'BE' },
  { sym: 'EURUSD', day: '2026-08-20', dir: 'BUY', entry: 1.1675, lots: 0.3, real: 78.96, note: 'WIN r1.5' },
  { sym: 'USDJPY', day: '2026-08-21', dir: 'SELL', entry: 158.927, lots: 0.3, real: -25, note: 'hasta 08-24' },
  { sym: 'USDJPY', day: '2026-08-26', dir: 'SELL', entry: 159.365, lots: 0.33, real: 0, note: 'BE' },
  { sym: 'USDJPY', day: '2026-09-01', dir: 'BUY', entry: 160.251, lots: 0.38, real: -31.12, note: '' },
  { sym: 'GBPUSD', day: '2026-09-07', dir: 'SELL', entry: 1.35396, lots: 0.36, real: -47.31, note: 'hoy' },
];

async function main() {
  await connectCTrader();
  const { ctClient } = await import('./src/services/ctrader.js');
  let totReal = 0, tot2020 = 0, tot2025 = 0, tot2029 = 0;
  for (const s of SIMS) {
    const name = s.sym === 'XTIUSD' ? 'XTIUSD' : s.sym;
    const info = await (ctClient as any).getSymbolInfo(name);
    const dayStart = Date.parse(s.day + 'T00:00:00Z');
    const res = await (ctClient as any).raw.market.getTrendbars({
      symbolId: info.symbolId, period: TrendbarPeriod.M5, fromTimestamp: dayStart + 19.5 * 3600e3, toTimestamp: dayStart + 21.25 * 3600e3
    });
    if (!res || !res.trendbars) { console.log(`${s.day} ${s.sym}: sin datos`); continue; }
    const divider = 100000;
    const bars = res.trendbars.map((tb: any) => ({
      ts: (tb.utcTimestampInMinutes || 0) * 60000,
      close: (tb.low + (tb.deltaClose || 0)) / divider,
    }));
    const find = (min: number) => bars.find(b => { const d = new Date(b.ts); return d.getUTCHours() === 20 && d.getUTCMinutes() === min; });
    const pip = s.sym.includes('JPY') ? 0.01 : 0.0001;
    const spreadPips = 0.5;
    const pnlAt = (bar: any) => {
      if (!bar) return NaN;
      const exit = s.dir === 'BUY' ? bar.close - spreadPips * pip : bar.close + spreadPips * pip;
      const diff = (exit - s.entry) * (s.dir === 'BUY' ? 1 : -1);
      return diff / pip * 10 * s.lots;
    };
    const p2020 = pnlAt(find(20)), p2025 = pnlAt(find(25)), p2029 = pnlAt(find(29) || bars.filter(b => new Date(b.ts).getUTCHours() === 20).pop());
    totReal += s.real; tot2020 += p2020 || 0; tot2025 += p2025 || 0; tot2029 += p2029 || 0;
    console.log(`${s.day} ${s.sym.padEnd(7)} ${s.dir.padEnd(4)} @${s.entry} | real=${String(s.real).padStart(7)} | 20:20=${String(p2020.toFixed(2)).padStart(7)} | 20:25=${String(p2025.toFixed(2)).padStart(7)} | 20:29=${String(p2029.toFixed(2)).padStart(7)} | ${s.note}`);
  }
  console.log(`\nTOTALES: real=${totReal.toFixed(2)} | 20:20=${tot2020.toFixed(2)} | 20:25=${tot2025.toFixed(2)} | 20:29=${tot2029.toFixed(2)}`);
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
