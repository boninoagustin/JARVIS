// Búsqueda de parámetros de DETECCIÓN SMC (random search determinista) — experimento EURUSD.
// Uso: npx tsx smc_detection_search.ts <TICKER> <N_TRIALS> [SPLIT_TS]
//   SPLIT_TS (opcional): timestamp de corte del entrenamiento. La búsqueda evalúa SOLO
//   velas con ts <= SPLIT_TS (el resto queda para validación out-of-sample).
// Guarda todos los trials en /tmp/smc_trials_<TICKER>.json para análisis de importancia.
import fs from 'fs';
import path from 'path';
import { OHLCV, SMCPreset } from '../../src/engine/smc/types.js';
import { SMCEngine } from '../../src/engine/smc/SMCEngine.js';
import { runBacktest, prepareEntries } from '../../jarvis-os/src/services/backtestEngine.js';
import { BacktestConfig } from '../../jarvis-os/src/services/backtestTypes.js';
import { loadOptimizedPreset } from '../../src/engine/smc/smc_config.js';
import { parse as parseCsv } from 'csv-parse/sync';
import { assertLegacyDetectionSearch,rejectLegacyDetectionProfileFlags } from '../smc_export_context.js';
rejectLegacyDetectionProfileFlags(process.argv.slice(2));

const TICKER = (process.argv[2] || 'EURUSD').toUpperCase();
const N_TRIALS = parseInt(process.argv[3] || '120', 10);
const SPLIT_TS = process.argv[4] ? Number(process.argv[4]) : 0; // 0 = período completo

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadCandles(p: string): OHLCV[] {
  const fc = fs.readFileSync(p, 'utf-8');
  return parseCsv(fc, { columns: true, skip_empty_lines: true }).map((r: any) => ({
    timestamp: Number(r.timestamp), open: Number(r.open), high: Number(r.high),
    low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
  })).sort((a: OHLCV, b: OHLCV) => a.timestamp - b.timestamp);
}

const fmt = (n: number) => Number(n.toFixed(5));
const dirToBot = (d: string) => d === 'Bullish' ? 'BUY' : 'SELL';

// ── Espacio de búsqueda de detección ─────────────────────────────────────────
const SPACE: Record<string, any[]> = {
  pivot_len: [3, 5, 8, 13, 21],
  min_sweep_wick_pct: [0.1, 0.2, 0.3, 0.5, 0.7],
  div_pivot_len: [2, 3, 5],
  z_score_window: [14, 20, 50, 100],
  require_displacement: [true, false],
  require_fvg_after_ob: [true, false],
  strict_breaker: [true, false],
  strict_sweep: [true, false],
  confirm_close: [true, false],
  min_ob_body_pct: [0.05, 0.1, 0.2, 0.3],
  use_body_for_ob: [true, false],
  fvg_min_atr: [0.1, 0.3, 0.5],
  wick_invalidates_ob: [true, false],
};

function sampleRandom(rng: () => number): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, vals] of Object.entries(SPACE)) out[k] = vals[Math.floor(rng() * vals.length)];
  return out;
}

// Base preset por TF (igual que export_smc_csv): Balanceado para M5/M15, Ultra Agresivo para H1/H4/D1
const BASE_PRESET: Record<string, string> = { '5': 'Forex - 3. Balanceado', '15': 'Forex - 3. Balanceado', '60': 'Forex - 5. Ultra Agresivo', '240': 'Forex - 5. Ultra Agresivo', 'D1': 'Forex - 5. Ultra Agresivo' };

// Preset de producción por TF (loadOptimizedPreset) + overrides. params=null → preset real puro.
function buildPresetForTf(params: Record<string, any> | null, tfKey: string): SMCPreset {
  const period = tfKey === '5' ? 'M5' : tfKey === '15' ? 'M15' : tfKey === '60' ? 'H1' : tfKey === '240' ? 'H4' : 'D1';
  const base = loadOptimizedPreset(TICKER, period, BASE_PRESET[tfKey]) as any;
  assertLegacyDetectionSearch(base);
  if (params) assertLegacyDetectionSearch(params);
  const preset: any = { ...base };
  if (params) {
    for (const [k, v] of Object.entries(params)) preset[k] = v;
  }
  return preset;
}

