/**
 * TickGenerator — Brownian Bridge para generar ticks M1 sintéticos
 * a partir de velas M15 reales (OHLCV).
 *
 * Algoritmo (Jesse AI style):
 *   1. Tomar una vela M15 con {open, high, low, close}
 *   2. Generar 15 ticks M1 = {o, h, l, c} que respeten:
 *      - Tick[0].open  = open de M15 (primer tick arranca en el open)
 *      - Tick[14].close = close de M15 (último tick cierra en el close)
 *      - MAX(h) ≤ high de M15  y  MIN(l) ≥ low de M15 (rango confinado)
 *   3. El camino intra-barra es un random walk con drift hacia el close,
 *      con volatilidad proporcional al rango (high-low).
 *
 * El seed es determinístico por timestamp → mismo backtest siempre da
 * el mismo resultado (reproducible).
 *
 * Uso:
 *   const ticks = generateM1Ticks(candleM15, multiplier=15);
 *   ticks → OHLCV[15] con timestamps incrementales de 1 minuto.
 */

import type { OHLCV } from '../engine/smc/types.js';

// -----------------------------------------------------------------------------
// Seeded PRNG (Mulberry32) — determinístico, rápido, sin dependencias
// -----------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -----------------------------------------------------------------------------
// Brownian Bridge tick generation
// -----------------------------------------------------------------------------
export interface TickGenConfig {
  /** Multiplier: cuántos ticks M1 por vela M15 (default 15) */
  ticksPerBar: number;
  /** Volatility scaling factor (0.5–2.0). Default 1.0 = realistic. */
  volatilityScale: number;
  /** Seed offset para mezclar sin perder determinismo */
  seedOffset: number;
}

const DEFAULT_CONFIG: TickGenConfig = {
  ticksPerBar: 15,
  volatilityScale: 1.0,
  seedOffset: 0,
};

/**
 * Genera `n` ticks M1 a partir de una vela padre M15.
 *
 * @param parentCandle - vela M15 con OHLCV y timestamp (inicio del período)
 * @param periodMs - duración de la vela padre en ms (default 900000 = 15 min)
 * @param config - opciones de generación
 * @returns array de n velas OHLCV de 1 minuto
 */
export function generateM1Ticks(
  parentCandle: OHLCV,
  periodMs: number = 900000,
  config: Partial<TickGenConfig> = {},
): OHLCV[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const n = cfg.ticksPerBar;
  const tickMs = Math.floor(periodMs / n);
  const startTs = parentCandle.timestamp;

  // Seed determinístico basado en timestamp + config
  const seed = (startTs / 60000) ^ (cfg.seedOffset * 7919);
  const rand = mulberry32(seed);

  const open = parentCandle.open;
  const close = parentCandle.close;
  const barRange = parentCandle.high - parentCandle.low;
  const barCenter = (parentCandle.high + parentCandle.low) / 2;

  // Volatilidad por tick: fracción del rango total dividido entre ticks,
  // escalado por volatilidad configurable. Floor para evitar 0 en velas planas.
  const tickVol = Math.max(barRange / (n * 2) * cfg.volatilityScale, open * 0.00001);

  // Prices: camino Brownian Bridge de open a close
  const prices: number[] = new Array(n);
  prices[0] = open;
  prices[n - 1] = close;

  // Primer paso: random walk forward
  let prev = open;
  for (let i = 1; i < n - 1; i++) {
    // Drift: hacia dónde "debería" ir linealmente
    const linearTarget = open + (close - open) * (i / (n - 1));
    // Paso browniano: ruido gaussiano (Box-Muller sobre uniform)
    const u1 = rand();
    const u2 = rand();
    const gauss = Math.sqrt(-2 * Math.log(Math.max(u1, 0.0001))) * Math.cos(2 * Math.PI * u2);
    const step = gauss * tickVol;
    // Mezcla: 70% drift lineal + 30% ruido → mantiene el camino realista
    const target = linearTarget * 0.7 + (prev + step) * 0.3;
    // Clamp al rango [low, high] (sin hard clamp — repulsión suave)
    let clamped = target;
    if (clamped > parentCandle.high) clamped = parentCandle.high - tickVol * rand();
    if (clamped < parentCandle.low) clamped = parentCandle.low + tickVol * rand();
    prices[i] = parseFloat(clamped.toFixed(5));
    prev = prices[i];
  }

  // Construir OHLCV de cada tick
  const ticks: OHLCV[] = [];
  for (let i = 0; i < n; i++) {
    const tickOpen = i === 0 ? open : ((prices[i - 1] + prices[i]) / 2);
    const tickClose = prices[i];
    const tickHigh = Math.max(tickOpen, tickClose) + tickVol * rand() * 0.5;
    const tickLow = Math.min(tickOpen, tickClose) - tickVol * rand() * 0.5;
    // Asegurar que el tick no viole el rango de la vela padre
    const safeHigh = Math.min(tickHigh, parentCandle.high);
    const safeLow = Math.max(tickLow, parentCandle.low);

    ticks.push({
      timestamp: startTs + i * tickMs,
      open: parseFloat(tickOpen.toFixed(5)),
      high: parseFloat(safeHigh.toFixed(5)),
      low: parseFloat(safeLow.toFixed(5)),
      close: parseFloat(tickClose.toFixed(5)),
      volume: Math.max(1, Math.round((parentCandle.volume || 0) / n * (0.5 + rand()))),
    });
  }

  // Garantizar último tick cierra en close de la vela padre
  ticks[n - 1].close = close;
  ticks[n - 1].high = Math.max(ticks[n - 1].high, close);
  ticks[n - 1].low = Math.min(ticks[n - 1].low, close);

  return ticks;
}

/**
 * Genera ticks M1 para un array completo de velas M15.
 * Útil para backtests largos.
 */
export function generateM1Stream(
  m15Candles: OHLCV[],
  periodMs: number = 900000,
  config?: Partial<TickGenConfig>,
): OHLCV[] {
  const allTicks: OHLCV[] = [];
  for (let i = 0; i < m15Candles.length; i++) {
    const cfg = { ...config, seedOffset: i }; // offset distinto por vela
    const ticks = generateM1Ticks(m15Candles[i], periodMs, cfg);
    allTicks.push(...ticks);
  }
  return allTicks;
}
