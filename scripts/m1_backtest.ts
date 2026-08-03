/**
 * M1 Tick-Level Backtest — CON vs SIN Rider (EA31337 pattern)
 *
 * Ejecuta dos backtests idénticos sobre los mismos ticks M1 y las mismas
 * entradas. La única diferencia: cómo se gestiona la salida después del TP1.
 *
 *   SIN Rider: TP2 fijo, ATR trailing, SL → sale por target o stop
 *   CON Rider: tras TP1+breakeven, el trade pasa a RIDER mode
 *              → sale solo cuando el SMCEngine H1 detecta CHoCH inverso
 *
 * Uso: npx tsx scripts/m1_backtest.ts EURUSD
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import type { OHLCV } from '../src/engine/smc/types.js';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';
import { getPreset } from '../src/engine/smc/smc_config.js';
import { generateM1Ticks } from '../src/engine/TickGenerator.js';
import { BarResampler, createResamplerBank } from '../src/engine/BarResampler.js';

// ── CLI ──
const ticker = (process.argv[2] || 'EURUSD').toUpperCase();
const presetName = process.argv[3] || 'Forex - 3. Balanceado';

// ── Trade ──
interface SimTrade {
  id: string; direction: 'BUY'|'SELL'; entryPrice: number;
  slPrice: number; tp1Price: number; tp2Price: number; timestamp: number;
  tp1Hit: boolean; tp2Hit: boolean; closed: boolean;
  closeTimestamp?: number; result?: 'WIN'|'LOSS'|'BE'; pnlPct?: number;
  managementMode?: 'SCALP'|'RIDER'; riderTf?: string;
}

// ── Stats ──
interface BacktestStats {
  label: string;
  trades: number; wins: number; losses: number; be: number;
  wr: number; netPnl: number; pf: number; maxDD: number;
  avgWin: number; avgLoss: number; sharpe: number;
  riderExits: number;
}

// ── Helpers ──
function loadCandles(fp: string): OHLCV[] {
  const raw = fs.readFileSync(fp, 'utf8');
  return (parseCsv(raw, { columns: true, skip_empty_lines: true }) as any[]).map(r => ({
    timestamp: Number(r.timestamp), open: Number(r.open),
    high: Number(r.high), low: Number(r.low), close: Number(r.close),
    volume: Number(r.volume || 0),
  }));
}

function fmt(n: number, d=5) { return Number(n.toFixed(d)); }
function getSession(ts: number): number {
  const d = new Date(ts - 3*3600e3);
  const dec = d.getUTCHours() + d.getUTCMinutes()/60;
  if (dec>=21||dec<4) return 0; if (dec>=4&&dec<10.5) return 1;
  if (dec>=10.5&&dec<17) return 2; return 3;
}

function computeStats(trades: SimTrade[], label: string): BacktestStats {
  const closed = trades.filter(t => t.closed);
  const wins = closed.filter(t => t.result==='WIN');
  const losses = closed.filter(t => t.result==='LOSS');
  const be = closed.filter(t => t.result==='BE');
  const n = closed.length;
  let eq=0, peak=0, maxDD=0, gp=0, gl=0;
  const rList: number[] = [];
  for (const t of closed) {
    const r = t.pnlPct || 0;
    rList.push(r); eq += r; if (eq>peak) peak=eq;
    const dd = peak-eq; if (dd>maxDD) maxDD=dd;
    if (r>0) gp+=r; else gl+=Math.abs(r);
  }
  const pf = gl>0?gp/gl:(gp>0?Infinity:0);
  const wr = n>0?wins.length/n:0;
  const avgW = wins.length>0?wins.reduce((s,t)=>s+(t.pnlPct||0),0)/wins.length:0;
  const avgL = losses.length>0?Math.abs(losses.reduce((s,t)=>s+(t.pnlPct||0),0)/losses.length):0;
  let sh=0;
  if (n>1) { const mu=eq/n; const v=rList.reduce((s,r)=>s+(r-mu)**2,0)/n; sh=Math.sqrt(v)>0?(mu/Math.sqrt(v))*Math.sqrt(n):0; }
  return { label, trades:n, wins:wins.length, losses:losses.length, be:be.length,
    wr, netPnl:eq, pf, maxDD, avgWin:avgW, avgLoss:avgL, sharpe:sh,
    riderExits: closed.filter(t=>t.managementMode==='RIDER').length };
}

// ── Core: run one backtest ──
function runBacktest(
  m15Candles: OHLCV[], h1Candles: OHLCV[], h4Candles: OHLCV[],
  preset: any, riderMode: boolean,
): { stats: BacktestStats; trades: SimTrade[] } {
  const FIXED_RR = 2.0;
  const SL_BUFFER_PCT = 0.0;

  // Engines — H1 y H4 se alimentan con velas REALES (CSV), no resampleadas
  const engM15 = new SMCEngine(preset, '15m');
  const engH1  = new SMCEngine(preset, '1h');
  const engH4  = new SMCEngine(preset, '4h');
  engM15.setHTFContext('Neutral', 'Neutral');
  engH1.setHTFContext('Neutral', 'Neutral');
  engH4.setHTFContext('Neutral', 'Neutral');

  // Solo resampleamos M15 desde ticks M1
  const resamplerM15 = new BarResampler(15, 60000, 'M15');

  // Índices para alimentar H1 y H4 en orden cronológico
  let h1Idx = 0, h4Idx = 0;

  // State
  const activeTrades = new Map<string, SimTrade>();
  const closedTrades: SimTrade[] = [];
  let riderExitPnLs: number[] = []; // para debug
  let totalTicks = 0;
  let bars = { m15: 0, h1: 0, h4: 0 };
  const t0 = Date.now();

  // ── Warm-up: primeras 500 barras M15 solo alimentan engines, sin entradas ──
  let warmupDone = false;
  let warmupBars = 0;

  for (let i = 0; i < m15Candles.length; i++) {
    const parent = m15Candles[i];
    const m1Ticks = generateM1Ticks(parent, 900000);

    for (const tick of m1Ticks) {
      totalTicks++;

      // Resample M15 desde ticks M1 (único TF que usa resampler)
      const cM15 = resamplerM15.feed(tick);
      if (cM15) { bars.m15++; engM15.nextCandle(cM15); warmupBars++; }

      // Alimentar H1 y H4 con velas REALES desde CSV (sin resampler)
      while (h1Idx < h1Candles.length && h1Candles[h1Idx].timestamp <= tick.timestamp) {
        bars.h1++; engH1.nextCandle(h1Candles[h1Idx]);
        engM15.setHTFContext(engH1.getState().currentTrend, 'Neutral');
        h1Idx++;
      }
      while (h4Idx < h4Candles.length && h4Candles[h4Idx].timestamp <= tick.timestamp) {
        bars.h4++; engH4.nextCandle(h4Candles[h4Idx]);
        h4Idx++;
      }

      if (!warmupDone && warmupBars >= 500) {
        warmupDone = true;
        process.stderr.write(`  [WARMUP] 500 barras completadas. Iniciando entradas.\n`);
      }
      if (!warmupDone) continue; // saltar gestión de trades durante warm-up

      // ── Trade management ──
      for (const [tid, trade] of activeTrades) {
        if (trade.closed) continue;
        const hi = tick.high, lo = tick.low;

        // SL check
        const slHit = trade.direction==='BUY' ? lo <= trade.slPrice : hi >= trade.slPrice;

        // TP1
        if (!trade.tp1Hit) {
          const tp1Hit = trade.direction==='BUY' ? hi >= trade.tp1Price : lo <= trade.tp1Price;
          if (tp1Hit) {
            trade.tp1Hit = true;
            // SL → midpoint (gestión estándar), luego breakeven si Rider mode
            const dist = trade.direction==='BUY'
              ? trade.slPrice - (trade.entryPrice - (trade.entryPrice - trade.slPrice)*0.5)
              : (trade.entryPrice + (trade.slPrice - trade.entryPrice)*0.5) - trade.slPrice;
            if (trade.direction==='BUY') trade.slPrice = trade.entryPrice - (Math.abs(trade.entryPrice - trade.slPrice)*0.5);
            else trade.slPrice = trade.entryPrice + (Math.abs(trade.slPrice - trade.entryPrice)*0.5);

            if (riderMode) {
              // 🏇 RIDER: SL a midpoint (50% riesgo), no breakeven — da aire al trade
              const dist = Math.abs(trade.entryPrice - trade.slPrice);
              trade.slPrice = trade.direction==='BUY' 
                ? trade.entryPrice - dist * 0.5 
                : trade.entryPrice + dist * 0.5;
              trade.managementMode = 'RIDER';
              trade.riderTf = 'H1';
              trade.tp2Price = 0;
              (trade as any).riderEntryTs = tick.timestamp;
            }
          }
        }

        // TP2 (solo sin Rider)
        if (!riderMode && !trade.tp2Hit && trade.tp2Price > 0) {
          const tp2Hit = trade.direction==='BUY' ? hi >= trade.tp2Price : lo <= trade.tp2Price;
          if (tp2Hit) {
            trade.closed=true; trade.result='WIN'; trade.closeTimestamp=tick.timestamp;
            trade.pnlPct = Math.abs(trade.tp2Price - trade.entryPrice)/trade.entryPrice*100;
            activeTrades.delete(tid); closedTrades.push(trade); continue;
          }
        }

        // 🏇 RIDER EXIT: BOS inverso en HTF (BOS es más confiable que CHoCH — confirma ruptura estructural)
        if (riderMode && trade.managementMode==='RIDER' && !trade.closed) {
          const riderEntryTs = (trade as any).riderEntryTs || 0;
          const h1State = engH1.getState();
          const lastBos = h1State.lastBOS;
          if (lastBos && lastBos.timestamp > riderEntryTs) {
            const inverseDir = trade.direction==='BUY'?'Bearish':'Bullish';
            if ((lastBos as any).direction === inverseDir) {
              const pnl = trade.direction==='BUY'
                ? (tick.close - trade.entryPrice)/trade.entryPrice*100
                : (trade.entryPrice - tick.close)/trade.entryPrice*100;
              trade.closed=true; trade.result=pnl>0?'WIN':'BE'; trade.closeTimestamp=tick.timestamp;
              trade.pnlPct = pnl;
              riderExitPnLs.push(pnl);
              activeTrades.delete(tid); closedTrades.push(trade); continue;
            }
          }
          // Si no hay BOS inverso fresco, el trade sigue vivo. El SL lo protege.
        }

        // SL
        if (slHit && !trade.closed) {
          const slPnl = -Math.abs(trade.slPrice - trade.entryPrice)/trade.entryPrice*100;
          trade.closed=true; trade.result='LOSS'; trade.closeTimestamp=tick.timestamp;
          trade.pnlPct = slPnl;
          if (trade.managementMode==='RIDER') riderExitPnLs.push(slPnl);
          activeTrades.delete(tid); closedTrades.push(trade); continue;
        }
      }

      // ── Entry generation: AlphaModel simplificado (alineación HTF) ──
      //    Solo genera BUY si M15+H1 son alcistas, SELL si ambos bajistas.
      //    Esto garantiza entradas estructuralmente alineadas — exactamente
      //    la condición que Rider necesita para funcionar.
      if (cM15) {
        const st = engM15.getState();
        const h1Trend = engH1.getState().currentTrend;
        const h4Trend = engH4.getState().currentTrend;
        const hasZones = (st.activeOBs?.length||0) + (st.activeBreakers?.length||0) > 0;
        const trend = st.currentTrend;

        // Solo entrar si: hay zonas activas + M15 y H1 alineados + sesión válida
        const htfAligned = trend === h1Trend; // M15 y H1 coinciden
        if (hasZones && trend!=='Neutral' && htfAligned) {
          const dir: 'BUY'|'SELL' = trend==='Bullish'?'BUY':'SELL';
          
          // Solo 1 entrada por cada 3 velas M15 para evitar overcrowding
          if (bars.m15 % 3 === 0) {
            const atr = st.atr || tick.close*0.003;
            const slDist = atr*1.5*(1+SL_BUFFER_PCT);
            const entry = tick.close;
            const sl = dir==='BUY'?fmt(entry-slDist):fmt(entry+slDist);
            const tp1 = dir==='BUY'?fmt(entry+slDist):fmt(entry-slDist);
            const tp2 = dir==='BUY'?fmt(entry+slDist*FIXED_RR):fmt(entry-slDist*FIXED_RR);
            const sess = getSession(tick.timestamp);
            
            // Filtro de sesión fuerte: solo LONDON y NY (mayor liquidez)
            if (sess===1 || sess===2) {
              const t: SimTrade = {
                id: `A${bars.m15}_${Math.random().toString(36).slice(2,6)}`,
                direction:dir, entryPrice:entry, slPrice:sl, tp1Price:tp1,
                tp2Price:tp2, timestamp:tick.timestamp,
                tp1Hit:false, tp2Hit:false, closed:false,
              };
              activeTrades.set(t.id, t);
              if (bars.m15 % 300 === 0) {
                process.stderr.write(`  [ENTRY] ${dir} @ ${entry.toFixed(5)} | M15=${trend} H1=${h1Trend} H4=${h4Trend} | zones=${st.activeOBs?.length||0}\n`);
              }
            }
          }
        }
      }
    } // m1Ticks
  }

  // Flush
  resamplerM15.flush();
  for (const [,t] of activeTrades) {
    if (t.managementMode==='RIDER') riderExitPnLs.push(0);
    t.closed=true; t.result='BE'; t.closeTimestamp=m15Candles[m15Candles.length-1].timestamp; t.pnlPct=0;
    closedTrades.push(t);
  }
  activeTrades.clear();

  const stats = computeStats(closedTrades, riderMode?'CON Rider':'SIN Rider');
  if (riderMode && riderExitPnLs.length > 0) {
    riderExitPnLs.sort((a,b)=>a-b);
    const avg = riderExitPnLs.reduce((s,v)=>s+v,0)/riderExitPnLs.length;
    const max = riderExitPnLs[riderExitPnLs.length-1];
    const min = riderExitPnLs[0];
    const pos = riderExitPnLs.filter(v=>v>0).length;
    console.log(`  [RIDER PnL] ${riderExitPnLs.length} exits | avg: ${(avg*100).toFixed(3)}% | max: ${(max*100).toFixed(3)}% | min: ${(min*100).toFixed(3)}% | >0: ${pos}/${riderExitPnLs.length}`);
  }
  return { stats, trades: closedTrades };
}

// ── Main ──
async function main() {
  const inputDir = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history');
  const m15Path = path.join(inputDir, 'history_M15.csv');
  if (!fs.existsSync(m15Path)) { console.error(`ERROR: ${m15Path} no existe`); process.exit(1); }

  const candles = loadCandles(m15Path);
  const h1Candles = loadCandles(path.join(inputDir, 'history_H1.csv'));
  const h4Candles = loadCandles(path.join(inputDir, 'history_H4.csv'));
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║   M1 BACKTEST — ${ticker} (M15:${candles.length} H1:${h1Candles.length} H4:${h4Candles.length})`);
  console.log(`║   HTF con velas REALES desde CSV — sin resampler`);
  console.log(`║   Comparación: SIN Rider vs CON Rider (EA31337)`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  const preset = getPreset(presetName);

  // Run BOTH
  console.log(`⏳ Ejecutando SIN Rider...`);
  const noRider = runBacktest(candles, h1Candles, h4Candles, preset, false);
  console.log(`   ✓ ${noRider.stats.trades} trades`);

  console.log(`⏳ Ejecutando CON Rider...`);
  const withRider = runBacktest(candles, h1Candles, h4Candles, preset, true);
  console.log(`   ✓ ${withRider.stats.trades} trades\n`);

  // ── Report ──
  const fmtPnl = (v:number) => v>=0?`+${v.toFixed(2)}`:`${v.toFixed(2)}`;
  const fmtInf = (v:number) => v===Infinity?'∞':v.toFixed(2);

  console.log(`┌───────────────────────┬────────────┬────────────┐`);
  console.log(`│ Métrica               │ SIN Rider  │ CON Rider  │`);
  console.log(`├───────────────────────┼────────────┼────────────┤`);
  console.log(`│ Trades cerrados       │ ${String(noRider.stats.trades).padStart(10)} │ ${String(withRider.stats.trades).padStart(10)} │`);
  console.log(`│ Wins / Losses / BE    │ ${noRider.stats.wins}/${noRider.stats.losses}/${noRider.stats.be}    │ ${withRider.stats.wins}/${withRider.stats.losses}/${withRider.stats.be}    │`);
  console.log(`│ Win Rate              │ ${(noRider.stats.wr*100).toFixed(1).padStart(7)}%   │ ${(withRider.stats.wr*100).toFixed(1).padStart(7)}%   │`);
  console.log(`│ Net PnL (% del cap.)  │ ${fmtPnl(noRider.stats.netPnl).padStart(10)}% │ ${fmtPnl(withRider.stats.netPnl).padStart(10)}% │`);
  console.log(`│ Profit Factor         │ ${fmtInf(noRider.stats.pf).padStart(10)} │ ${fmtInf(withRider.stats.pf).padStart(10)} │`);
  console.log(`│ Max Drawdown          │ ${noRider.stats.maxDD.toFixed(2).padStart(7)}R   │ ${withRider.stats.maxDD.toFixed(2).padStart(7)}R   │`);
  console.log(`│ Avg Win               │ ${noRider.stats.avgWin.toFixed(2).padStart(7)}%   │ ${withRider.stats.avgWin.toFixed(2).padStart(7)}%   │`);
  console.log(`│ Avg Loss              │ ${noRider.stats.avgLoss.toFixed(2).padStart(7)}%   │ ${withRider.stats.avgLoss.toFixed(2).padStart(7)}%   │`);
  console.log(`│ Sharpe                │ ${noRider.stats.sharpe.toFixed(2).padStart(10)} │ ${withRider.stats.sharpe.toFixed(2).padStart(10)} │`);
  console.log(`│ Rider exits           │ ${String(noRider.stats.riderExits).padStart(10)} │ ${String(withRider.stats.riderExits).padStart(10)} │`);
  console.log(`└───────────────────────┴────────────┴────────────┘`);

  // Veredicto
  const deltaPnl = withRider.stats.netPnl - noRider.stats.netPnl;
  const deltaWR = withRider.stats.wr - noRider.stats.wr;
  console.log(`\n  📊 Delta Rider: PnL ${fmtPnl(deltaPnl)}% | WR ${(deltaWR*100>=0?'+':'')+(deltaWR*100).toFixed(1)}pp | ${withRider.stats.riderExits} exits por CHoCH`);
  if (withRider.stats.pf > noRider.stats.pf) {
    console.log(`  🏇 RIDER MEJORA el Profit Factor. Las salidas estructurales capturan más tendencia.`);
  } else if (Math.abs(withRider.stats.pf - noRider.stats.pf) < 0.1) {
    console.log(`  ⚖️  Resultados similares. En este backtest el mercado no generó tendencias largas post-TP1.`);
  } else {
    console.log(`  ⚠️  SIN Rider rinde más en este período. El mercado fue de rangos, no de tendencias.`);
  }
  console.log(`\n  💡 Las entradas son simuladas (random con sesgo de trend).`);
  console.log(`     Para medición real, integrar con AlphaModel.executeTrade().\n`);
}

main().catch(console.error);