// ── Pipeline de logs: réplica de export_smc_csv.ts (HTF context, div zones, VWAP, ORIGIN) ──
const TF_CLOSE_MS: Record<string, number> = { '5': 5*60e3, '15': 15*60e3, '60': 60*60e3, '240': 4*60*60e3, 'D1': 24*60*60e3 };

interface DivZone { direction: 'Bullish' | 'Bearish'; top: number; bottom: number; score: number; ageBars: number; mitigated: boolean; }

function createDivZone(div: any, atr: number): DivZone {
  return { direction: div.direction, top: div.top ?? (div.price + atr * 0.5), bottom: div.bottom ?? (div.price - atr * 0.5), score: div.score ?? 1, ageBars: 0, mitigated: false };
}
function updateDivZones(divZones: DivZone[], candle: OHLCV) {
  for (const dz of divZones) {
    dz.ageBars++;
    if (dz.ageBars > 100) { dz.mitigated = true; continue; }
    if (dz.direction === 'Bullish' && candle.close < dz.bottom) dz.mitigated = true;
    if (dz.direction === 'Bearish' && candle.close > dz.top) dz.mitigated = true;
  }
}

const MEDAL_MAP: Record<string, string> = { 'Platino': 'PLAT', 'Oro': 'ORO', 'Plata': 'PLATA', 'Bronce': 'BRONCE', 'CHoCH': 'CHoCH', 'GodZone': 'GOD' };
function obMedal(ob: any): string {
  const parts = String(ob.category).split(' | ');
  const base = parts[0];
  const suffix = parts.length > 1 ? ` | ${parts.slice(1).join(' | ')}` : '';
  return (MEDAL_MAP[base] ?? base) + suffix;
}

class HtfCtx {
  private trends = new Map<number, string>();
  private keys: number[] = [];
  add(ts: number, trend: string) { this.trends.set(ts, trend); this.keys.push(ts); }
  sort() { this.keys.sort((a, b) => a - b); }
  get(ts: number): string {
    if (this.keys.length === 0) return 'Neutral';
    let left = 0, right = this.keys.length - 1, best = this.keys[0];
    while (left <= right) {
      const mid = (left + right) >> 1;
      if (this.keys[mid] <= ts) { best = this.keys[mid]; left = mid + 1; }
      else right = mid - 1;
    }
    return this.trends.get(best) ?? 'Neutral';
  }
}

function buildHtfContext(htfCandles: OHLCV[], preset: SMCPreset, htfCloseMs: number, htfPeriod: string): HtfCtx {
  const engine = new SMCEngine(preset, htfPeriod);
  const ctx = new HtfCtx();
  for (const c of htfCandles) {
    engine.nextCandle(c);
    ctx.add(c.timestamp + htfCloseMs, engine.getState().simpleTrend ?? 'Neutral');
  }
  ctx.sort();
  return ctx;
}

const TF_NAMES: Record<string, string> = { '5': 'M5', '15': 'M15', '60': 'H1', '240': 'H4' };

