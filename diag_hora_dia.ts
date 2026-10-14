// Análisis hora-del-día GBPUSD: volatilidad por hora + vela M1 alrededor del cierre de hoy 21:00 UTC
import { TrendbarPeriod } from 'ctrader-ts';
import { connectCTrader } from './src/services/ctrader.js';

async function getCandlesChunk(ticker: string, period: TrendbarPeriod, count: number, toTimestamp: number): Promise<any[]> {
  const { ctClient } = await import('./src/services/ctrader.js');
  const info = await (ctClient as any).getSymbolInfo('GBPUSD');
  const res = await (ctClient as any).raw.market.getTrendbars({
    symbolId: info.symbolId, period, fromTimestamp: toTimestamp - 60000 * 5 * count, toTimestamp
  });
  if (!res || !res.trendbars) return [];
  const divider = 100000;
  return res.trendbars.map((tb: any) => ({
    ts: (tb.utcTimestampInMinutes || 0) * 60000,
    open: (tb.low + (tb.deltaOpen || 0)) / divider,
    high: (tb.low + (tb.deltaHigh || 0)) / divider,
    low: tb.low / divider,
    close: (tb.low + (tb.deltaClose || 0)) / divider,
  }));
}

async function main() {
  await connectCTrader();
  // 1) M1 alrededor del cierre (20:30-21:20 UTC de hoy)
  const m1 = await getCandlesChunk('GBPUSD', TrendbarPeriod.M1, 60, Date.UTC(2026, 8, 7, 21, 20));
  const pip = 0.0001;
  console.log('=== M1 GBPUSD 20:20-21:20 UTC (hoy) ===');
  let prev = null;
  for (const c of m1) {
    const d = new Date(c.ts);
    if (d.getUTCHours() < 20) continue;
    const range = (c.high - c.low) / pip;
    let mark = '';
    if (d.getUTCMinutes() === 0) mark = ' << 21:00 UTC (18:00 ARG, rollover)';
    console.log(`${d.toISOString().slice(11,16)}Z O=${c.open.toFixed(5)} H=${c.high.toFixed(5)} L=${c.low.toFixed(5)} C=${c.close.toFixed(5)} rango=${range.toFixed(1)} pips${mark}`);
    prev = c;
  }
  // 2) M5 últimos ~25 días → perfil horario
  const all: any[] = [];
  let to = Date.now();
  for (let i = 0; i < 9; i++) {
    const chunk = await getCandlesChunk('GBPUSD', TrendbarPeriod.M5, 1000, to);
    if (!chunk.length) break;
    all.push(...chunk);
    to = chunk[0].ts - 60000;
  }
  // dedupe + sort
  const map = new Map<number, any>();
  for (const c of all) map.set(c.ts, c);
  const candles = [...map.values()].sort((a, b) => a.ts - b.ts);
  console.log(`\n=== M5 GBPUSD: ${candles.length} velas, ${new Date(candles[0].ts).toISOString().slice(0,10)} → ${new Date(candles[candles.length-1].ts).toISOString().slice(0,10)} ===`);

  const byHourUTC = new Map<number, number[]>();
  const byHourARG = new Map<number, number[]>();
  for (const c of candles) {
    const d = new Date(c.ts);
    const r = (c.high - c.low) / pip;
    const hUTC = d.getUTCHours();
    const hARG = (d.getUTCHours() + 24 - 3) % 24; // ARG = UTC-3
    if (!byHourUTC.has(hUTC)) byHourUTC.set(hUTC, []);
    byHourUTC.get(hUTC)!.push(r);
    if (!byHourARG.has(hARG)) byHourARG.set(hARG, []);
    byHourARG.get(hARG)!.push(r);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const p90 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(0.9 * s.length)]; };
  const mx = (a: number[]) => Math.max(...a);

  console.log('\n=== Rango medio M5 por hora (ARG, UTC-3) — pips ===');
  console.log('hora ARG | n velas | rango medio | p90 | max');
  for (let h = 0; h < 24; h++) {
    const a = byHourARG.get(h) || [];
    if (!a.length) continue;
    console.log(`${String(h).padStart(2)}:00  | ${String(a.length).padStart(6)} | ${avg(a).toFixed(2).padStart(9)} | ${p90(a).toFixed(2).padStart(5)} | ${mx(a).toFixed(1)}`);
  }
  console.log('\n=== Rango medio M5 por hora (UTC) — pips ===');
  for (let h = 0; h < 24; h++) {
    const a = byHourUTC.get(h) || [];
    if (!a.length) continue;
    console.log(`${String(h).padStart(2)}:00  | ${String(a.length).padStart(6)} | ${avg(a).toFixed(2).padStart(9)} | ${p90(a).toFixed(2).padStart(5)} | ${mx(a).toFixed(1)}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
