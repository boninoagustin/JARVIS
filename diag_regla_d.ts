// Medición de barridos del rollover: spikes del bid (velas) vs fills reales de SL (deals)
// 1) M1 GBPUSD últimos 12 días: spike up/down en 21:00-21:20 UTC vs close de 20:25 UTC
// 2) M1 de los días de SL barridos: ver si el movimiento fue real o spread
import { TrendbarPeriod } from 'ctrader-ts';
import { connectCTrader } from './src/services/ctrader.js';

async function fetchM1(symbolId: number, from: number, to: number): Promise<any[]> {
  const { ctClient } = await import('./src/services/ctrader.js');
  const res = await (ctClient as any).raw.market.getTrendbars({
    symbolId, period: TrendbarPeriod.M1, fromTimestamp: from, toTimestamp: to
  });
  if (!res || !res.trendbars) return [];
  const divider = 100000;
  return res.trendbars.map((tb: any) => ({
    ts: (tb.utcTimestampInMinutes || 0) * 60000,
    o: (tb.low + (tb.deltaOpen || 0)) / divider,
    h: (tb.low + (tb.deltaHigh || 0)) / divider,
    l: tb.low / divider,
    c: (tb.low + (tb.deltaClose || 0)) / divider,
  }));
}

async function main() {
  await connectCTrader();
  const { ctClient } = await import('./src/services/ctrader.js');
  const gbp = await (ctClient as any).getSymbolInfo('GBPUSD');
  const jpy = await (ctClient as any).getSymbolInfo('USDJPY');
  const pip = 0.0001;

  console.log('=== 1) GBPUSD M1: barrido bid en 21:00-21:20 UTC vs close 20:25 (últimos 12 días) ===');
  for (let d = 0; d < 12; d++) {
    const dayStart = Date.UTC(2026, 8, 7) - d * 864e5;
    const from = dayStart + 20.0 * 3600e3;
    const to = dayStart + 21.5 * 3600e3;
    const bars = await fetchM1(gbp.symbolId, from, to);
    if (bars.length < 3) { console.log(`${new Date(dayStart).toISOString().slice(0,10)}: sin datos`); continue; }
    const pre = bars.filter(b => { const dd = new Date(b.ts); return dd.getUTCHours() === 20; }).pop();
    const post = bars.filter(b => { const dd = new Date(b.ts); return dd.getUTCHours() === 21 && dd.getUTCMinutes() <= 20; });
    if (!pre || !post.length) continue;
    const ref = pre.c;
    const maxH = Math.max(...post.map(b => b.h));
    const minL = Math.min(...post.map(b => b.l));
    console.log(`${new Date(dayStart).toISOString().slice(0,10)}: ref(20:2x)=${ref.toFixed(5)} | spikeUP=${((maxH-ref)/pip).toFixed(1)}p | spikeDOWN=${((ref-minL)/pip).toFixed(1)}p`);
  }

  console.log('\n=== 2) Días de SL barridos: ¿movimiento real del bid o spread? ===');
  const casos = [
    { sym: gbp, day: '2026-08-21', dir: 'BUY', sl: 1.36267, fill: null },
    { sym: jpy, day: '2026-09-01', dir: 'BUY', sl: 160.126, fill: null },
    { sym: gbp, day: '2026-09-07', dir: 'SELL', sl: 1.35519, fill: 1.35522 },
  ];
  for (const c of casos) {
    const dayStart = Date.parse(c.day + 'T00:00:00Z');
    const bars = await fetchM1(c.sym.symbolId, dayStart + 20.5 * 3600e3, dayStart + 21.5 * 3600e3);
    const post = bars.filter(b => new Date(b.ts).getUTCHours() === 21);
    if (!post.length) { console.log(`${c.day}: sin datos`); continue; }
    const minL = Math.min(...post.map(b => b.l));
    const maxH = Math.max(...post.map(b => b.h));
    if (c.dir === 'BUY') {
      console.log(`${c.day} ${c.sym.symbolId===gbp.symbolId?'GBPUSD':'USDJPY'} BUY SL=${c.sl}: low real del bid 21:00-21:59 = ${minL.toFixed(5)} → ${minL <= c.sl ? `el BID SÍ tocó el SL (mov real)` : `el bid NO tocó el SL → fue SPREAD (fill=${c.fill ?? '?'})`}`);
    } else {
      console.log(`${c.day} GBPUSD SELL SL=${c.sl}: high real del bid 21:00-21:59 = ${maxH.toFixed(5)} → ${maxH >= c.sl ? `el BID SÍ tocó el SL` : `el bid NO tocó el SL (max ${maxH.toFixed(5)}) → fue SPREAD (fill=${c.fill})`}`);
    }
  }

  // 3) Para la regla D: ¿con SL+20 pips, qué pasaba después del rollover? (caso de hoy)
  console.log('\n=== 3) Caso 07-09 GBPUSD SELL: post-rollover hasta ahora (M15) ===');
  const res = await (ctClient as any).raw.market.getTrendbars({
    symbolId: gbp.symbolId, period: TrendbarPeriod.M15,
    fromTimestamp: Date.parse('2026-09-07T21:00:00Z'), toTimestamp: Date.now()
  });
  for (const tb of res.trendbars) {
    const d = new Date((tb.utcTimestampInMinutes || 0) * 60000);
    console.log(`${d.toISOString().slice(5,16)}Z O=${((tb.low+(tb.deltaOpen||0))/100000).toFixed(5)} H=${((tb.low+(tb.deltaHigh||0))/100000).toFixed(5)} L=${(tb.low/100000).toFixed(5)} C=${((tb.low+(tb.deltaClose||0))/100000).toFixed(5)}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