// Procesa warmup (sin generar líneas) y luego el rango principal (con líneas).
function generateLogs(tfCode: string, candles: OHLCV[], preset: SMCPreset, htfCtx: HtfCtx | null, warmup: OHLCV[] = []): string[] {
  // Quirk del export: M5 se estampa como 'M5'. El SMCEngine recibe el NOMBRE del periodo.
  const tfText = tfCode === '5' ? 'M5' : tfCode;
  const engine = new SMCEngine(preset, TF_NAMES[tfCode] ?? tfCode);
  const lines: string[] = [];
  const divZones: DivZone[] = [];

  // Warmup: mismo procesamiento, sin emitir líneas (arranca caliente como en vivo).
  for (const candle of warmup) {
    const closeTs = candle.timestamp + (TF_CLOSE_MS[tfCode] ?? 0);
    if (htfCtx) engine.setHTFContext(htfCtx.get(closeTs) ?? 'Neutral', 'Neutral');
    else engine.setHTFContext('Neutral', 'Neutral');
    const events = engine.nextCandle(candle);
    const state = engine.getState();
    updateDivZones(divZones, candle);
    const divEvent = events.find((e: any) => e.type === 'EVENT_DIVERGENCE');
    if (divEvent && state.lastDivergence) {
      divZones.push(createDivZone(state.lastDivergence as any, state.atr ?? 0.0005));
      while (divZones.filter(dz => !dz.mitigated).length > 2) { const oldest = divZones.find(dz => !dz.mitigated); if (oldest) oldest.mitigated = true; }
    }
  }

  for (const candle of candles) {
    const closeTs = candle.timestamp + (TF_CLOSE_MS[tfCode] ?? 0);
    if (htfCtx) engine.setHTFContext(htfCtx.get(closeTs) ?? 'Neutral', 'Neutral');
    else engine.setHTFContext('Neutral', 'Neutral');
    const events = engine.nextCandle(candle);
    const state = engine.getState();
    const isoLocal = new Date(candle.timestamp - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00');
    const vwapTag = state.vwapStatus ? ` | VWAP: ${state.vwapStatus}` : '';
    updateDivZones(divZones, candle);
    const divEvent = events.find((e: any) => e.type === 'EVENT_DIVERGENCE');
    if (divEvent && state.lastDivergence) {
      divZones.push(createDivZone(state.lastDivergence as any, state.atr ?? 0.0005));
      while (divZones.filter(dz => !dz.mitigated).length > 2) { const oldest = divZones.find(dz => !dz.mitigated); if (oldest) oldest.mitigated = true; }
    }
    const activeCount = divZones.filter(dz => !dz.mitigated).length;
    if (divZones.length > activeCount + 20) { const ad = divZones.filter(dz => !dz.mitigated); divZones.length = 0; divZones.push(...ad); }
    for (const ev of events) {
      let alertMsg: string | null = null;
      switch (ev.type) {
        case 'EVENT_CHOCH': case 'EVENT_BOS': {
          const prefix = ev.type === 'EVENT_CHOCH' ? 'EVENTO_CHOCH' : 'EVENTO_BOS';
          const dir = dirToBot(ev.direction);
          const origin = (ev as any).origin !== undefined ? ` | ORIGIN: ${fmt((ev as any).origin)}` : '';
          alertMsg = `${prefix} | TF: ${tfText} | Dir: ${dir} | Precio: ${fmt(candle.close)}${vwapTag}${origin} | CONFIRMED | TS: ${closeTs}`;
          break;
        }
        case 'EVENT_SWEEP': {
          const dir = dirToBot(ev.direction);
          if (ev.sweepType === 'LIQ_GRAB') alertMsg = `LIQ_GRAB | TF: ${tfText} | Dir: ${dir} | Nivel: ${fmt(ev.price)} | TS: ${closeTs}`;
          else alertMsg = `EVENTO_SWEEP | TF: ${tfText} | Dir: ${dir} | Nivel Reclamado | TS: ${closeTs}`;
          break;
        }
        case 'EVENT_DIVERGENCE': {
          const dir = dirToBot(ev.direction);
          const rsiDiff = ev.divergence?.rsiDiff ? Math.round(ev.divergence.rsiDiff * 10) / 10 : 0;
          alertMsg = `EVENTO_SMC_DIV | TF: ${tfText} | Dir: ${dir} | Score: ${ev.divergence?.score ?? 0} | RSI_Diff: ${rsiDiff} | TS: ${closeTs}`;
          break;
        }
        case 'ZONE_TOUCHED': case 'ZONE_BROKEN': {
          const dir = dirToBot(ev.direction);
          const medal = MEDAL_MAP[ev.category] ?? ev.category;
          alertMsg = `${ev.type} | TF: ${tfText} | Dir: ${dir} | Medal: ${medal} | Score: ${ev.score} | Top: ${fmt(ev.top)} | Btm: ${fmt(ev.bottom)} | TS: ${closeTs}`;
          break;
        }
      }
      if (alertMsg) lines.push(`${isoLocal},"${alertMsg.replace(/"/g, '""')}"`);
    }
    const activeOBs = [...(state.activeOBs ?? [])].filter((ob: any) => !ob.mitigated && !ob.hidden);
    const activeBreakers = (state.activeBreakers ?? []).filter((ob: any) => !ob.mitigated && !ob.hidden);
    const atr = Number((state.atr ?? 0).toFixed(10));
    const zones: any[] = [];
    for (const ob of activeOBs) {
      const entry: any = { t: tfText, d: dirToBot(ob.direction), p: fmt(ob.top), b: fmt(ob.bottom), lv: (ob.direction === 'Bullish' ? ob.top : ob.bottom).toFixed(5), md: obMedal(ob), sc: ob.score, a: atr };
      if (ob.merged && ob.merge_count && ob.merge_count > 1) entry.mg = ob.merge_count;
      zones.push(entry);
    }
    for (const ob of activeBreakers) {
      zones.push({ t: tfText, d: dirToBot(ob.direction), p: fmt(ob.top), b: fmt(ob.bottom), lv: (ob.direction === 'Bullish' ? ob.top : ob.bottom).toFixed(5), md: ob.category === 'GodZone' ? 'GOD_BRK' : 'BRK', sc: ob.score, a: atr });
    }
    for (const dz of divZones.filter(dz => !dz.mitigated)) {
      zones.push({ t: tfText, d: dz.direction === 'Bullish' ? 'BUY' : 'SELL', p: fmt(dz.top), b: fmt(dz.bottom), lv: 'DIV', md: 'SMC_DIV', sc: dz.score, a: atr, kz: true });
    }
    const trend = state.currentTrend === 'Bullish' ? 'BUY' : state.currentTrend === 'Bearish' ? 'SELL' : 'NEUTRAL';
    const wBiasStr = (state as any).weeklyBias === 'Bullish' ? 'BUY' : (state as any).weeklyBias === 'Bearish' ? 'SELL' : trend;
    const msg = `SYNC_ZONES | TF: ${tfText} | Trend: ${trend} | WBias: ${wBiasStr} | Payload: ${JSON.stringify(zones.slice(0, 20))} | TS: ${closeTs}`;
    const zoneCount = (state.activeOBs?.length ?? 0) + divZones.length;
    const hbMsg = `HEARTBEAT | TF: ${tfText} | Bias: ${trend} | Zones: ${zoneCount}${vwapTag} | Z-Up: 0 | Z-Dn: 0 | TS: ${closeTs}`;
    const pingMsg = `PING_PRICE | TF: ${tfText} | Precio: ${fmt(candle.close)} | High: ${fmt(candle.high)} | Low: ${fmt(candle.low)}${vwapTag} | Z-Up: 0 | Z-Dn: 0 | TS: ${closeTs}`;
    lines.push(`${isoLocal},"${hbMsg.replace(/"/g, '""')}"`);
    lines.push(`${isoLocal},"${pingMsg.replace(/"/g, '""')}"`);
    lines.push(`${isoLocal},"${msg.replace(/"/g, '""')}"`);
  }
  return lines;
}

function buildConfig(): BacktestConfig {
  const t: any = { enabled: true, minScore: 4, slBuff: 0.002, tp2: 3, partialClosePct: 50, slAfterTp1: 'breakeven', tp15BeEnabled: false, atrTrailEnabled: true, structuralTrailEnabled: true, tp1StructuralMinRR: 1.0 };
  const b: any = { enabled: true, minScore: 3, slBuff: 0.002, tp2: 3, partialClosePct: 50, slAfterTp1: 'breakeven', tp15BeEnabled: false, atrTrailEnabled: true, structuralTrailEnabled: true, tp1StructuralMinRR: 1.0 };
  const sess: any = { choch15m: t, bos15m: b, oteChoch15m: { ...t }, oteBos15m: { ...b } };
  return {
    ticker: TICKER, entryTrigger: 'SMART', minBuyPoints: 4, minSellPoints: 4, minRR: 1.2,
    oteEntryPercent: 50, slBufferPercent: 0.002,
    spreadPips: 0.8, commissionPerLot: 3.0, maxDailyLossR: 3.0, maxTradesPerDay: 12,
    sessionFilter: ['LONDON', 'NY', 'ASIA'],
    sessions: { LONDON: { ...sess }, NY: { ...sess }, ASIA: { ...sess } },
  };
}

// Evalúa sobre el rango [splitStart, splitEnd) con warmup de velas anteriores a splitStart.
// splitEnd=0 → hasta el final. Ambos 0 → período completo sin warmup.
async function evaluate(params: Record<string, any> | null, candlesByTf: Record<string, OHLCV[]>, config: BacktestConfig, splitStart: number = 0, splitEnd: number = 0): Promise<{ totalR: number; trades: number; avgR: number }> {
  const logsMap = new Map<string, string[]>();
  const tfKeys: Record<string, string> = { '5': 'M5', '15': 'M15', '60': 'H1', '240': 'H4' };
  const htfFor: Record<string, [string, number, string]> = { '5': ['60', 60*60e3, 'H1'], '15': ['240', 4*60*60e3, 'H4'], '60': ['D1', 24*60*60e3, 'D1'], '240': ['', 0, ''] };
  const htfCtxCache = new Map<string, HtfCtx>();
  for (const tf of ['5', '15', '60', '240']) {
    const [htfTf, closeMs, htfPeriod] = htfFor[tf];
    let ctx: HtfCtx | null = null;
    if (htfTf) {
      // HTF ctx: incluye warmup (velas anteriores al splitStart) + rango, hasta splitEnd.
      const htfAll = candlesByTf[htfTf].filter(c => c.timestamp < (splitEnd || Infinity));
      if (!htfCtxCache.has(htfTf)) htfCtxCache.set(htfTf, buildHtfContext(htfAll, buildPresetForTf(params, htfTf), closeMs, htfPeriod));
      ctx = htfCtxCache.get(htfTf)!;
    }
    const all = candlesByTf[tf];
    const warmup = splitStart > 0 ? all.filter(c => c.timestamp < splitStart) : [];
    const range = all.filter(c => c.timestamp >= splitStart && c.timestamp < (splitEnd || Infinity));
    logsMap.set(tfKeys[tf], generateLogs(tf, range, buildPresetForTf(params, tf), ctx, warmup));
  }
  // 🔧 runBacktest NO prepara los entries: hay que pasar prepareEntries como 4º arg (si no, 0 trades).
  const prepared = await prepareEntries(logsMap as any);
  const res = runBacktest(logsMap as any, config, undefined, prepared);
  const totalR = res.trades.reduce((s, x) => s + (x.rMultiple ?? 0), 0);
  const avgR = res.trades.length > 0 ? totalR / res.trades.length : 0;
  return { totalR, trades: res.trades.length, avgR };
}

async function main() {
  const dir = path.join(process.cwd(), 'logs', TICKER.toLowerCase(), 'history');
  const candlesByTf: Record<string, OHLCV[]> = {
    '5': loadCandles(path.join(dir, 'history_M5.csv')),
    '15': loadCandles(path.join(dir, 'history_M15.csv')),
    '60': loadCandles(path.join(dir, 'history_H1.csv')),
    '240': loadCandles(path.join(dir, 'history_H4.csv')),
    'D1': loadCandles(path.join(dir, 'history_D1.csv')),
  };
  console.log(`Cargadas: M5=${candlesByTf['5'].length} M15=${candlesByTf['15'].length} H1=${candlesByTf['60'].length} H4=${candlesByTf['240'].length} D1=${candlesByTf['D1'].length}`);
  const config = buildConfig();

  // ── Modo HEALTH: estado de salud de un ticker para el panel (roster de 30). ──
  // Sin TRIALS (o 0): solo evalúa el baseline actual → status OK/REVISAR.
  // Con TRIALS>0: corre la búsqueda y reclasifica con el mejor candidato OOS:
  //   bestOos > +1R → OPTIMIZABLE (vale activar) | bestOos ≤ +1R → CANDIDATO_APAGAR.
  // Escribe el resultado a Firestore detection_health/{ticker}.
  if (process.argv[3] === 'health') {
    const N = parseInt(process.argv[4] || '0', 10);
    const allTs = candlesByTf['15'].map(c => c.timestamp);
    const minTs = Math.min(...allTs), maxTs = Math.max(...allTs);
    const splitTs = Math.round(minTs + 0.7 * (maxTs - minTs));
    const base = await evaluate(null, candlesByTf, config, 0, 0); // período completo
    const out: any = {
      ticker: TICKER, baselineR: Number(base.totalR.toFixed(2)), trades: base.trades,
      status: base.totalR > 1.0 ? 'OK' : 'REVISAR',
      bestR: null, bestParams: null, evaluatedAt: new Date().toISOString(),
    };
    if (N > 0) {
      const rng = mulberry32(42);
      let best: { params: Record<string, any>; totalR: number } | null = null;
      for (let i = 0; i < N; i++) {
        const params = sampleRandom(rng);
        const r = await evaluate(params, candlesByTf, config, 0, splitTs);
        if (!best || r.totalR > best.totalR) best = { params, totalR: r.totalR };
      }
      const bestOos = await evaluate(best!.params, candlesByTf, config, splitTs, 0);
      out.bestR = Number(bestOos.totalR.toFixed(2));
      out.bestParams = best!.params;
      out.status = bestOos.totalR > 1.0 ? 'OPTIMIZABLE' : 'CANDIDATO_APAGAR';
      out.bestOosTrades = bestOos.trades;
    }
    console.log('HEALTH_RESULT ' + JSON.stringify(out));
    // Escribir a Firestore (best-effort: si no hay credenciales, solo stdout)
    try {
      const adminModule = await import('firebase-admin');
      const admin: any = (adminModule as any).default ?? adminModule;
      const sa = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'service-account.json'), 'utf8'));
      if (admin.apps?.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
      const db = admin.firestore();
      await db.collection('detection_health').doc(TICKER).set(out, { merge: true });
      console.log('HEALTH_SAVED');
    } catch (e) {
      console.log('HEALTH_FIRESTORE_SKIP: ' + String((e as Error).message).slice(0, 100));
    }
    process.exit(0);
  }

  // ── Modo EVAL: validar un preset (o baseline) sobre [SPLIT_TS, fin) con warmup del train ──
  if (process.argv[3] === 'eval') {
    const splitTs = Number(process.argv[4]);
    if (!splitTs) { console.error('Uso eval: <TICKER> eval <SPLIT_TS> <preset_json_file|baseline>'); process.exit(1); }
    const presetArg = process.argv[5];
    const params: Record<string, any> | null = presetArg && presetArg !== 'baseline' ? JSON.parse(fs.readFileSync(presetArg, 'utf-8')) : null;
    const label = params ? 'PRESET' : 'BASELINE';
    const t0 = Date.now();
    const r = await evaluate(params, candlesByTf, config, splitTs, 0);
    console.log(`${label} OOS [ts>=${splitTs}]: trades=${r.trades} totalR=${r.totalR.toFixed(2)} avgR=${r.avgR.toFixed(3)} (${((Date.now()-t0)/1000).toFixed(0)}s)`);
    process.exit(0);
  }

  // ── Modo TUNE (automatización semanal): búsqueda sobre train 70% + OOS top-1 vs actual ──
  // Regla de aplicación (conservadora): candidato se aplica si mejora el OOS en ≥ +1R, o si
  // gana ≥ +5R en train sin empeorar el OOS en más de 1R. Nunca si el OOS empeora > 1R.
  if (process.argv[3] === 'tune') {
    const N = parseInt(process.argv[4] || '80', 10);
    const APPLY_TEST_GAIN = 1.0, APPLY_TRAIN_GAIN = 5.0, APPLY_TEST_TOL = 1.0, MIN_OOS_TRADES = 8;
    // Split dinámico: train = 70% del rango disponible del ticker
    const allTs = candlesByTf['15'].map(c => c.timestamp);
    const minTs = Math.min(...allTs), maxTs = Math.max(...allTs);
    const splitTs = Math.round(minTs + 0.7 * (maxTs - minTs));
    console.log(`TUNE ${TICKER}: rango ${new Date(minTs).toISOString().slice(0,10)} → ${new Date(maxTs).toISOString().slice(0,10)}, split train 70% hasta ${new Date(splitTs).toISOString().slice(0,10)}`);

    // Baseline = preset actual (producción)
    const actual = await evaluate(null, candlesByTf, config, 0, splitTs);
    console.log(`ACTUAL train: ${actual.totalR.toFixed(2)}R (${actual.trades}t)`);
    const rng = mulberry32(42);
    let best: { params: Record<string, any>; totalR: number; trades: number; avgR: number } | null = null;
    for (let i = 0; i < N; i++) {
      const params = sampleRandom(rng);
      const r = await evaluate(params, candlesByTf, config, 0, splitTs);
      if (!best || r.totalR > best.totalR) best = { params, ...r };
      if ((i + 1) % 20 === 0) console.log(`  [${i+1}/${N}] mejor train=${best!.totalR.toFixed(2)}R`);
    }
    // OOS de candidato y actual sobre el test (con warmup del train)
    const candOos = await evaluate(best!.params, candlesByTf, config, splitTs, 0);
    const actOos = await evaluate(null, candlesByTf, config, splitTs, 0);
    const dTrain = best!.totalR - actual.totalR;
    const dTest = candOos.totalR - actOos.totalR;
    console.log(`CANDIDATO: train ${best!.totalR.toFixed(2)}R → OOS ${candOos.totalR.toFixed(2)}R (${candOos.trades}t)`);
    console.log(`ACTUAL:    train ${actual.totalR.toFixed(2)}R → OOS ${actOos.totalR.toFixed(2)}R (${actOos.trades}t)`);
    console.log(`Δ: train ${dTrain >= 0 ? '+' : ''}${dTrain.toFixed(2)}R | OOS ${dTest >= 0 ? '+' : ''}${dTest.toFixed(2)}R`);
    console.log(`Candidato: ${JSON.stringify(best!.params)}`);

    // Muestra OOS insuficiente (p.ej. < 8 trades) → NO aplicar (decisión ruidosa).
    // Además el candidato no puede empeorar el train de forma relevante (> 1R).
    const enoughSample = candOos.trades >= MIN_OOS_TRADES && actOos.trades >= MIN_OOS_TRADES;
    const apply = enoughSample && (
      (candOos.totalR >= actOos.totalR + APPLY_TEST_GAIN && best!.totalR >= actual.totalR - 1.0)
      || (candOos.totalR >= actOos.totalR - APPLY_TEST_TOL && best!.totalR >= actual.totalR + APPLY_TRAIN_GAIN)
    );
    if (!apply) {
      const why = !enoughSample
        ? `muestra OOS insuficiente (cand ${candOos.trades}t / act ${actOos.trades}t < ${MIN_OOS_TRADES})`
        : 'no supera umbrales (OOS +' + APPLY_TEST_GAIN + 'R con train ≥ -1R, o train +' + APPLY_TRAIN_GAIN + 'R con OOS ≥ -' + APPLY_TEST_TOL + 'R)';
      console.log(`DECISIÓN: NO aplicar (${why})`);
      process.exit(0);
    }
    // Aplicar: escribir bloques M15/H1/H4/D1 (pivot/wick/div/z) + sección Detection (13 params).
    // Detection la lee loadOptimizedPreset (fase 2) para aplicar TODOS los umbrales por activo.
    const presetPath = path.join(process.cwd(), `optimized_preset_${TICKER}.json`);
    const presetJson = fs.existsSync(presetPath) ? JSON.parse(fs.readFileSync(presetPath, 'utf-8')) : {};
    fs.copyFileSync(presetPath, presetPath + '.bak-pre-detection');
    const p = best!.params;
    for (const tf of ['M15', 'H1', 'H4', 'D1']) {
      presetJson[tf] = presetJson[tf] ?? {};
      presetJson[tf].pivot_len = p.pivot_len;
      presetJson[tf].wick_pct = p.min_sweep_wick_pct;
      presetJson[tf].div_len = p.div_pivot_len;
      presetJson[tf].z_window = p.z_score_window;
    }
    presetJson.Detection = { ...p };
    presetJson.DetectionMeta = {
      source: 'detection_tune', appliedAt: new Date().toISOString(),
      trainR: Number(best!.totalR.toFixed(2)), oosR: Number(candOos.totalR.toFixed(2)),
      prevTrainR: Number(actual.totalR.toFixed(2)), prevOosR: Number(actOos.totalR.toFixed(2)),
      candidatesTested: N, params: p,
    };
    fs.writeFileSync(presetPath, JSON.stringify(presetJson, null, 2));
    console.log(`DECISIÓN: APLICADO → ${presetPath} (backup: ${presetPath}.bak-pre-detection)`);

    // Reflejar inmediatamente en Firestore detection_health/{TICKER} para el dashboard
    try {
      const adminModule = await import('firebase-admin');
      const admin: any = (adminModule as any).default ?? adminModule;
      const sa = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'service-account.json'), 'utf8'));
      if (admin.apps?.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
      const db = admin.firestore();
      const st = candOos.totalR > 0 ? 'OPTIMIZABLE' : 'REVISAR';
      await db.collection('detection_health').doc(TICKER).set({
        ticker: TICKER,
        baselineR: Number(actOos.totalR.toFixed(2)),
        trades: candOos.trades,
        status: st,
        bestR: Number(candOos.totalR.toFixed(2)),
        bestParams: p,
        bestOosTrades: candOos.trades,
        evaluatedAt: new Date().toISOString(),
      }, { merge: true });
      console.log('HEALTH_SAVED: ' + st);
    } catch (fe) {
      console.log('HEALTH_FIRESTORE_SKIP: ' + String((fe as Error).message).slice(0, 100));
    }

    console.log('TUNE_RESULT: APPLIED');
    process.exit(0);
  }

  const SPLIT_TS = process.argv[4] ? Number(process.argv[4]) : 0; // 0 = período completo
  console.log(`SPLIT: entrenamiento hasta ts=${SPLIT_TS || 'FIN (todo el período)'}`);

  // Baseline = preset de producción REAL (sin overrides)
  const b0 = Date.now();
  const baseRes = await evaluate(null, candlesByTf, config, 0, SPLIT_TS);
  console.log(`\nBASELINE: trades=${baseRes.trades} totalR=${baseRes.totalR.toFixed(2)} avgR=${baseRes.avgR.toFixed(3)}  (${((Date.now()-b0)/1000).toFixed(1)}s)`);

  const rng = mulberry32(42);
  const allTrials: { params: Record<string, any>; totalR: number; trades: number; avgR: number }[] = [];
  let best: { params: Record<string, any>; totalR: number; trades: number; avgR: number } | null = null;
  let betterThanBaseline = 0;
  const t0 = Date.now();
  for (let i = 0; i < N_TRIALS; i++) {
    const params = sampleRandom(rng);
    const r = await evaluate(params, candlesByTf, config, 0, SPLIT_TS);
    allTrials.push({ params, ...r });
    if (!best || r.totalR > best.totalR) best = { params, ...r };
    if (r.totalR > baseRes.totalR) betterThanBaseline++;
    if ((i + 1) % 10 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  [${i+1}/${N_TRIALS}] mejor=${best!.totalR.toFixed(2)}R (${best!.trades}t) | >baseline: ${betterThanBaseline} | ${(el/(i+1)).toFixed(1)}s/trial`);
    }
  }

  console.log(`\n🏆 MEJOR (totalR): ${best!.totalR.toFixed(2)}R, ${best!.trades} trades, avgR ${best!.avgR.toFixed(3)}`);
  console.log(JSON.stringify(best!.params, null, 2));
  console.log(`\nBaseline: ${baseRes.totalR.toFixed(2)}R (${baseRes.trades}t). Trials mejores que baseline: ${betterThanBaseline}/${N_TRIALS}`);
  console.log(`Tiempo total: ${((Date.now()-t0)/1000).toFixed(0)}s`);

  // Guardar todos los trials (top 10 + archivo completo) para análisis
  const sorted = [...allTrials].sort((a, b) => b.totalR - a.totalR);
  fs.writeFileSync(`/tmp/smc_trials_${TICKER}${SPLIT_TS ? '_train' : ''}.json`, JSON.stringify({ baseline: baseRes, split_ts: SPLIT_TS, trials: sorted }, null, 1));
  console.log(`Guardados ${allTrials.length} trials en /tmp/smc_trials_${TICKER}${SPLIT_TS ? '_train' : ''}.json`);
  console.log('\nTOP 10:');
  for (const tr of sorted.slice(0, 10)) {
    console.log(`  ${tr.totalR.toFixed(2)}R (${tr.trades}t, avgR ${tr.avgR.toFixed(3)}): ${JSON.stringify(tr.params)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
