/**
 * BarResampler — acumula velas M1 (o ticks) y construye velas de timeframe
 * mayor al vuelo, emitiéndolas SOLO cuando se completa el período.
 *
 * Esto es el corazón del backtest sin look-ahead bias:
 *   - El SMCEngine recibe velas mayores solo al cierre (sin ver el futuro)
 *   - El motor de trades evalúa SL/TP en cada tick M1 (resolución intra-barra)
 *
 * Inspirado en Jesse AI: jesse/backtest.py → _simulate_price()
 *
 * Uso:
 *   const resampler = new BarResampler(15, 900000);
 *   for (const tick of m1Ticks) {
 *       const closedBar = resampler.feed(tick);
 *       if (closedBar) engine.nextCandle(closedBar);  // solo al cierre
 *       checkActiveTrades(tick);                        // cada tick M1
 *   }
 */

import type { OHLCV } from '../engine/smc/types.js';

export interface BarResamplerConfig {
  /** Cuántos ticks M1 forman una vela del TF objetivo */
  ticksPerBar: number;
  /** Duración de cada tick en ms (default 60000 = 1 min) */
  tickMs: number;
  /** Nombre del timeframe para logging */
  label: string;
}

export class BarResampler {
  private ticksPerBar: number;
  private tickMs: number;
  private label: string;
  
  // Acumulador de la barra actual
  private accOpen: number = 0;
  private accHigh: number = -Infinity;
  private accLow: number = Infinity;
  private accClose: number = 0;
  private accVolume: number = 0;
  private accStartTs: number = 0;
  private tickCount: number = 0;

  // Última vela emitida (para que el engine pueda calcular diferencias)
  public lastEmittedBar: OHLCV | null = null;

  constructor(ticksPerBar: number, tickMs: number = 60000, label: string = '') {
    this.ticksPerBar = ticksPerBar;
    this.tickMs = tickMs;
    this.label = label || `${ticksPerBar}t`;
  }

  /**
   * Alimenta un tick M1. Si se completa una barra del TF objetivo,
   * la devuelve. Si no, devuelve null.
   */
  feed(tick: OHLCV): OHLCV | null {
    if (this.tickCount === 0) {
      this.accOpen = tick.open;
      this.accHigh = tick.high;
      this.accLow = tick.low;
      this.accClose = tick.close;
      this.accVolume = tick.volume || 0;
      this.accStartTs = tick.timestamp;
      this.tickCount = 1;
    } else {
      this.accHigh = Math.max(this.accHigh, tick.high);
      this.accLow = Math.min(this.accLow, tick.low);
      this.accClose = tick.close;
      this.accVolume += tick.volume || 0;
      this.tickCount++;
    }

    // Emitir vela solo cuando se completa el período
    if (this.tickCount >= this.ticksPerBar) {
      const bar: OHLCV = {
        timestamp: this.accStartTs,
        open: this.accOpen,
        high: this.accHigh,
        low: this.accLow,
        close: this.accClose,
        volume: this.accVolume,
      };
      this.lastEmittedBar = bar;
      this.reset();
      return bar;
    }

    return null;
  }

  /**
   * Fuerza el cierre de la barra actual (útil al final del backtest).
   */
  flush(): OHLCV | null {
    if (this.tickCount === 0) return null;
    const bar: OHLCV = {
      timestamp: this.accStartTs,
      open: this.accOpen,
      high: this.accHigh,
      low: this.accLow,
      close: this.accClose,
      volume: this.accVolume,
    };
    this.lastEmittedBar = bar;
    this.reset();
    return bar;
  }

  reset(): void {
    this.accOpen = 0;
    this.accHigh = -Infinity;
    this.accLow = Infinity;
    this.accClose = 0;
    this.accVolume = 0;
    this.accStartTs = 0;
    this.tickCount = 0;
  }

  get progress(): number {
    return this.tickCount / this.ticksPerBar;
  }
}

/**
 * Convenience: crea un banco de resamplers para los TFs estándar de JARVIS.
 * M15 usa 15 ticks M1, H1 usa 60 ticks M1, H4 usa 240 ticks M1.
 * D1 usa 1440 ticks pero rara vez se usa para intra-barra; se omite.
 */
export function createResamplerBank(): {
  m15: BarResampler;
  h1: BarResampler;
  h4: BarResampler;
  all: BarResampler[];
} {
  const m15 = new BarResampler(15, 60000, 'M15');
  const h1 = new BarResampler(60, 60000, 'H1');
  const h4 = new BarResampler(240, 60000, 'H4');
  return { m15, h1, h4, all: [m15, h1, h4] };
}
