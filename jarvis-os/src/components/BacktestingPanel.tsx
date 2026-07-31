import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { ShieldAlert, BarChart2, Zap, TrendingUp, BookOpen, Wand2, Upload, Briefcase, Play, Trash2, FileText, Download, RotateCcw, Loader2 } from 'lucide-react';

function AdvancedDashboardMetrics({ metrics }: { metrics: any }) {
  if (!metrics) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', justifyContent: 'center', width: '100%' }}>
      {/* ROW 1: Principales */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr 0.8fr', gap: '10px' }}>
        <div title="Win Rate: Porcentaje de operaciones ganadoras.&#10;✅ Bueno: > 45% (con RR 1:2) o > 60% (con RR 1:1)." style={{ textAlign: 'center', padding: '14px 10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>WIN RATE</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent-gold)' }}>{metrics.wr}%</div>
        </div>
        <div title="Profit Factor: Relación entre ganancias brutas y pérdidas brutas.&#10;✅ Bueno: > 1.2 es rentable, > 1.5 es excelente." style={{ textAlign: 'center', padding: '14px 10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>PROFIT FACTOR</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: parseFloat(metrics.profitFactor) >= 1.5 ? 'var(--accent-green)' : parseFloat(metrics.profitFactor) >= 1.0 ? 'var(--accent-gold)' : 'var(--accent-red)' }}>{metrics.profitFactor}</div>
        </div>
        <div title="PnL Total: Ganancia/Pérdida neta total en múltiplos de Riesgo (R) y Dólares.&#10;✅ Bueno: Cualquier valor positivo sostenido." style={{ textAlign: 'center', padding: '14px 10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>PNL TOTAL</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: parseFloat(metrics.pnlR) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
            {parseFloat(metrics.pnlR) > 0 ? '+' : ''}{metrics.pnlR}R <span style={{ fontSize: '0.85rem', fontWeight: 400, color: 'var(--text-secondary)' }}>/ ${metrics.pnlUsd}</span>
          </div>
        </div>
        <div title="Trades: Cantidad de operaciones cerradas en el periodo.&#10;✅ Bueno: Mínimo 100 operaciones para dar validez estadística." style={{ textAlign: 'center', padding: '14px 10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>TRADES</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)' }}>{metrics.count}</div>
        </div>
      </div>

      {/* ROW 2: Analíticas */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '10px' }}>
        <div title="Esperanza Matemática: Cuánto ganas en promedio por CADA trade ejecutado (ganador o perdedor).&#10;✅ Bueno: > 0.15 R." style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>ESPERANZA MAT.</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: parseFloat(metrics.expectancyR) > 0 ? 'var(--accent-green)' : 'var(--text-primary)' }}>{parseFloat(metrics.expectancyR) > 0 ? '+' : ''}{metrics.expectancyR}R</div>
        </div>
        <div title="Max Drawdown: Peor racha de pérdidas o caída máxima desde un pico de balance.&#10;✅ Bueno: Que no supere el 5% de tu cuenta (depende de tu firma)." style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>MAX DRAWDOWN</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-red)' }}>-${metrics.maxDDUsd.replace('-', '')}</div>
        </div>
        <div title="Peor Día: El día con la mayor pérdida monetaria.&#10;✅ Bueno: Nunca debe exceder el Límite Diario de Pérdida de tu cuenta fondeada." style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>PEOR DÍA</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-red)' }}>{metrics.worstDayR}R</div>
        </div>
        <div title="Sharpe Ratio: Rendimiento de la estrategia ajustado a su nivel de riesgo/volatilidad.&#10;✅ Bueno: > 1.0 es aceptable, > 1.5 es muy bueno, > 2.0 es excelente." style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>SHARPE RATIO</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: parseFloat(metrics.sharpeRatio) > 1.5 ? 'var(--accent-green)' : 'var(--text-primary)' }}>{metrics.sharpeRatio}</div>
        </div>
      </div>

      {/* ROW 3: Extra Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr 1fr 1fr', gap: '8px' }}>
        <div title="Racha Ganadora / Perdedora: Máximo de aciertos y fallos consecutivos.&#10;✅ Bueno: Úsalo para afinar tus frenos diarios (Daily Limits)." style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>RACHA G/P</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}><span style={{ color: 'var(--accent-green)' }}>{metrics.maxConsWins}</span> / <span style={{ color: 'var(--accent-red)' }}>{metrics.maxConsLosses}</span></div>
        </div>
        <div title="Criterio de Kelly: Porcentaje matemático ideal para arriesgar por trade.&#10;✅ Bueno: Es solo orientativo, ¡nunca arriesgues más del 1-2% en firmas de fondeo!" style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>KELLY</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: parseFloat(metrics.kellyFormatted) > 0 ? 'var(--accent-gold)' : 'var(--text-primary)' }}>{metrics.kellyFormatted}</div>
        </div>
        <div title="Win Promedio vs Loss Promedio: Cuánto ganas al acertar vs cuánto pierdes al fallar.&#10;✅ Bueno: Que el Avg Win sea considerablemente mayor al Avg Loss (> 1.5R)." style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>W vs L</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            <span style={{ color: 'var(--accent-green)' }}>+{metrics.avgWinR}</span> <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>vs</span> <span style={{ color: 'var(--accent-red)' }}>-{metrics.avgLossR}</span>
          </div>
        </div>
        <div title="Trades por Semana: Frecuencia operativa promedio.&#10;✅ Bueno: No hay un número ideal, depende si eres Scalper (alto) o Swing (bajo)." style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>TRDS/SEM</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>{metrics.tradesPerWeek}</div>
        </div>
        <div title="Duración Promedio: Tiempo promedio que un trade se mantiene abierto.&#10;✅ Bueno: Sirve para entender cuánta paciencia psicológica requiere tu estrategia." style={{ textAlign: 'center', padding: '12px 8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
          <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginBottom: '4px' }}>DUR. PROM.</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>{metrics.avgDuration}</div>
        </div>
      </div>

      {/* ROW 3: Distribución */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 0.5fr', gap: '8px' }}>
        <div style={{ textAlign: 'center', padding: '8px', fontSize: '0.7rem' }}>
          <span style={{ color: '#0088ff', fontWeight: 700, fontSize: '0.85rem' }}>{metrics.tp2Count}</span> <span style={{ color: 'var(--text-tertiary)' }}>TP2</span>
        </div>
        <div style={{ textAlign: 'center', padding: '8px', fontSize: '0.7rem' }}>
          <span style={{ color: 'var(--accent-green)', fontWeight: 700, fontSize: '0.85rem' }}>{metrics.tp1OnlyCount}</span> <span style={{ color: 'var(--text-tertiary)' }}>TP1</span>
        </div>
        <div style={{ textAlign: 'center', padding: '8px', fontSize: '0.7rem' }}>
          <span style={{ color: 'var(--accent-gold)', fontWeight: 700, fontSize: '0.85rem' }}>{metrics.beCount}</span> <span style={{ color: 'var(--text-tertiary)' }}>BE</span>
        </div>
        <div style={{ textAlign: 'center', padding: '8px', fontSize: '0.7rem' }}>
          <span style={{ color: 'var(--accent-red)', fontWeight: 700, fontSize: '0.85rem' }}>{metrics.slCount}</span> <span style={{ color: 'var(--text-tertiary)' }}>SL</span>
        </div>
        <div style={{ textAlign: 'center', padding: '8px', fontSize: '0.7rem' }}>
          <span style={{ color: 'var(--text-tertiary)', fontWeight: 700, fontSize: '0.85rem' }}>{metrics.open}</span> <span style={{ color: 'var(--text-tertiary)' }}>OP</span>
        </div>
      </div>
    </div>
  );
}

function calculateAdvancedMetrics(trades: any[], riskUsd: number) {
  const closed = trades.filter(t => t.result && t.result !== 'TIMEOUT');
  const wins = closed.filter(t => t.result === 'WIN').length;
  const losses = closed.filter(t => t.result === 'LOSS').length;
  const be = closed.filter(t => t.result === 'BE').length;
  const open = trades.filter(t => !t.result).length;
  
  const pnlTotalUsd = closed.reduce((acc, t) => acc + (t.rMultiple || 0) * riskUsd, 0);
  const pnlTotalR = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0);
  
  const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '—';
  const W = closed.length > 0 ? (wins / closed.length) : 0;
  
  let maxDD = 0, peak = 0, cumPnlTrack = 0;
  let grossProfitUsd = 0, grossLossUsd = 0;
  let grossProfitR = 0, grossLossR = 0;
  let maxConsLosses = 0, currentLossStreak = 0;
  let maxConsWins = 0, currentWinStreak = 0;
  let totalDuration = 0, tradesWithDuration = 0;
  
  let tp1OnlyCount = 0, tp2Count = 0, slCount = 0, beCount = 0;

  closed.forEach(t => {
    const r = t.rMultiple || 0;
    const profitUsd = r * riskUsd;
    
    // Drawdown (Usd based) - track real peak
    cumPnlTrack += profitUsd;
    if (cumPnlTrack > peak) peak = cumPnlTrack;
    const dd = peak - cumPnlTrack;
    if (dd > maxDD) maxDD = dd;

    // Profit Factor & Averages
    if (profitUsd > 0) grossProfitUsd += profitUsd;
    else grossLossUsd += Math.abs(profitUsd);
    
    if (r > 0) grossProfitR += r;
    else grossLossR += Math.abs(r);

    // Streaks
    if (t.result === 'LOSS') {
      currentLossStreak++;
      currentWinStreak = 0;
      if (currentLossStreak > maxConsLosses) maxConsLosses = currentLossStreak;
    } else if (t.result === 'WIN') {
      currentWinStreak++;
      currentLossStreak = 0;
      if (currentWinStreak > maxConsWins) maxConsWins = currentWinStreak;
    } else {
      currentLossStreak = 0;
      currentWinStreak = 0;
    }

    // Duration
    if (t.durationMin) {
      totalDuration += t.durationMin;
      tradesWithDuration++;
    }

    // Distribution
    if (t.result === 'WIN') {
        if (t.resultTp2 === 'WIN') tp2Count++;
        else tp1OnlyCount++;
    } else if (t.result === 'LOSS') {
        slCount++;
    } else if (t.result === 'BE') {
        beCount++;
    }
  });
  
  // Worst daily loss & Sharpe
  const dailyPnls = new Map<string, number>();
  const dailyPnlsR = new Map<string, number>();
  closed.forEach(t => {
    const dateStr = new Date(t.timestamp).toISOString().split('T')[0];
    const profitUsd = (t.rMultiple || 0) * riskUsd;
    dailyPnls.set(dateStr, (dailyPnls.get(dateStr) || 0) + profitUsd);
    dailyPnlsR.set(dateStr, (dailyPnlsR.get(dateStr) || 0) + (t.rMultiple || 0));
  });
  
  let worstDayUsd = 0;
  let worstDayR = 0;
  let sumPnlsR = 0;
  
  dailyPnls.forEach((pnl) => { if (pnl < worstDayUsd) worstDayUsd = pnl; });
  dailyPnlsR.forEach((pnlR) => { 
    if (pnlR < worstDayR) worstDayR = pnlR; 
    sumPnlsR += pnlR;
  });

  let sharpeRatio = '0.00';
  if (dailyPnlsR.size > 1) {
    const avgDailyR = sumPnlsR / dailyPnlsR.size;
    let sumSqPnlsR = 0;
    dailyPnlsR.forEach((pnlR) => { sumSqPnlsR += Math.pow(pnlR - avgDailyR, 2); });
    const stdDevR = Math.sqrt(sumSqPnlsR / (dailyPnlsR.size - 1));
    if (stdDevR > 0) {
      sharpeRatio = (avgDailyR / stdDevR * Math.sqrt(252)).toFixed(2);
    }
  }

  const profitFactor = grossLossUsd > 0 ? (grossProfitUsd / grossLossUsd).toFixed(2) : (grossProfitUsd > 0 ? '∞' : '0.00');
  const expectancyR = closed.length > 0 ? (pnlTotalR / closed.length).toFixed(2) : '0.00';
  const avgDurationMin = tradesWithDuration > 0 ? Math.round(totalDuration / tradesWithDuration) : 0;
  
  const avgWinR = wins > 0 ? (grossProfitR / wins).toFixed(2) : '0.00';
  const avgLossR = losses > 0 ? (grossLossR / losses).toFixed(2) : '0.00';
  
  // Frequency
  let daysDiff = 0;
  if (closed.length > 1) {
    const firstDate = new Date(closed[0].timestamp).getTime();
    const lastDate = new Date(closed[closed.length - 1].timestamp).getTime();
    daysDiff = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
  }
  const tradesPerWeek = daysDiff > 0 ? ((closed.length / daysDiff) * 7).toFixed(1) : '—';
  
  // Kelly Criterion
  const avgWinUsd = wins > 0 ? grossProfitUsd / wins : 0;
  const avgLossUsd = losses > 0 ? grossLossUsd / losses : 0;
  const avgRR = avgLossUsd > 0 ? avgWinUsd / avgLossUsd : 0;
  let kellyPercent = 0;
  if (avgRR > 0 && W > 0) {
    kellyPercent = W - ((1 - W) / avgRR);
  }
  const kellyFormatted = closed.length > 0 && kellyPercent > 0 ? (kellyPercent * 100).toFixed(1) + '%' : (closed.length > 0 ? '0%' : '—');

  const formatDuration = (mins: number) => {
      if (mins < 60) return `${mins}m`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  return { 
      wins, losses, be, open, wr, 
      pnlUsd: pnlTotalUsd.toFixed(2), 
      pnlR: pnlTotalR.toFixed(2),
      count: closed.length, total: trades.length, 
      maxDDUsd: maxDD.toFixed(2), closed,
      profitFactor, expectancyR, maxConsLosses, maxConsWins, avgDuration: formatDuration(avgDurationMin),
      tp1OnlyCount, tp2Count, slCount, beCount, worstDayUsd: worstDayUsd.toFixed(2), worstDayR: worstDayR.toFixed(2), sharpeRatio,
      avgWinR, avgLossR, tradesPerWeek, kellyFormatted
  };
}



import { useToast } from './Toast';
import { parseCSV } from '../services/backtestEngine';
import type { BacktestTrade, BacktestResult } from '../services/backtestEngine';

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { db } from '../firebase';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';

interface UploadedFile {
  name: string;
  tf: string;
  lines: any[];
  lineCount: number;
}

interface SessionHistory {
  id: string;
  ticker: string;
  date: string;
  trades: number;
  winRate: string;
  pnl: string;
  status: string;
  tradeData?: BacktestTrade[];
  config?: {
    minBuyPoints: number;
    minSellPoints: number;
    slBufferPercent: number;
    fixedRR: number;
    oteEntryPercent: number;
    entryTrigger: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART';
    minRR?: number;
    sessionFilter?: string[];
    maxTradesPerSession?: number;
    spreadPips?: number;
    commissionPerLot?: number;
    maxDailyLossR?: number;
    dailyProfitTargetR?: number;
    maxConsecutiveLosses?: number;
    maxTradesPerDay?: number;
    trailingDrawdownR?: number;
    partialClosePct?: number;
    slAfterTp1?: 'midpoint' | 'breakeven' | 'none';
    tp15BeEnabled?: boolean;
    atrTrailEnabled?: boolean;
    structuralTrailEnabled?: boolean;
    tp1StructuralMinRR?: number;
    enabled?: boolean;
    sessions?: Record<string, {
      choch5m: { enabled: boolean; minScore: number };
    choch15m: { enabled: boolean; minScore: number };
      bos5m: { enabled: boolean; minScore: number };
    bos15m: { enabled: boolean; minScore: number };
      ote: { enabled: boolean; minScore: number };
    }>;
  };
}


interface TriggerSettingsPanelProps {
  sessionKey: string;
  triggerKey: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m';
  title: string;
  config: any;
  updateTrigger: (session: string, triggerType: any, field: string, value: any, autoRun?: boolean) => void;
  onSimulate: () => void;
  isRunning: boolean;
  isOte: boolean;
  tradeFilter: string;
  setTradeFilter: (f: string) => void;
  filterKey: string;
}

const TriggerSettingsPanel: React.FC<TriggerSettingsPanelProps> = ({ sessionKey, triggerKey, title, config, updateTrigger, onSimulate, isRunning, isOte, tradeFilter, setTradeFilter, filterKey, onOptimize, isOptimizing }) => {
  if (!config) return null;
  const isActive = tradeFilter === filterKey;
  
  return (
    <div 
      onClick={() => setTradeFilter(isActive ? 'ALL' : filterKey)}
      style={{ cursor: 'pointer', padding: '10px', backgroundColor: isActive ? 'rgba(124,77,255,0.08)' : 'rgba(255,255,255,0.02)', border: isActive ? '1px solid #7c4dff' : '1px solid var(--border-color)', borderRadius: '6px', transition: 'all 0.2s' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={config.enabled ?? false}
            onChange={e => updateTrigger(sessionKey, triggerKey, 'enabled', e.target.checked)}
            style={{ cursor: 'pointer', accentColor: 'var(--accent-gold)', width: '14px', height: '14px' }}
          />
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        </label>
        <div style={{ display: 'flex', gap: '4px' }}>
          {onOptimize && (
            <button 
              onClick={(e) => { e.stopPropagation(); onOptimize(); }}
              disabled={isOptimizing || isRunning || !config.enabled}
              style={{
                padding: '4px 8px', backgroundColor: 'transparent', color: 'var(--accent-gold)', border: '1px solid var(--accent-gold)', borderRadius: '4px',
                fontWeight: 700, fontSize: '0.6rem', cursor: (isOptimizing || isRunning || !config.enabled) ? 'not-allowed' : 'pointer',
                opacity: (isOptimizing || isRunning || !config.enabled) ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '4px'
              }}
            >
              {isOptimizing ? <Loader2 size={10} className="spin" /> : <Wand2 size={10} />}
              {isOptimizing ? 'Optimizando...' : 'Optimizar'}
            </button>
          )}
          <button 
            onClick={(e) => { e.stopPropagation(); onSimulate(); }}
            disabled={isRunning || isOptimizing || !config.enabled}
            style={{
              padding: '4px 8px', backgroundColor: 'var(--accent-gold)', color: '#000', border: 'none', borderRadius: '4px',
              fontWeight: 700, fontSize: '0.6rem', cursor: (isRunning || isOptimizing || !config.enabled) ? 'not-allowed' : 'pointer',
              opacity: (isRunning || isOptimizing || !config.enabled) ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '4px'
            }}
          >
            <Play size={10} /> Simular
          </button>
        </div>
      </div>
      
      {config.enabled && (
        <div onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Min Score */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', minWidth: '60px' }}>Mín. Score:</span>
            <input type="range" min="1" max="30" step="1" value={config.minScore ?? 4} onChange={e => updateTrigger(sessionKey, triggerKey, 'minScore', parseInt(e.target.value))} style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-gold)', minWidth: '24px', textAlign: 'right' }}>+{config.minScore}</span>
          </div>

          {/* OTE Entry */}
          {isOte && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Entry Fib:</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[50, 62, 79].map(level => (
                  <button key={level} type="button" onClick={() => updateTrigger(sessionKey, triggerKey, 'entryPercent', level)} style={{ flex: 1, padding: '4px 0', fontSize: '0.7rem', fontWeight: 700, borderRadius: '4px', border: config.entryPercent === level ? '1px solid var(--accent-gold)' : '1px solid var(--border-color)', backgroundColor: config.entryPercent === level ? 'rgba(255,215,0,0.15)' : 'var(--bg-secondary)', color: config.entryPercent === level ? 'var(--accent-gold)' : 'var(--text-secondary)', cursor: 'pointer' }}>{level}%</button>
                ))}
              </div>
            </div>
          )}

          {/* SL Buff & TP2 */}
          <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>SL BUFF: <strong style={{color:'var(--text-primary)'}}>{config.slBuff}</strong></span>
              <input type="range" min="0" max="0.5" step="0.01" value={config.slBuff ?? 0} onChange={e => updateTrigger(sessionKey, triggerKey, 'slBuff', parseFloat(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>TP2 R:R: <strong style={{color:'var(--text-primary)'}}>{config.tp2}x</strong></span>
              <input type="range" min="1" max="5" step="0.1" value={config.tp2 ?? 1.5} onChange={e => updateTrigger(sessionKey, triggerKey, 'tp2', parseFloat(e.target.value))} style={{ width: '100%' }} />
            </div>
          </div>

          {/* Parciales & SL after TP1 */}
          <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>Parciales %: <strong style={{color:'var(--text-primary)'}}>{Math.round((config.partialClosePct ?? 0) * 100)}%</strong></span>
              <input type="range" min="0" max="1" step="0.05" value={config.partialClosePct ?? 0} onChange={e => updateTrigger(sessionKey, triggerKey, 'partialClosePct', parseFloat(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>Acción post-TP1:</span>
              <select value={config.slAfterTp1 ?? 'none'} onChange={e => updateTrigger(sessionKey, triggerKey, 'slAfterTp1', e.target.value)} style={{ padding: '2px 4px', fontSize: '0.65rem', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
                <option value="none">Nada</option>
                <option value="breakeven">Breakeven</option>
                <option value="midpoint">Midpoint (50% SL)</option>
              </select>
            </div>
          </div>
          
          {/* Toggles */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={config.tp15BeEnabled} onChange={e => updateTrigger(sessionKey, triggerKey, 'tp15BeEnabled', e.target.checked)} />
              TP 1.5 -{'>'} BE
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={config.atrTrailEnabled} onChange={e => updateTrigger(sessionKey, triggerKey, 'atrTrailEnabled', e.target.checked)} />
              ATR Trail
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={config.structuralTrailEnabled} onChange={e => updateTrigger(sessionKey, triggerKey, 'structuralTrailEnabled', e.target.checked)} />
              Trail Estructural
            </label>
          </div>
          
        </div>
      )}
    </div>
  );
};

export default function BacktestingPanel() {
  const [ticker, setTicker] = useState('BTCUSD');
  const [minBuyPoints, setMinBuyPoints] = useState(5);
  const [minSellPoints, setMinSellPoints] = useState(5);
  const [slBufferPercent, setSlBufferPercent] = useState(0.1);
  const [fixedRR, setFixedRR] = useState(2.0);
  const [oteEntryPercent, setOteEntryPercent] = useState(50);
  const [entryTrigger, setEntryTrigger] = useState<'CHOCH' | 'OTE' | 'BOTH' | 'SMART'>('BOTH');
  const [partialClosePct, setPartialClosePct] = useState(0.5);
  const [slAfterTp1, setSlAfterTp1] = useState<'midpoint' | 'breakeven' | 'none'>('midpoint');
  const [tp15BeEnabled, setTp15BeEnabled] = useState(true);
  const [atrTrailEnabled, setAtrTrailEnabled] = useState(true);
  const [structuralTrailEnabled, setStructuralTrailEnabled] = useState(true);
  const [tp1StructuralMinRR, setTp1StructuralMinRR] = useState(1.2);

  // 🔄 Cargar gestión de trades actual desde Firestore (asset_configs/{ticker})
  // para que el panel refleje la config que el bot live tiene en producción.
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'asset_configs', ticker), (snap) => {
      if (!snap.exists()) return;
      const d = snap.data() as any;
      if (d.partialClosePct !== undefined) setPartialClosePct(d.partialClosePct);
      if (d.slAfterTp1 !== undefined) setSlAfterTp1(d.slAfterTp1);
      if (d.tp15BeEnabled !== undefined) setTp15BeEnabled(d.tp15BeEnabled);
      if (d.atrTrailEnabled !== undefined) setAtrTrailEnabled(d.atrTrailEnabled);
      if (d.structuralTrailEnabled !== undefined) setStructuralTrailEnabled(d.structuralTrailEnabled);
      if (d.tp1StructuralMinRR !== undefined) setTp1StructuralMinRR(d.tp1StructuralMinRR);
    });
    return () => unsub();
  }, [ticker]);
  const [sessionTriggers, setSessionTriggers] = useState<Record<string, {
    choch15m: { enabled: boolean; minScore: number; slBuff: number; tp2: number; partialClosePct: number; slAfterTp1: 'midpoint' | 'breakeven' | 'none'; tp15BeEnabled: boolean; atrTrailEnabled: boolean; structuralTrailEnabled: boolean; tp1StructuralMinRR: number };
    bos15m: { enabled: boolean; minScore: number; slBuff: number; tp2: number; partialClosePct: number; slAfterTp1: 'midpoint' | 'breakeven' | 'none'; tp15BeEnabled: boolean; atrTrailEnabled: boolean; structuralTrailEnabled: boolean; tp1StructuralMinRR: number };
    oteChoch15m: { enabled: boolean; minScore: number; entryPercent?: number; slBuff: number; tp2: number; partialClosePct: number; slAfterTp1: 'midpoint' | 'breakeven' | 'none'; tp15BeEnabled: boolean; atrTrailEnabled: boolean; structuralTrailEnabled: boolean; tp1StructuralMinRR: number };
    oteBos15m: { enabled: boolean; minScore: number; entryPercent?: number; slBuff: number; tp2: number; partialClosePct: number; slAfterTp1: 'midpoint' | 'breakeven' | 'none'; tp15BeEnabled: boolean; atrTrailEnabled: boolean; structuralTrailEnabled: boolean; tp1StructuralMinRR: number };
    maxSellLosses?: number;
    maxBuyLosses?: number;
  }>>(() => {
    const defTrig: any = { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 };
    const defOte: any = { ...defTrig, entryPercent: 62 };
    const fallback = {
      OFF: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      LONDON: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      NY: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 },
      ASIA: { choch15m: { ...defTrig }, bos15m: { ...defTrig }, oteChoch15m: { ...defOte }, oteBos15m: { ...defOte }, maxSellLosses: 0, maxBuyLosses: 0 }
    };
    try {
      const saved = localStorage.getItem('bt_session_triggers');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed['ALL'] && !parsed['OFF']) {
          parsed['OFF'] = parsed['ALL'];
        }
        for (const s of ['OFF', 'LONDON', 'NY', 'ASIA']) {
          if (!parsed[s]) {
             parsed[s] = JSON.parse(JSON.stringify(fallback[s as keyof typeof fallback]));
          } else {
             // Migrate old structures
             const oldChoch = parsed[s].choch15m || {};
             parsed[s].choch15m = { ...defTrig, ...oldChoch };
             const oldBos = parsed[s].bos15m || {};
             parsed[s].bos15m = { ...defTrig, ...oldBos };
             const oldOteChoch = parsed[s].oteChoch15m || {};
             parsed[s].oteChoch15m = { ...defOte, ...oldOteChoch };
             const oldOteBos = parsed[s].oteBos15m || {};
             parsed[s].oteBos15m = { ...defOte, ...oldOteBos };
             
             delete parsed[s].choch5m;
             delete parsed[s].bos5m;
             delete parsed[s].oteChoch5m;
             delete parsed[s].oteBos5m;
             delete parsed[s].slBufferPercent;
             delete parsed[s].fixedRR;
          }
        }
        return parsed;
      }
    } catch (e) {
      console.error(e);
    }
    return fallback;
  });

  const updateSessionTrigger = (
    session: string,
    triggerType: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m' | 'maxSellLosses' | 'maxBuyLosses',
    field: string,
    value: any,
    autoRun: boolean = false
  ) => {
    setSessionTriggers(prev => {
      let updatedSession = { ...prev[session] };
      if (triggerType === 'maxSellLosses' || triggerType === 'maxBuyLosses') {
        updatedSession[triggerType] = value;
      } else {
        const type = triggerType as 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m';
        updatedSession[type] = {
          ...updatedSession[type],
          [field]: value
        };
      }

      const next = {
        ...prev,
        [session]: updatedSession
      };
      localStorage.setItem('bt_session_triggers', JSON.stringify(next));
      
      if (autoRun && handleRunRef.current) {
        setTimeout(() => handleRunRef.current(undefined, next, true), 50);
      }
      
      return next;
    });
  };
  const [riskUsd, setRiskUsd] = useState(50);
  const [maxDailyLossR, setMaxDailyLossR] = useState(0);
  const [dailyProfitTargetR, setDailyProfitTargetR] = useState(0);
  const [maxConsecutiveLosses, setMaxConsecutiveLosses] = useState(0);
  const [maxTradesPerDay, setMaxTradesPerDay] = useState(0);
  const [trailingDrawdownR, setTrailingDrawdownR] = useState(0);
  const [minRR] = useState(2.0);
  const [spreadPips, setSpreadPips] = useState(0.0);
  const [commissionPerLot, setCommissionPerLot] = useState(0.0);
  const [activeSessions] = useState<string[]>(['LONDON', 'NY', 'ASIA', 'OFF']);
  const [maxTradesPerSession] = useState(0);


  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const [progress, setProgress] = useState(0);
  const [trades, setTrades] = useState<BacktestTrade[]>([]);

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [sessions, setSessions] = useState<SessionHistory[]>(() => {
    try { return JSON.parse(localStorage.getItem('bt_sessions') || '[]'); } catch { return []; }
  });
  const [showLog, setShowLog] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<'GLOBAL' | 'OFF' | 'LONDON' | 'NY' | 'ASIA'>('GLOBAL');
  const [tradeFilter, setTradeFilter] = useState<string>('ALL');

  const optimizeSwitches = false;
  const [optimizedSessionResults, setOptimizedSessionResults] = useState<Record<string, { config: any, result: BacktestResult }>>({});
  const [enabled, setEnabled] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleRunRef = useRef<any>(null);
  const { toast } = useToast();

  // 🚀 WORKER PARA BACKTESTING (Desbloquea la UI en operaciones pesadas)
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL('../services/backtest.worker.ts', import.meta.url), { type: 'module' });
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const runWorkerTask = useCallback((type: string, payload: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) return reject('Worker no inicializado');
      const id = Date.now() + Math.random();
      
      let timeoutId: ReturnType<typeof setTimeout>;
      
      const handler = (e: MessageEvent) => {
        if (e.data.id === id) {
          clearTimeout(timeoutId);
          workerRef.current?.removeEventListener('message', handler);
          if (e.data.type === 'DONE') resolve(e.data.result);
          else reject(e.data.error);
        }
      };
      
      timeoutId = setTimeout(() => {
        workerRef.current?.removeEventListener('message', handler);
        reject(new Error('Worker Task Timeout (5m)'));
      }, 300000);

      workerRef.current.addEventListener('message', handler);
      workerRef.current.postMessage({ type, id, payload });
    });
  }, []);

  // 🗂️ TABS PRINCIPALES (INDIVIDUAL VS PORTAFOLIO GLOBAL)
  const [activeTab, setActiveTab] = useState<'individual' | 'portfolio'>('individual');

  // 💼 ESTADOS PORTAFOLIO GLOBAL
  interface PortfolioAssetFile {
    name: string;
    ticker: string;
    trades: any[];
  }
  const [portfolioFiles, setPortfolioFiles] = useState<PortfolioAssetFile[]>([]);
  const [globalMDL, setGlobalMDL] = useState(3.0);
  const [globalDPT, setGlobalDPT] = useState(5.0);
  const [globalMCL, setGlobalMCL] = useState(3);
  const [globalMTD, setGlobalMTD] = useState(4);
  const [globalTDD, setGlobalTDD] = useState(3.0);
  const [globalDisabledSessions, setGlobalDisabledSessions] = useState<string[]>([]);
  const [portfolioResults, setPortfolioResults] = useState<{
    trades: any[];
    metrics: any;
    equityData: any[];
  } | null>(null);
  const [isOptimizingPortfolio, setIsOptimizingPortfolio] = useState(false);
  const [portfolioOptResults, setPortfolioOptResults] = useState<any[]>([]);

  const TF_ORDER: Record<string, number> = { '240': 0, '60': 1, '15': 2, '5': 3 };
  const TF_LABEL: Record<string, string> = { '240': '4H', '60': '1H', '15': '15M', '5': '5M' };
  const TF_COLOR: Record<string, string> = { '240': '#7c4dff', '60': '#0088ff', '15': 'var(--accent-gold)', '5': 'var(--accent-red)' };

  const getSessionForTimestamp = useCallback((ts: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' => {
    const d = new Date(ts);
    const arHour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
    const arMin = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', minute: 'numeric' }));
    const timeDecimal = arHour + arMin / 60;
    
    // Asia: 21:00 - 04:00 AR
    if (timeDecimal >= 21 || timeDecimal < 4) return 'ASIA';
    // London: 04:00 - 10:30 AR
    if (timeDecimal >= 4 && timeDecimal < 10.5) return 'LONDON';
    // NY: 10:30 - 17:00 AR
    if (timeDecimal >= 10.5 && timeDecimal < 17) return 'NY';
    
    return 'OFF';
  }, []);

  const handleSessionSelect = useCallback((s: 'GLOBAL' | 'OFF' | 'LONDON' | 'NY' | 'ASIA') => {
    setSessionFilter(s);
    if (optimizedSessionResults[s]) {
      const { config, result: optResult } = optimizedSessionResults[s];
      setSlBufferPercent(config.slBufferPercent);
      setFixedRR(config.fixedRR);
      setOteEntryPercent(config.oteEntryPercent);

      setEntryTrigger(config.entryTrigger);
      setMinBuyPoints(config.minBuyPoints);
      setMinSellPoints(config.minSellPoints);
      setPartialClosePct(config.partialClosePct ?? 0.5);
      setSlAfterTp1(config.slAfterTp1 ?? 'midpoint');
      setTp15BeEnabled(config.tp15BeEnabled ?? true);
      setAtrTrailEnabled(config.atrTrailEnabled ?? true);
      setStructuralTrailEnabled(config.structuralTrailEnabled ?? true);
      setTp1StructuralMinRR(config.tp1StructuralMinRR ?? 1.2);
      setMaxDailyLossR(config.maxDailyLossR || 0);
      setDailyProfitTargetR(config.dailyProfitTargetR || 0);
      setMaxConsecutiveLosses(config.maxConsecutiveLosses || 0);
      setMaxTradesPerDay(config.maxTradesPerDay || 0);
      setTrailingDrawdownR(config.trailingDrawdownR || 0);
      setEnabled(config.enabled !== false);
      setResult(optResult);
      setTrades(optResult.trades);
    }
  }, [optimizedSessionResults]);

  const handlePushToBot = async () => {
    try {
      const configDoc = ticker; // v7.2 Unified master document
      
      const { OFF, LONDON, NY, ASIA } = sessionTriggers;
      const exportedSessions = {
        ALL: OFF,
        LONDON,
        NY,
        ASIA
      };

      await setDoc(doc(db, 'asset_configs', configDoc), {
        maxDailyLossR,
        dailyProfitTargetR,
        maxConsecutiveLosses,
        maxTradesPerDay,
        trailingDrawdownR,
        enabled: enabled,
        sessions: exportedSessions,
        
        // Sincronización para el Panel de Control (AdminPanel)
        slBufferPercent: slBufferPercent,
        fixedRR: fixedRR,
        minPointsForBuy: minBuyPoints,
        minPointsForSell: minSellPoints,
        entryTrigger: entryTrigger,
        oteEntryPercent: oteEntryPercent,

        // ⚙️ Gestión de trades (consumida por el bot en vivo)
        partialClosePct: partialClosePct,
        slAfterTp1: slAfterTp1,
        tp15BeEnabled: tp15BeEnabled,
        atrTrailEnabled: atrTrailEnabled,
        structuralTrailEnabled: structuralTrailEnabled,
        tp1StructuralMinRR: tp1StructuralMinRR,

        updatedAt: new Date().toISOString()
      }, { merge: true });
      toast(`✅ Configurada ${configDoc} en JARVIS (${enabled ? 'HABILITADA' : 'DESHABILITADA'})`, 'success');
    } catch (err: any) {
      toast(`❌ Error guardando: ${err.message}`, 'error');
    }
  };

  const handleFilesUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        const { lines, detectedTF } = parseCSV(content);
        if (lines.length === 0) { toast(`❌ ${file.name}: sin datos válidos`, 'error'); return; }
        
        setUploadedFiles(prev => {
          const filtered = prev.filter(f => f.tf !== detectedTF);
          const newFiles = [...filtered, { name: file.name, tf: detectedTF, lines, lineCount: lines.length }]
            .sort((a, b) => (TF_ORDER[a.tf] ?? 99) - (TF_ORDER[b.tf] ?? 99));
            

          
          setSessionTriggers(prevSessions => {
            const updated = { ...prevSessions };
            Object.keys(updated).forEach(sessionKey => {
              if (updated[sessionKey]) {
              }
            });
            localStorage.setItem('bt_session_triggers', JSON.stringify(updated));
            return updated;
          });
          
          return newFiles;
        });
        toast(`✅ ${TF_LABEL[detectedTF] || detectedTF}: ${lines.length} eventos cargados`, 'success');
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  }, [toast]);

  const handleResetConfig = useCallback(() => {
    setMinBuyPoints(4);
    setMinSellPoints(4);
    
    setSessionTriggers(prev => {
      const next = { ...prev };
      for (const s of Object.keys(next)) {
        next[s] = {
          ...next[s],
          choch15m: { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 },
          bos15m: { enabled: true, minScore: 4, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 },
          oteChoch15m: { enabled: true, minScore: 4, entryPercent: next[s].oteChoch15m?.entryPercent ?? 62, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 },
          oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62, slBuff: 0.1, tp2: 1.5, partialClosePct: 0.5, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, tp1StructuralMinRR: 1.2 },
        };
      }
      localStorage.setItem('bt_session_triggers', JSON.stringify(next));
      return next;
    });
  }, []);

  
  const handleOptimizeTrigger = (sessionKey: string, triggerKey: string) => {
    if (optimizingTrigger) return;
    setOptimizingTrigger(`${sessionKey}-${triggerKey}`);
    
    // Values to test
    const slBuffVals = [0, 0.05, 0.1, 0.2];
    const tp2Vals = [1.5, 2.0, 3.0, 4.0];
    const partialClosePctVals = [0, 0.5, 0.8];
    const slAfterTp1Vals: ('midpoint' | 'breakeven' | 'none')[] = ['none', 'midpoint', 'breakeven'];
    const tp15BeEnabledVals = [true, false];
    const atrTrailEnabledVals = [true, false];
    const structuralTrailEnabledVals = [true, false];

    const combinations: any[] = [];
    for (const sb of slBuffVals) {
      for (const t2 of tp2Vals) {
        for (const pcp of partialClosePctVals) {
          for (const sATp1 of slAfterTp1Vals) {
            for (const t15 of tp15BeEnabledVals) {
              for (const atr of atrTrailEnabledVals) {
                for (const str of structuralTrailEnabledVals) {
                  combinations.push({
                    slBuff: sb, tp2: t2, partialClosePct: pcp, slAfterTp1: sATp1,
                    tp15BeEnabled: t15, atrTrailEnabled: atr, structuralTrailEnabled: str
                  });
                }
              }
            }
          }
        }
      }
    }

    let bestConfig = combinations[0];
    let bestScore = -Infinity;
    let bestWinRate = -1;

    const baseConfig = JSON.parse(JSON.stringify(sessionTriggers));
    
    Object.keys(baseConfig).forEach(sk => {
      Object.keys(baseConfig[sk]).forEach(tk => {
        if (typeof baseConfig[sk][tk] === 'object' && baseConfig[sk][tk] !== null) {
           baseConfig[sk][tk].enabled = false;
        }
      });
    });

    if (!baseConfig[sessionKey]) baseConfig[sessionKey] = {};
    if (!baseConfig[sessionKey][triggerKey]) baseConfig[sessionKey][triggerKey] = { enabled: true, minScore: 4 };
    
    baseConfig[sessionKey][triggerKey].enabled = true;
    
    const CHUNK_SIZE = 50;
    let i = 0;

    const processChunk = () => {
      const end = Math.min(i + CHUNK_SIZE, combinations.length);
      for (; i < end; i++) {
        const testMgmt = combinations[i];
        
        const testSessionTriggers = JSON.parse(JSON.stringify(baseConfig));
        testSessionTriggers[sessionKey][triggerKey] = {
          ...testSessionTriggers[sessionKey][triggerKey],
          ...testMgmt
        };

        const finalOte = oteEntryPercent;
        const configToRun = {
          ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent: finalOte, entryTrigger: 'SMART' as const,
          maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses, maxTradesPerDay, trailingDrawdownR,
          sessions: testSessionTriggers,
          sessionFilter: [sessionKey],
          enabled: true,
          spreadPips,
          commissionPerLot,
          maxTradesPerSession
        };

        const result = runBacktest(csvData, configToRun);
        
        let pnlR = 0;
        let wins = 0;
        let total = 0;
        result.trades.forEach(t => {
           if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) {
               pnlR += t.rMultiple;
               total++;
               if (t.rMultiple > 0) wins++;
           }
        });
        const wr = total > 0 ? wins / total : 0;
        
        if (pnlR > bestScore || (pnlR === bestScore && wr > bestWinRate)) {
          bestScore = pnlR;
          bestWinRate = wr;
          bestConfig = testMgmt;
        }
      }

      if (i < combinations.length) {
        requestAnimationFrame(processChunk);
      } else {
        setSessionTriggers(prev => {
          const next = JSON.parse(JSON.stringify(prev));
          if (!next[sessionKey]) next[sessionKey] = {};
          if (!next[sessionKey][triggerKey]) next[sessionKey][triggerKey] = { enabled: true };
          next[sessionKey][triggerKey] = {
            ...next[sessionKey][triggerKey],
            ...bestConfig
          };
          return next;
        });
        toast(`Optimización completada. PnL Máximo: ${bestScore.toFixed(2)}R`, 'success');
        setOptimizingTrigger(null);
      }
    };

    requestAnimationFrame(processChunk);
  };

  const handleRun = useCallback((overrideOte?: number, overrideSessions?: Record<string, any>, isAutoRun: boolean = false) => {
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    setIsRunning(true); setProgress(0); setTrades([]); setResult(null);
    setOptimizedSessionResults({});

    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));

    const finalOte = overrideOte !== undefined ? overrideOte : oteEntryPercent;
    const finalSessions = overrideSessions !== undefined ? overrideSessions : sessionTriggers;

    setTimeout(async () => {
      const baseParams = {
        ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, entryTrigger,
        minRR, sessionFilter: activeSessions, spreadPips, commissionPerLot,
        maxDailyLossR: maxDailyLossR || undefined,
        dailyProfitTargetR: dailyProfitTargetR || undefined,
        maxConsecutiveLosses: maxConsecutiveLosses || undefined,
        maxTradesPerDay: maxTradesPerDay || undefined,
        maxTradesPerSession: maxTradesPerSession || undefined,
        trailingDrawdownR: trailingDrawdownR || undefined,
        partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled, tp1StructuralMinRR,
      };

      try {
        const payload = {
            logsArray: Array.from(logs.entries()),
            config: { ...baseParams, oteEntryPercent: finalOte, sessions: finalSessions }
        };
        
        const res = await runWorkerTask('RUN_BACKTEST', payload);
        
        setProgress(50);
        setTrades(res.trades);

        setResult(res);
        setTrades(res.trades);
        setProgress(100);
        setIsRunning(false);

      if (!isAutoRun) {
        // Save to history
        const filteredForMetrics = res.trades.filter((t: BacktestTrade) => {
          const hasOte = t.events?.some(e => e.includes('OTE_Retracement'));
          const isBos = t.events?.some(e => e.includes('EVENTO_BOS'));
          const isChoch = t.events?.some(e => e.includes('EVENTO_CHOCH'));


          const tfSuffix = '15m';
          let triggerType: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m' | null = null;
          if (hasOte && isBos) triggerType = `oteBos${tfSuffix}` as any;
          else if (hasOte && isChoch) triggerType = `oteChoch${tfSuffix}` as any;
          else if (isBos && !hasOte) triggerType = `bos${tfSuffix}` as any;
          else if (isChoch && !hasOte) triggerType = `choch${tfSuffix}` as any;

          if (sessionFilter !== 'GLOBAL' && tradeFilter !== 'ALL') {
            if (tradeFilter === 'CHOCH_15M' && triggerType !== 'choch15m') return false;
            if (tradeFilter === 'BOS_15M' && triggerType !== 'bos15m') return false;
            if (tradeFilter === 'OTE_CHOCH_15M' && triggerType !== 'oteChoch15m') return false;
            if (tradeFilter === 'OTE_BOS_15M' && triggerType !== 'oteBos15m') return false;
          }

          const sessionName = getSessionForTimestamp(t.timestamp);
          const config = finalSessions[sessionName];
          if (config && triggerType) {
            const triggerConfig = config[triggerType as keyof typeof config] as any;
            if (!triggerConfig || !triggerConfig.enabled) return false;
            if ((t.points || 0) < triggerConfig.minScore) return false;
          }
          return true;
        });

        const closed = filteredForMetrics.filter((t: BacktestTrade) => t.result && t.result !== 'TIMEOUT');
        const wins = closed.filter((t: BacktestTrade) => t.result === 'WIN').length;
        const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
        const pnl = closed.reduce((acc: number, t: BacktestTrade) => acc + (t.rMultiple || 0), 0).toFixed(2);
        const session: SessionHistory = {
          id: `BT_${Date.now()}`, ticker, date: res.startDate + ' → ' + res.endDate,
          trades: filteredForMetrics.length, winRate: wr, pnl, status: 'completed',
          tradeData: res.trades,
          config: { 
            minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent: finalOte, entryTrigger,
            sessions: finalSessions, minRR, sessionFilter: activeSessions, maxTradesPerSession, spreadPips, commissionPerLot,
            partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled, tp1StructuralMinRR
          }
        };
        setSessions(prev => {
          const next = [session, ...prev].slice(0, 20);
          localStorage.setItem('bt_sessions', JSON.stringify(next));
          return next;
        });
        setSelectedSession(session.id);
        toast(`✅ Backtest guardado: ${res.trades.length} trades detectados`, 'success');
      } else {
        toast(`✅ Filtros aplicados: ${res.trades.length} trades en pantalla`, 'success');
      }
      
      } catch (err: any) {
        toast(`❌ Error en Worker: ${err}`, 'error');
        setIsRunning(false);
      }
    }, 50);
  }, [uploadedFiles, ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger, maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses, maxTradesPerDay, trailingDrawdownR, sessionTriggers, toast, minRR, activeSessions, maxTradesPerSession, spreadPips, commissionPerLot, partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled, tp1StructuralMinRR]);


  handleRunRef.current = handleRun;

  // AUTO-SIMULATE cuando cambian los filtros por sesión
  const isFirstRender = useRef(true);
  const lastSessionTriggersStr = useRef(JSON.stringify(sessionTriggers));

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const currentStr = JSON.stringify(sessionTriggers);
    if (lastSessionTriggersStr.current !== currentStr) {
      lastSessionTriggersStr.current = currentStr;
    }
  }, [sessionTriggers]);

  const isOptimizingRef = useRef(false);
  const handleOptimize = useCallback(() => {
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    isOptimizingRef.current = true;
    setIsRunning(true); setProgress(0); setTrades([]); setResult(null);
    setOptimizedSessionResults({});

    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));

    const slOptions = [0, 0.05, 0.1, 0.2];
    const rrOptions = [1.5, 2.0, 2.5, 3.0, 4.0];
    const oteOptions = [50, 62, 79];
    const scoreOptions = [5, 8, 12, 15, 20]; // Puntos mínimos simétricos

    const combinations: {sl:number, rr:number, ote:number, score:number, trigger: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART'}[] = [];
    for (const sl of slOptions) {
      for (const rr of rrOptions) {
        for (const ote of oteOptions) {
          for (const score of scoreOptions) {
            combinations.push({ sl, rr, ote, score, trigger: entryTrigger });
          }
        }
      }
    }

    const bestPnl: Record<string, number> = { OFF: -Infinity, LONDON: -Infinity, NY: -Infinity, ASIA: -Infinity };
    const bestData: Record<string, { config: any, result: BacktestResult }> = {};

    const finalizeOptimization = () => {
        if (Object.keys(bestData).length > 0) {
            setOptimizedSessionResults(bestData);
            
            const currentData = bestData[sessionFilter] || bestData['OFF'];
            const bestConfig = currentData.config;
            const bestResult = currentData.result;
            
            setResult(bestResult);
            setTrades(bestResult.trades);
            setSlBufferPercent(bestConfig.slBufferPercent);
            setFixedRR(bestConfig.fixedRR);
            setOteEntryPercent(bestConfig.oteEntryPercent);

            setEntryTrigger(bestConfig.entryTrigger);
            setMinBuyPoints(bestConfig.minBuyPoints);
            setMinSellPoints(bestConfig.minSellPoints);

            // Also set killswitch state in the UI so the user sees the optimized values!
            setMaxDailyLossR(bestConfig.maxDailyLossR || 0);
            setDailyProfitTargetR(bestConfig.dailyProfitTargetR || 0);
            setMaxConsecutiveLosses(bestConfig.maxConsecutiveLosses || 0);
            setMaxTradesPerDay(bestConfig.maxTradesPerDay || 0);
            setTrailingDrawdownR(bestConfig.trailingDrawdownR || 0);
            setEnabled(bestConfig.enabled !== false);

            const updatedSessions = { ...sessionTriggers };
            (Object.keys(bestData) as Array<keyof typeof bestData>).forEach(s => {
              if (updatedSessions[s]) {
                updatedSessions[s] = {
                  ...updatedSessions[s],
                  maxSellLosses: 2,
                  maxBuyLosses: 2
                };
              }
            });
            setSessionTriggers(updatedSessions);
            localStorage.setItem('bt_session_triggers', JSON.stringify(updatedSessions));
            
            const closed = bestResult.trades.filter(t => t.result && t.result !== 'TIMEOUT');
            const wins = closed.filter(t => t.result === 'WIN').length;
            const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
            const pnl = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0).toFixed(2);
             const session: SessionHistory = {
              id: `BT_OPT_${Date.now()}`, ticker, date: bestResult.startDate + ' → ' + bestResult.endDate,
              trades: bestResult.trades.length, winRate: wr, pnl, status: 'completed',
              tradeData: bestResult.trades,
              config: {
                ...bestConfig,
                sessions: updatedSessions,
              }
            };
            setSessions(prev => {
              const next = [session, ...prev].slice(0, 20);
              localStorage.setItem('bt_sessions', JSON.stringify(next));
              return next;
            });




            setSelectedSession(session.id);
            setIsRunning(false);
            isOptimizingRef.current = false;
            toast(optimizeSwitches 
              ? `✅ Optimización finalizada para TODAS las sesiones (con Killswitches optimizados).`
              : `✅ Optimización finalizada para TODAS las sesiones.`, 
              'success'
            );
        }
    };

    const startStage2 = () => {
        const ksMaxDailyLoss = [0, 1.0, 1.5, 2.0, 3.0];
        const ksDailyProfit = [0, 2.0, 3.0, 4.0, 6.0];
        const ksMaxConsLosses = [0, 2, 3, 4];
        const ksMaxTrades = [0, 2, 3, 5];
        const ksTrailDD = [0, 1.5, 2.5, 4.0];

        const ksCombinations: {
            maxDailyLossR?: number,
            dailyProfitTargetR?: number,
            maxConsecutiveLosses?: number,
            maxTradesPerDay?: number,
            trailingDrawdownR?: number
        }[] = [];

        for (const mdl of ksMaxDailyLoss) {
            for (const dpt of ksDailyProfit) {
                for (const mcl of ksMaxConsLosses) {
                    for (const mt of ksMaxTrades) {
                        for (const tdd of ksTrailDD) {
                            ksCombinations.push({
                                maxDailyLossR: mdl || undefined,
                                dailyProfitTargetR: dpt || undefined,
                                maxConsecutiveLosses: mcl || undefined,
                                maxTradesPerDay: mt || undefined,
                                trailingDrawdownR: tdd || undefined
                            });
                        }
                    }
                }
            }
        }

        const stage2Tasks: {
            session: 'OFF' | 'LONDON' | 'NY' | 'ASIA',
            ks: typeof ksCombinations[number]
        }[] = [];

        const sessionsToEval = ['OFF', 'LONDON', 'NY', 'ASIA'] as const;
        sessionsToEval.forEach(s => {
            if (bestData[s]) {
                for (const ks of ksCombinations) {
                    stage2Tasks.push({ session: s, ks });
                }
            }
        });

        const bestStage2Pnl: Record<string, number> = { OFF: -Infinity, LONDON: -Infinity, NY: -Infinity, ASIA: -Infinity };
        const bestStage2Data: Record<string, { config: any, result: BacktestResult }> = {};

        const processStage2Chunk = async (startIndex: number) => {
            const chunkSize = 25;
            const endIndex = Math.min(startIndex + chunkSize, stage2Tasks.length);

            const validTasks = [];
            const chunkConfigs = [];
            for (let i = startIndex; i < endIndex; i++) {
                const task = stage2Tasks[i];
                const pass1Result = bestData[task.session];
                if (!pass1Result) continue;

                validTasks.push(task);
                chunkConfigs.push({
                    ...pass1Result.config,
                    ...task.ks
                });
            }

            if (chunkConfigs.length > 0) {
                try {
                    const chunkResults = await runWorkerTask('RUN_BATCH', { logsArray: Array.from(logs.entries()), configs: chunkConfigs });

                    for (let j = 0; j < chunkResults.length; j++) {
                        const task = validTasks[j];
                        const testConfig = chunkConfigs[j];
                        const res = chunkResults[j];

                        const sessionTrades = res.trades.filter((t: any) => getSessionForTimestamp(t.timestamp) === task.session);
                        
                        const closed = sessionTrades.filter((t: any) => t.result && t.result !== 'TIMEOUT');
                        const pnl = closed.reduce((acc: any, t: any) => acc + (t.rMultiple || 0), 0);

                        if (pnl > bestStage2Pnl[task.session]) {
                            bestStage2Pnl[task.session] = pnl;
                            bestStage2Data[task.session] = { config: testConfig, result: res };
                        }
                    }
                } catch(err) {
                    toast(`❌ Error en Worker (Stage 2): ${err}`, 'error');
                    setIsRunning(false);
                    isOptimizingRef.current = false;
                    return;
                }
            }

            const stage2Progress = Math.floor((endIndex / stage2Tasks.length) * 50) + 50;
            setProgress(stage2Progress);

            if (endIndex < stage2Tasks.length) {
                processStage2Chunk(endIndex);
            } else {
                Object.keys(bestStage2Data).forEach(s => {
                    bestData[s] = bestStage2Data[s];
                });
                finalizeOptimization();
            }
        };

        processStage2Chunk(0);
    };

    const processStage1Chunk = async (startIndex: number) => {
        const chunkSize = 15;
        const endIndex = Math.min(startIndex + chunkSize, combinations.length);
        
        const chunkConfigs = [];
        for (let i = startIndex; i < endIndex; i++) {
            const c = combinations[i];
            const optSessions: Record<string, any> = {};
            const sessionsToEval = ['OFF', 'LONDON', 'NY', 'ASIA'] as const;
            sessionsToEval.forEach(s => {
                optSessions[s] = {
                    ...(sessionTriggers[s] || {}),
                    maxSellLosses: 2,
                    maxBuyLosses: 2
                };
            });
            chunkConfigs.push({ 
                ticker, minBuyPoints: c.score, minSellPoints: c.score, slBufferPercent: c.sl, fixedRR: c.rr, oteEntryPercent: c.ote, entryTrigger: c.trigger,
                maxDailyLossR: optimizeSwitches ? undefined : (maxDailyLossR || undefined),
                dailyProfitTargetR: optimizeSwitches ? undefined : (dailyProfitTargetR || undefined),
                maxConsecutiveLosses: optimizeSwitches ? undefined : (maxConsecutiveLosses || undefined),
                maxTradesPerDay: optimizeSwitches ? undefined : (maxTradesPerDay || undefined),
                trailingDrawdownR: optimizeSwitches ? undefined : (trailingDrawdownR || undefined),
                partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled, tp1StructuralMinRR,
                sessions: optSessions
            });
        }
        
        try {
            const chunkResults = await runWorkerTask('RUN_BATCH', { logsArray: Array.from(logs.entries()), configs: chunkConfigs });
            
            for (let i = 0; i < chunkResults.length; i++) {
                const config = chunkConfigs[i];
                const res = chunkResults[i];
                
                const sessionsToEval = ['OFF', 'LONDON', 'NY', 'ASIA'] as const;
                sessionsToEval.forEach(s => {
                    const sessionTrades = res.trades.filter((t: any) => getSessionForTimestamp(t.timestamp) === s);
                    
                    const closed = sessionTrades.filter((t: any) => t.result && t.result !== 'TIMEOUT');
                    const pnl = closed.reduce((acc: any, t: any) => acc + (t.rMultiple || 0), 0);
                    
                    if (pnl > bestPnl[s]) {
                        bestPnl[s] = pnl;
                        bestData[s] = { config, result: res };
                    }
                });
            }
            
            const baseProgress = Math.floor((endIndex / combinations.length) * 100);
            setProgress(optimizeSwitches ? Math.floor(baseProgress / 2) : baseProgress);
            
            if (endIndex < combinations.length) {
                processStage1Chunk(endIndex);
            } else {
                if (optimizeSwitches && Object.keys(bestData).length > 0) {
                    startStage2();
                } else {
                    finalizeOptimization();
                }
            }
        } catch (err) {
            toast(`❌ Error en Worker (Stage 1): ${err}`, 'error');
            setIsRunning(false);
            isOptimizingRef.current = false;
        }
    };
    
    processStage1Chunk(0);
  }, [uploadedFiles, ticker, entryTrigger, sessionFilter, toast, getSessionForTimestamp, maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses, maxTradesPerDay, trailingDrawdownR, optimizeSwitches, partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled, tp1StructuralMinRR]);



  // 📊 MOTOR DE SIMULACIÓN DE PORTAFOLIO GLOBAL
  const runPortfolioSimulation = useCallback((
    files: PortfolioAssetFile[],
    config: {
      mdl: number;
      dpt: number;
      mcl: number;
      mtd: number;
      tdd: number;
      disabledSessions?: string[];
      _precomputedTrades?: any[];
    }
  ) => {
    let allTrades = config._precomputedTrades;
    if (!allTrades) {
      if (files.length === 0) return null;
      allTrades = [];
      files.forEach(f => {
        f.trades.forEach(t => {
          const date = new Date(t.timestamp);
          allTrades!.push({
            ...t,
            ticker: f.ticker,
            _dateStr: date.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }),
            _session: getSessionForTimestamp(t.timestamp)
          });
        });
      });
      allTrades.sort((a, b) => a.timestamp - b.timestamp);
    }

    if (allTrades.length === 0) return null;

    // Simulación día a día en huso horario de Argentina
    let simulatedTrades: any[] = [];
    let currentDayStr = '';
    
    // Variables de control de día
    let dailyPnLR = 0;
    let dailyTradesCount = 0;
    let dailyConsecutiveLosses = 0;
    let dailyPeakPnLR = 0;
    let isDailyKilled = false;
    let dailyKillReason = '';

    let totalPnLR = 0;
    let worstDailyLoss = 0; // El peor día (más negativo)

    allTrades.forEach(t => {
      // Usar los valores precalculados
      const dateStr = t._dateStr;

      if (dateStr !== currentDayStr) {
        // Antes de resetear, registrar el peor día
        if (dailyPnLR < worstDailyLoss) {
          worstDailyLoss = dailyPnLR;
        }
        currentDayStr = dateStr;
        dailyPnLR = 0;
        dailyTradesCount = 0;
        dailyConsecutiveLosses = 0;
        dailyPeakPnLR = 0;
        isDailyKilled = false;
        dailyKillReason = '';
      }

      const r = Number(t.rMultiple) || 0;
      const tSession = t._session;

      if (config.disabledSessions && config.disabledSessions.includes(tSession)) {
        simulatedTrades.push({
          ...t,
          blockedByGlobalKillswitch: true,
          blockReason: `Sesión ${tSession} Deshabilitada`,
          cumulativePnLR: totalPnLR
        });
        return; // skip daily logic
      }

      if (isDailyKilled) {
        simulatedTrades.push({
          ...t,
          blockedByGlobalKillswitch: true,
          blockReason: dailyKillReason,
          cumulativePnLR: totalPnLR
        });
      } else {
        // Registrar trade no bloqueado
        totalPnLR += r;
        simulatedTrades.push({
          ...t,
          blockedByGlobalKillswitch: false,
          cumulativePnLR: totalPnLR
        });

        // Actualizar estadísticas del día
        dailyPnLR += r;
        dailyTradesCount++;
        if (r < 0) {
          dailyConsecutiveLosses++;
        } else {
          // Both Win (> 0) and BE (=== 0) reset the consecutive loss streak
          dailyConsecutiveLosses = 0;
        }

        if (dailyPnLR > dailyPeakPnLR) {
          dailyPeakPnLR = dailyPnLR;
        }

        const dailyDrawdown = dailyPeakPnLR - dailyPnLR;

        // Comprobar triggers de bloqueo diario consolidado
        if (config.mdl > 0 && dailyPnLR <= -config.mdl) {
          isDailyKilled = true;
          dailyKillReason = `Max Daily Loss superado (-${config.mdl}R)`;
        } else if (config.dpt > 0 && dailyPnLR >= config.dpt) {
          isDailyKilled = true;
          dailyKillReason = `Daily Profit Target alcanzado (+${config.dpt}R)`;
        } else if (config.mtd > 0 && dailyTradesCount >= config.mtd) {
          isDailyKilled = true;
          dailyKillReason = `Max Trades/Día superado (${config.mtd})`;
        } else if (config.mcl > 0 && dailyConsecutiveLosses >= config.mcl) {
          isDailyKilled = true;
          dailyKillReason = `Max Pérdidas Consecutivas superado (${config.mcl})`;
        } else if (config.tdd > 0 && dailyDrawdown >= config.tdd) {
          isDailyKilled = true;
          dailyKillReason = `Trailing Drawdown superado (${config.tdd}R)`;
        }
      }
    });

    // Capturar el último día en curso
    if (dailyPnLR < worstDailyLoss) {
      worstDailyLoss = dailyPnLR;
    }

    // Métricas finales
    const activeTrades = simulatedTrades.filter(t => !t.blockedByGlobalKillswitch);
    const totalTradesCount = activeTrades.length;
    const wins = activeTrades.filter(t => t.result === 'WIN').length;
    const losses = activeTrades.filter(t => t.result === 'LOSS').length;
    const be = activeTrades.filter(t => t.result === 'BE').length;

    const wr = totalTradesCount > 0 ? ((wins / totalTradesCount) * 100).toFixed(1) : '0';
    
    let grossProfitR = 0;
    let grossLossR = 0;
    let maxDD = 0;
    let peak = 0;
    let cumPnL = 0;

    activeTrades.forEach(t => {
      const r = Number(t.rMultiple) || 0;
      if (r > 0) grossProfitR += r;
      else grossLossR += Math.abs(r);

      cumPnL += r;
      if (cumPnL > peak) peak = cumPnL;
      const dd = peak - cumPnL;
      if (dd > maxDD) maxDD = dd;
    });

    const profitFactor = grossLossR > 0 ? (grossProfitR / grossLossR).toFixed(2) : (grossProfitR > 0 ? '∞' : '0.00');

    // Curva de capital
    const equityData = [{ name: 'Start', PnL: 0 }];
    cumPnL = 0;
    activeTrades.forEach((t, idx) => {
      cumPnL += Number(t.rMultiple) || 0;
      equityData.push({
        name: `T${idx + 1}`,
        PnL: parseFloat(cumPnL.toFixed(2))
      });
    });

    return {
      trades: simulatedTrades,
      equityData,
      metrics: {
        wr,
        profitFactor,
        totalPnLR: totalPnLR.toFixed(2),
        activeTradesCount: totalTradesCount,
        blockedTradesCount: simulatedTrades.filter(t => t.blockedByGlobalKillswitch).length,
        wins,
        losses,
        be,
        maxDDR: maxDD.toFixed(2),
        worstDailyLoss: worstDailyLoss.toFixed(2)
      }
    };
  }, []);

  // 🔎 GRID SEARCH: OPTIMIZADOR INTELIGENTE DE KILLSWITCHES GLOBALES
  const optimizePortfolioKillswitches = useCallback(() => {
    if (portfolioFiles.length === 0) return;
    setIsOptimizingPortfolio(true);

    setTimeout(async () => {
      // 1. PRE-CALCULAR TRADES (hacerlo solo 1 vez en lugar de 1300 veces)
      let allTrades: any[] = [];
      portfolioFiles.forEach(f => {
        f.trades.forEach(t => {
          const date = new Date(t.timestamp);
          allTrades.push({
            ...t,
            ticker: f.ticker,
            _dateStr: date.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }),
            _session: getSessionForTimestamp(t.timestamp)
          });
        });
      });
      allTrades.sort((a, b) => a.timestamp - b.timestamp);

      // Opciones adaptadas para Funding Pips Standard 5k
      const mdlOptions = [0, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
      const dptOptions = [0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0]; 
      const mtdOptions = [0, 2, 3, 4, 5, 6];
      const disabledSessionsOptions = [[], ['ASIA'], ['NY'], ['LONDON']];
      
      let combinations: { mdl: number, dpt: number, mtd: number, disabledSessions: string[] }[] = [];
      for (const mdl of mdlOptions) {
        for (const dpt of dptOptions) {
          for (const mtd of mtdOptions) {
            for (const ds of disabledSessionsOptions) {
              combinations.push({ mdl, dpt, mtd, disabledSessions: ds });
            }
          }
        }
      }

      let results: any[] = [];

      // Bucle asincrónico para procesar el Grid sin trabar la UI
      for (let i = 0; i < combinations.length; i++) {
        const c = combinations[i];
        
        // Evitar bloqueo del hilo principal (yield)
        if (i % 50 === 0 && i > 0) {
          await new Promise(r => setTimeout(r, 0));
        }

        const sim = runPortfolioSimulation(portfolioFiles, {
          mdl: c.mdl,
          dpt: c.dpt,
          mtd: c.mtd,
          mcl: globalMCL,
          tdd: globalTDD,
          disabledSessions: c.disabledSessions,
          _precomputedTrades: allTrades
        });

        if (sim) {
          const mdd = parseFloat(sim.metrics.maxDDR);
          const worstDay = parseFloat(sim.metrics.worstDailyLoss);
          
          // REGLA DE ORO STANDARD: Max Drawdown global es 10%. Rechazar combinaciones mayores a 9.0% (9R)
          if (mdd > 9.0) continue;
          
          // REGLA CRÍTICA: Pérdida diaria máxima es 5% (5R). Si ALGÚN día superó -5R, esta 
          // combinación habría quemado la cuenta. Rechazar de inmediato.
          if (worstDay < -5.0) continue;

          results.push({
            config: c,
            pnlR: parseFloat(sim.metrics.totalPnLR),
            wr: parseFloat(sim.metrics.wr),
            blocked: sim.metrics.blockedTradesCount,
            active: sim.metrics.activeTradesCount,
            mdd: mdd,
            worstDay: worstDay,
            // Calmar Ratio: Retorno / Max Drawdown (mayor es mejor)
            calmar: mdd > 0 ? parseFloat(sim.metrics.totalPnLR) / mdd : parseFloat(sim.metrics.totalPnLR)
          });
        }
      } // Fin for combinations
      // Ordenar por Calmar Ratio (mejor ratio retorno/riesgo) descendente.
      // Para cuentas de fondeo, priorizar combinaciones que maximicen ganancia
      // sin acercarse al límite de drawdown.
      results.sort((a, b) => {
        // Filtrar combinaciones con PnL negativo al fondo
        if (a.pnlR <= 0 && b.pnlR > 0) return 1;
        if (a.pnlR > 0 && b.pnlR <= 0) return -1;
        // Ambos positivos: ordenar por Calmar Ratio
        return b.calmar - a.calmar;
      });

      setPortfolioOptResults(results.slice(0, 5));
      setIsOptimizingPortfolio(false);
      toast('✅ Grid Search optimizado. ¡Elegí la mejor opción abajo!', 'success');
    }, 100);
  }, [portfolioFiles, runPortfolioSimulation, toast, globalMCL, globalTDD]);

  // 💾 SUBIR LA CONFIGURACIÓN GLOBAL A JARVIS FIRESTORE
  const handlePushGlobalToBot = async () => {
    try {
      await setDoc(doc(db, 'asset_configs', 'GLOBAL'), {
        enabled: true,
        maxDailyLossR: globalMDL,
        dailyProfitTargetR: globalDPT,
        maxConsecutiveLosses: globalMCL,
        maxTradesPerDay: globalMTD,
        trailingDrawdownR: globalTDD,
        disabledSessions: globalDisabledSessions,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      toast(`✅ Configuración Global subida a JARVIS con éxito!`, 'success');
    } catch (err: any) {
      toast(`❌ Error subiendo config global: ${err.message}`, 'error');
    }
  };

  // 📂 CARGA DE ARCHIVOS JSON DE BACKTESTING INDIVIDUAL
  const handlePortfolioUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const content = ev.target?.result as string;
          const data = JSON.parse(content);

          if (!data.trades || !Array.isArray(data.trades)) {
            toast(`❌ ${file.name}: no es un archivo de backtesting válido de JARVIS`, 'error');
            return;
          }

          const detectedTicker = data.metadata?.ticker || 'DESCONOCIDO';
          const cleanTrades = data.trades.filter((t: any) => t.result && t.result !== 'TIMEOUT');

          setPortfolioFiles(prev => {
            const filtered = prev.filter(f => f.ticker !== detectedTicker);
            const newFiles = [...filtered, {
              name: file.name,
              ticker: detectedTicker,
              trades: cleanTrades
            }];
            
            setTimeout(() => {
              const res = runPortfolioSimulation(newFiles, {
                mdl: globalMDL,
                dpt: globalDPT,
                mcl: globalMCL,
                mtd: globalMTD,
                tdd: globalTDD,
                disabledSessions: globalDisabledSessions
              });
              setPortfolioResults(res);
            }, 50);

            return newFiles;
          });

          toast(`✅ ${detectedTicker}: ${cleanTrades.length} trades importados`, 'success');
        } catch (err: any) {
          toast(`❌ Error leyendo JSON: ${err.message}`, 'error');
        }
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  }, [toast, globalMDL, globalDPT, globalMCL, globalMTD, globalTDD, runPortfolioSimulation]);

  // 🎛️ ACTUALIZACIÓN DINÁMICA DE PARÁMETROS
  const handleGlobalParamChange = (param: string, val: number | string[]) => {
    let newMdl = globalMDL;
    let newDpt = globalDPT;
    let newMcl = globalMCL;
    let newMtd = globalMTD;
    let newTdd = globalTDD;

    if (param === 'mdl') { setGlobalMDL(val as number); newMdl = val as number; }
    else if (param === 'dpt') { setGlobalDPT(val as number); newDpt = val as number; }
    else if (param === 'mcl') { setGlobalMCL(val as number); newMcl = val as number; }
    else if (param === 'mtd') { setGlobalMTD(val as number); newMtd = val as number; }
    else if (param === 'tdd') { setGlobalTDD(val as number); newTdd = val as number; }

    const res = runPortfolioSimulation(portfolioFiles, {
      mdl: newMdl,
      dpt: newDpt,
      mcl: newMcl,
      mtd: newMtd,
      tdd: newTdd,
      disabledSessions: param === 'disabledSessions' ? (val as string[]) : globalDisabledSessions
    });
    setPortfolioResults(res);
  };

  const isGlobal = sessionFilter === 'GLOBAL';
  const baseTrades = isGlobal ? trades : trades.filter(t => getSessionForTimestamp(t.timestamp) === sessionFilter);

  const tripleFilteredTrades = baseTrades.filter(t => {
        const hasOte = t.events?.some(e => e.includes('OTE_Retracement'));
        const isBos = t.events?.some(e => e.includes('EVENTO_BOS'));
        const isChoch = t.events?.some(e => e.includes('EVENTO_CHOCH'));


        const tfSuffix = '15m';
        let triggerType: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m' | null = null;
        if (hasOte && isBos) triggerType = `oteBos${tfSuffix}` as any;
        else if (hasOte && isChoch) triggerType = `oteChoch${tfSuffix}` as any;
        else if (isBos && !hasOte) triggerType = `bos${tfSuffix}` as any;
        else if (isChoch && !hasOte) triggerType = `choch${tfSuffix}` as any;

        // 1. Local filter by selected tradeFilter in UI (when not in GLOBAL mode)
        if (!isGlobal && tradeFilter !== 'ALL') {
          if (tradeFilter === 'CHOCH_15M' && triggerType !== 'choch15m') return false;
          if (tradeFilter === 'BOS_15M' && triggerType !== 'bos15m') return false;
          if (tradeFilter === 'OTE_CHOCH_15M' && triggerType !== 'oteChoch15m') return false;
          if (tradeFilter === 'OTE_BOS_15M' && triggerType !== 'oteBos15m') return false;
        }

        // 2. Dynamic filter based on sessionTriggers configuration (score & enabled)
        const sessionName = getSessionForTimestamp(t.timestamp);
        const config = sessionTriggers[sessionName];
        if (config && triggerType) {
          const triggerConfig = config[triggerType] as any;
          if (!triggerConfig || !triggerConfig.enabled) return false;
          if ((t.points || 0) < triggerConfig.minScore) return false;
        }

        return true;
    });

  // Metrics
  const metrics = useMemo(() => {
    return calculateAdvancedMetrics(tripleFilteredTrades, riskUsd);
  }, [tripleFilteredTrades, riskUsd]);

  const portfolioExtendedMetrics = useMemo(() => {
    if (!portfolioResults) return null;
    const activeTrades = portfolioResults.trades.filter(t => !t.blockedByGlobalKillswitch);
    return calculateAdvancedMetrics(activeTrades, riskUsd);
  }, [portfolioResults, riskUsd]);

  const equityData = [{ name: 'Start', TP1: 0, TP2: 0 }];
  let cumTp1 = 0;
  let cumTp2 = 0;
  metrics.closed.forEach((t, i) => {
    cumTp1 += (t.rMultipleTp1 || 0) * riskUsd;
    cumTp2 += (t.rMultipleTp2 || 0) * riskUsd;
    equityData.push({
      name: `T${i + 1}`,
      TP1: parseFloat(cumTp1.toFixed(2)),
      TP2: parseFloat(cumTp2.toFixed(2)),
    });
  });

  const resultColor = (r?: string) => r === 'WIN' ? 'var(--accent-green)' : r === 'LOSS' ? 'var(--accent-red)' : r === 'BE' ? 'var(--accent-gold)' : 'var(--text-tertiary)';

  const handleDownloadJson = useCallback(() => {
    if (!result || trades.length === 0) {
      toast('No hay resultados para descargar', 'error');
      return;
    }
    
    // Calcular las métricas globales para la exportación completa (sin aplicar los filtros visuales)
    const closedGlobal = trades.filter(t => t.result && t.result !== 'TIMEOUT');
    const winsGlobal = closedGlobal.filter(t => t.result === 'WIN').length;
    const lossesGlobal = closedGlobal.filter(t => t.result === 'LOSS').length;
    const beGlobal = closedGlobal.filter(t => t.result === 'BE').length;
    const openGlobal = trades.filter(t => !t.result).length;
    
    const pnlTotalUsdGlobal = closedGlobal.reduce((acc, t) => acc + (t.rMultiple || 0) * riskUsd, 0);
    const pnlTotalRGlobal = closedGlobal.reduce((acc, t) => acc + (t.rMultiple || 0), 0);
    const wrGlobal = closedGlobal.length > 0 ? ((winsGlobal / closedGlobal.length) * 100).toFixed(1) : '—';
    
    let maxDDGlobal = 0, peakGlobal = 0;
    let grossProfitUsdGlobal = 0, grossLossUsdGlobal = 0;
    let maxConsLossesGlobal = 0, currentLossStreakGlobal = 0;
    let totalDurationGlobal = 0, tradesWithDurationGlobal = 0;
    let tp1OnlyCountGlobal = 0, tp2CountGlobal = 0, slCountGlobal = 0, beCountGlobal = 0;

    closedGlobal.forEach(t => {
      const r = t.rMultiple || 0;
      const profitUsd = r * riskUsd;
      
      peakGlobal += profitUsd;
      if (peakGlobal < maxDDGlobal) maxDDGlobal = peakGlobal;

      if (profitUsd > 0) grossProfitUsdGlobal += profitUsd;
      else grossLossUsdGlobal += Math.abs(profitUsd);

      if (t.result === 'LOSS') {
        currentLossStreakGlobal++;
        if (currentLossStreakGlobal > maxConsLossesGlobal) maxConsLossesGlobal = currentLossStreakGlobal;
      } else if (t.result === 'WIN') {
        currentLossStreakGlobal = 0;
      }

      if (t.durationMin) {
        totalDurationGlobal += t.durationMin;
        tradesWithDurationGlobal++;
      }

      if (t.result === 'WIN') {
          if (t.resultTp2 === 'WIN') tp2CountGlobal++;
          else tp1OnlyCountGlobal++;
      } else if (t.result === 'LOSS') {
          slCountGlobal++;
      } else if (t.result === 'BE') {
          beCountGlobal++;
      }
    });

    const profitFactorGlobal = grossLossUsdGlobal > 0 ? (grossProfitUsdGlobal / grossLossUsdGlobal).toFixed(2) : (grossProfitUsdGlobal > 0 ? '∞' : '0.00');
    const expectancyRGlobal = closedGlobal.length > 0 ? (pnlTotalRGlobal / closedGlobal.length).toFixed(2) : '0.00';
    const avgDurationMinGlobal = tradesWithDurationGlobal > 0 ? Math.round(totalDurationGlobal / tradesWithDurationGlobal) : 0;
    
    const formatDuration = (mins: number) => {
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    };

    const globalMetrics = {
      wins: winsGlobal,
      losses: lossesGlobal,
      be: beGlobal,
      open: openGlobal,
      wr: wrGlobal,
      pnlUsd: pnlTotalUsdGlobal.toFixed(2),
      pnlR: pnlTotalRGlobal.toFixed(2),
      count: closedGlobal.length,
      total: trades.length,
      maxDDUsd: maxDDGlobal.toFixed(2),
      closed: closedGlobal,
      profitFactor: profitFactorGlobal,
      expectancyR: expectancyRGlobal,
      maxConsLosses: maxConsLossesGlobal,
      avgDuration: formatDuration(avgDurationMinGlobal),
      tp1OnlyCount: tp1OnlyCountGlobal,
      tp2Count: tp2CountGlobal,
      slCount: slCountGlobal,
      beCount: beCountGlobal
    };

    const downloadData = {
      metadata: {
        ticker,
        exportDate: new Date().toISOString(),
        timeframe: result.startDate + ' -> ' + result.endDate,
        sessionFilter,
        tradeFilter
      },
      config: {
        minBuyPoints,
        minSellPoints,
        slBufferPercent,
        fixedRR,
        oteEntryPercent,
        entryTrigger,
        partialClosePct,
        slAfterTp1,
        tp15BeEnabled,
        atrTrailEnabled,
        structuralTrailEnabled,
        tp1StructuralMinRR,
        sessions: sessionTriggers
      },
      metrics: globalMetrics,
      trades: trades
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(downloadData, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `jarvis_bt_${ticker}_${new Date().getTime()}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    toast('✅ Archivo JSON descargado con éxito (historial completo de trades)', 'success');
  }, [result, trades, ticker, sessionFilter, tradeFilter, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger, sessionTriggers, riskUsd, toast, spreadPips, commissionPerLot, partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled, tp1StructuralMinRR]);

  const handleTickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    setTicker(val);
    
    if (val.includes('BTC')) {
      setSpreadPips(15.0);
      setCommissionPerLot(0);
    } else if (val.includes('ETH')) {
      setSpreadPips(1.5);
      setCommissionPerLot(0);
    } else if (val.includes('XAU') || val.includes('GOLD')) {
      setSpreadPips(1.5);
      setCommissionPerLot(6.0);
    } else if (val.includes('XAG') || val.includes('SILVER')) {
      setSpreadPips(2.0);
      setCommissionPerLot(6.0);
    } else if (['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI', 'GER', 'UK', 'FRA', 'EU50', 'WS30', 'UT100'].some(i => val.includes(i))) {
      setSpreadPips(1.5);
      setCommissionPerLot(0);
    } else if (['USOIL', 'WTI', 'UKOIL', 'BRENT', 'NATGAS'].some(i => val.includes(i))) {
      setSpreadPips(2.5);
      setCommissionPerLot(0);
    } else if (['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'USDJPY'].includes(val)) {
      setSpreadPips(0.2);
      setCommissionPerLot(6.0);
    } else if (['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'].some(i => val.includes(i))) {
      setSpreadPips(0.8);
      setCommissionPerLot(6.0);
    } else {
      setSpreadPips(1.0);
      setCommissionPerLot(6.0);
    }
  };

  return (
    <div className="animate-fadeIn">
      <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ display: 'flex', alignItems: 'center', fontWeight: 700 }}>
            <Upload size={14} style={{ marginRight: 8 }} /> BACKTESTING STANDALONE v3.0 {isRunning && <span className="live-dot"></span>}
          </span>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Motor local y optimizador multi-activo</span>
        </div>

        {/* 🎂 SELECTOR DE PESTAÑAS PREMIUM */}
        <div style={{
          display: 'flex',
          background: 'rgba(255, 255, 255, 0.05)',
          borderRadius: '8px',
          padding: '2px',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          backdropFilter: 'blur(10px)',
          gap: '2px'
        }}>
          <button
            onClick={() => setActiveTab('individual')}
            style={{
              padding: '6px 14px',
              fontSize: '0.75rem',
              fontWeight: 600,
              borderRadius: '6px',
              border: 'none',
              background: activeTab === 'individual' ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
              color: activeTab === 'individual' ? '#fff' : 'var(--text-tertiary)',
              cursor: 'pointer',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <TrendingUp size={12} color={activeTab === 'individual' ? 'var(--accent-gold)' : 'var(--text-tertiary)'} /> Backtest Individual
          </button>
          <button
            onClick={() => setActiveTab('portfolio')}
            style={{
              padding: '6px 14px',
              fontSize: '0.75rem',
              fontWeight: 600,
              borderRadius: '6px',
              border: 'none',
              background: activeTab === 'portfolio' ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
              color: activeTab === 'portfolio' ? '#fff' : 'var(--text-tertiary)',
              cursor: 'pointer',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <Briefcase size={12} color={activeTab === 'portfolio' ? 'var(--accent-gold)' : 'var(--text-tertiary)'} /> Portafolio Global
          </button>
        </div>
      </div>

      {activeTab === 'individual' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginBottom: '24px' }}>
          
          {/* DASHBOARD AVANZADO (FULL WIDTH HEADER) */}
          <div className="panel" style={{ padding: '24px' }}>
            <h3 style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <BarChart2 size={20} color="var(--accent-gold)" /> DASHBOARD AVANZADO
              </span>
              {result && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontWeight: 400 }}>
                  {result.processedEvents.toLocaleString()} eventos procesados | {result.startDate} → {result.endDate}
                </span>
              )}
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px' }}>
              {/* LEFT COL: Metrics Summary */}
              <AdvancedDashboardMetrics metrics={metrics} />

              {/* RIGHT COL: Equity Curve */}
              <div style={{ height: '240px', display: 'flex', flexDirection: 'column' }}>
                {metrics.closed.length > 0 ? (
                  <div style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '6px', padding: '16px 16px 16px 0', display: 'flex', flexDirection: 'column', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <h4 style={{ marginLeft: '16px', marginBottom: '12px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>CURVA DE CAPITAL (EQUITY CURVE)</h4>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={equityData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                          <XAxis dataKey="name" stroke="var(--text-tertiary)" fontSize={10} tickLine={false} axisLine={false} />
                          <YAxis stroke="var(--text-tertiary)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(val) => `$${val}`} width={40} />
                          <Tooltip 
                            contentStyle={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '0.8rem' }}
                            itemStyle={{ padding: 0 }}
                            formatter={(value: any) => [`$${value}`]}
                          />
                          <Line type="monotone" dataKey="TP1" name="PNL TP1" stroke="var(--accent-green)" strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="TP2" name="PNL TP2" stroke="#0088ff" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                ) : (
                  <div style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.1)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: '0.8rem', border: '1px solid rgba(255,255,255,0.02)' }}>
                    Sin datos de curva de capital
                  </div>
                )}
              </div>
            </div>


          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px' }}>
            {/* LEFT COLUMN */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* UPLOAD */}
          <div className="panel">
            <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Upload size={18} color="var(--accent-gold)" /> SUBIR LOGS CSV
            </h3>

            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>ACTIVO</label>
              <input type="text" value={ticker} onChange={handleTickerChange} className="mono" placeholder="BTCUSD"
                style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
            </div>



            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', padding: '8px 10px', backgroundColor: 'rgba(32,191,107,0.05)', borderRadius: '4px', border: '1px solid rgba(32,191,107,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-green)', whiteSpace: 'nowrap', fontWeight: 600 }}>💵 RIESGO (USD)</label>
              <input type="number" min="1" step="1" value={riskUsd} onChange={e => setRiskUsd(parseFloat(e.target.value) || 0)}
                style={{ flex: 1, padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', textAlign: 'right' }} />
            </div>

            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontWeight: 600 }}>SPREAD PIPS</label>
                <input type="number" min="0" step="0.1" value={spreadPips} onChange={e => setSpreadPips(parseFloat(e.target.value) || 0)}
                  style={{ flex: 1, padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', textAlign: 'right' }} />
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontWeight: 600 }}>COMISIÓN/LOTE</label>
                <input type="number" min="0" step="1" value={commissionPerLot} onChange={e => setCommissionPerLot(parseFloat(e.target.value) || 0)}
                  style={{ flex: 1, padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', textAlign: 'right' }} />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(124,77,255,0.05)', borderRadius: '4px', border: '1px solid rgba(124,77,255,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: '#7c4dff', whiteSpace: 'nowrap', fontWeight: 600 }}>⚙️ GATILLO GLOBAL</label>
              <select value={entryTrigger} onChange={e => setEntryTrigger(e.target.value as any)}
                style={{ flex: 1, padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', textAlign: 'right', outline: 'none', cursor: 'pointer' }}>
                <option value="SMART">SMART (Filtro R:R)</option>
                <option value="BOTH">BOTH (Choch + Ote)</option>
                <option value="CHOCH">CHOCH (Ruptura)</option>
                <option value="OTE">OTE (Pullback)</option>
              </select>
            </div>





            <div style={{ border: '2px dashed var(--border-color)', borderRadius: '8px', padding: '16px', textAlign: 'center', cursor: 'pointer', marginBottom: '12px', transition: 'border-color 0.2s' }}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--accent-gold)'; }}
              onDragLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
              onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--border-color)'; if (e.dataTransfer.files.length) { const dt = new DataTransfer(); Array.from(e.dataTransfer.files).forEach(f => dt.items.add(f)); const input = fileInputRef.current; if (input) { input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); } } }}>
              <FileText size={24} color="var(--text-tertiary)" style={{ marginBottom: '8px' }} />
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Click o arrastrá los 4 CSV del Pine Editor
              </div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                Auto-detecta TF por contenido (5M, 15M, 1H, 4H)
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept=".csv,.txt,.log" multiple onChange={handleFilesUpload} style={{ display: 'none' }} />

            {uploadedFiles.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' }}>
                {uploadedFiles.map(f => (
                  <div key={f.tf} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.8rem', color: TF_COLOR[f.tf] || 'var(--text-primary)', minWidth: '32px' }}>
                      {TF_LABEL[f.tf] || f.tf}
                    </span>
                    <span style={{ flex: 1, fontSize: '0.65rem', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.name}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--accent-green)', fontWeight: 600 }}>
                      ✓ {f.lineCount}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={() => handleRun()} disabled={uploadedFiles.length === 0 || isRunning}
                style={{ flex: 1, padding: '10px', backgroundColor: uploadedFiles.length > 0 && !isRunning ? '#7c4dff' : 'var(--bg-secondary)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: uploadedFiles.length > 0 && !isRunning ? 'pointer' : 'not-allowed', opacity: uploadedFiles.length > 0 ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <Play size={14} /> SIMULAR
              </button>
              <button type="button" onClick={handleOptimize} disabled={uploadedFiles.length === 0 || isRunning}
                style={{ flex: 1, padding: '10px', backgroundColor: uploadedFiles.length > 0 && !isRunning ? 'var(--accent-gold)' : 'var(--bg-secondary)', color: 'black', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: uploadedFiles.length > 0 && !isRunning ? 'pointer' : 'not-allowed', opacity: uploadedFiles.length > 0 ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <Wand2 size={14} /> OPTIMIZAR
              </button>
              <button type="button" onClick={handleResetConfig}
                title="Resetear Configuración a Valores por Defecto (Score 4)"
                style={{ padding: '10px', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-tertiary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RotateCcw size={14} />
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" onClick={handlePushToBot}
                  style={{ flex: 1, padding: '10px', backgroundColor: '#0088ff', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <Upload size={14} /> EXPORTAR A JARVIS
                </button>
                <button type="button" onClick={handleDownloadJson} disabled={!result || trades.length === 0}
                  style={{ flex: 1, padding: '10px', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', fontWeight: 700, cursor: (!result || trades.length === 0) ? 'not-allowed' : 'pointer', opacity: (!result || trades.length === 0) ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <Download size={14} /> DESCARGAR JSON
                </button>
                {uploadedFiles.length > 0 && !isRunning && (
                  <button type="button" onClick={() => { setUploadedFiles([]); setTrades([]); setResult(null); setProgress(0); }}
                    style={{ padding: '10px 14px', backgroundColor: 'transparent', color: 'var(--text-tertiary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer' }}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', textAlign: 'center', padding: '0 10px' }}>
                Guarda esta configuración (SL, TP, Gatillos) en Firebase para que el Bot de Telegram la use en vivo.
              </div>
            </div>

            {isRunning && (
              <div style={{ marginTop: '10px' }}>
                <div style={{ height: '4px', backgroundColor: 'var(--border-color)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progress}%`, backgroundColor: '#7c4dff', transition: 'width 0.3s ease', borderRadius: '2px' }} />
                </div>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '4px', textAlign: 'center' }}>
                  {progress}% — {trades.length} trades detectados
                </div>
              </div>
            )}
          </div>

          {/* SESSIONS & TRIGGERS CONFIGURATION */}
          <div className="panel" style={{ background: 'linear-gradient(180deg, var(--bg-surface) 0%, rgba(20,20,25,0.95) 100%)', border: '1px solid var(--border-color)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: '-10%', right: '-10%', width: '120px', height: '120px', background: 'radial-gradient(circle, rgba(124,77,255,0.15) 0%, rgba(0,0,0,0) 70%)', pointerEvents: 'none' }} />
            
            <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.9rem', letterSpacing: '0.5px' }}>
              <Zap size={18} color="var(--accent-gold)" /> GATILLOS Y FILTROS POR SESIÓN
            </h3>

            <div style={{ display: 'flex', gap: '4px', padding: '2px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '6px', marginBottom: '12px' }}>
              {(['GLOBAL', 'OFF', 'LONDON', 'NY', 'ASIA'] as const).map(s => {
                const isActive = sessionFilter === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleSessionSelect(s)}
                    style={{
                      flex: 1,
                      padding: '6px 4px',
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      borderRadius: '4px',
                      border: 'none',
                      backgroundColor: isActive ? 'var(--accent-gold)' : 'transparent',
                      color: isActive ? 'black' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease-in-out'
                    }}
                  >
                    {s === 'GLOBAL' ? 'GLOBAL' : s}
                  </button>
                );
              })}
            </div>

            {sessionFilter === 'GLOBAL' ? (
              <div style={{ padding: '20px', textAlign: 'center', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '6px', border: '1px solid var(--border-color)', color: 'var(--text-tertiary)' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Vista Global</span>
                <p style={{ fontSize: '0.7rem', marginTop: '6px' }}>Selecciona una sesión individual para editar sus gatillos y filtros.</p>
                <button 
                  onClick={() => handleRun(undefined, undefined, false)}
                  disabled={isRunning || uploadedFiles.length === 0}
                  style={{
                    marginTop: '15px',
                    padding: '8px 16px',
                    backgroundColor: 'var(--accent-gold)',
                    color: '#000',
                    border: 'none',
                    borderRadius: '4px',
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    cursor: (isRunning || uploadedFiles.length === 0) ? 'not-allowed' : 'pointer',
                    opacity: (isRunning || uploadedFiles.length === 0) ? 0.7 : 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <Play size={14} /> 
                  {isRunning ? 'SIMULANDO...' : 'SIMULAR CON NUEVA CONFIGURACIÓN'}
                </button>
              </div>
            ) : (
            <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              
              <TriggerSettingsPanel
                sessionKey={sessionFilter} triggerKey="choch15m" title="💥 CHOCH (Ruptura) (15m)"
                config={sessionTriggers[sessionFilter]?.choch15m} updateTrigger={updateSessionTrigger}
                onSimulate={() => handleRun(undefined, undefined, false)} isRunning={isRunning} isOte={false}
                tradeFilter={tradeFilter} setTradeFilter={setTradeFilter} filterKey="CHOCH_15M" onOptimize={() => handleOptimizeTrigger(sessionFilter, "choch15m")} isOptimizing={optimizingTrigger === `${sessionFilter}-choch15m`}
              />
              <TriggerSettingsPanel
                sessionKey={sessionFilter} triggerKey="bos15m" title="🚀 BOS (Continuación) (15m)"
                config={sessionTriggers[sessionFilter]?.bos15m} updateTrigger={updateSessionTrigger}
                onSimulate={() => handleRun(undefined, undefined, false)} isRunning={isRunning} isOte={false}
                tradeFilter={tradeFilter} setTradeFilter={setTradeFilter} filterKey="BOS_15M" onOptimize={() => handleOptimizeTrigger(sessionFilter, "bos15m")} isOptimizing={optimizingTrigger === `${sessionFilter}-bos15m`}
              />
              <TriggerSettingsPanel
                sessionKey={sessionFilter} triggerKey="oteChoch15m" title="📉 OTE CHOCH (15m)"
                config={sessionTriggers[sessionFilter]?.oteChoch15m} updateTrigger={updateSessionTrigger}
                onSimulate={() => handleRun(undefined, undefined, false)} isRunning={isRunning} isOte={true}
                tradeFilter={tradeFilter} setTradeFilter={setTradeFilter} filterKey="OTE_CHOCH_15M" onOptimize={() => handleOptimizeTrigger(sessionFilter, "oteChoch15m")} isOptimizing={optimizingTrigger === `${sessionFilter}-oteChoch15m`}
              />
              <TriggerSettingsPanel
                sessionKey={sessionFilter} triggerKey="oteBos15m" title="📈 OTE BOS (15m)"
                config={sessionTriggers[sessionFilter]?.oteBos15m} updateTrigger={updateSessionTrigger}
                onSimulate={() => handleRun(undefined, undefined, false)} isRunning={isRunning} isOte={true}
                tradeFilter={tradeFilter} setTradeFilter={setTradeFilter} filterKey="OTE_BOS_15M" onOptimize={() => handleOptimizeTrigger(sessionFilter, "oteBos15m")} isOptimizing={optimizingTrigger === `${sessionFilter}-oteBos15m`}
              />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '12px', backgroundColor: 'rgba(255,165,0,0.03)', borderRadius: '6px', border: '1px solid rgba(255,165,0,0.08)' }}>
                <div>
                  <label style={{ fontSize: '0.6rem', color: 'var(--accent-red)', whiteSpace: 'nowrap', fontWeight: 600, display: 'block', marginBottom: '4px' }}>MAX LOSS SELLs ({sessionFilter})</label>
                  <input type="number" min="0" value={sessionTriggers[sessionFilter]?.maxSellLosses ?? 0} onChange={e => updateSessionTrigger(sessionFilter, 'maxSellLosses', '', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} placeholder="Ilimitado (0)" />
                </div>
                <div>
                  <label style={{ fontSize: '0.6rem', color: 'var(--accent-green)', whiteSpace: 'nowrap', fontWeight: 600, display: 'block', marginBottom: '4px' }}>MAX LOSS BUYs ({sessionFilter})</label>
                  <input type="number" min="0" value={sessionTriggers[sessionFilter]?.maxBuyLosses ?? 0} onChange={e => updateSessionTrigger(sessionFilter, 'maxBuyLosses', '', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} placeholder="Ilimitado (0)" />
                </div>
              </div>

            </div>
            
            <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginTop: '12px', lineHeight: '1.4' }}>
              💡 Configura qué gatillos están activos y su puntaje mínimo para la sesión <strong>{sessionFilter}</strong>.
            </div>
            </>
            )}
          </div>

        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* TRADES TABLE */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <TrendingUp size={18} color="var(--accent-gold)" /> TRADES DETECTADOS {isRunning && <span className="live-dot"></span>}
              </span>
              {trades.length > 0 && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', fontWeight: 400 }}>
                  {tripleFilteredTrades.length}{tradeFilter !== 'ALL' ? `/${trades.length}` : ''} total
                </span>
              )}
            </h3>


            <div style={{ flex: 1, overflowY: 'auto', minHeight: '200px' }}>
              {trades.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>
                  {isRunning ? 'Procesando logs...' : 'Subí logs y hacé click en REPRODUCIR'}
                </div>
              ) : (
                <table className="data-table" style={{ width: 'max-content', borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', position: 'sticky', top: 0, zIndex: 1 }}>
                      <th style={{ padding: '6px 16px 6px 10px', textAlign: 'left', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>FECHA</th>
                      <th style={{ padding: '6px 16px 6px 10px', textAlign: 'center', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>DIR</th>
                      <th style={{ padding: '6px 16px 6px 10px', textAlign: 'left', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>SETUP</th>
                      <th style={{ padding: '6px 16px 6px 10px', textAlign: 'center', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>RESULTADO</th>
                      <th style={{ padding: '6px 16px 6px 10px', textAlign: 'right', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>PNL (USD)</th>
                      <th style={{ padding: '6px 16px 6px 10px', textAlign: 'right', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>R (TOTAL)</th>
                      <th style={{ padding: '6px 10px', textAlign: 'right', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>DUR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tripleFilteredTrades.map(t => (
                      <tr key={t.id} style={{ cursor: 'pointer', borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }} onClick={() => setShowLog(!showLog)}>
                        <td className="mono" style={{ padding: '6px 16px 6px 10px', fontSize: '0.65rem' }}>{new Date(t.timestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                        <td style={{ padding: '6px 16px 6px 10px', color: t.direction === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 700, fontSize: '0.7rem', textAlign: 'center' }}>{t.direction}</td>
                        <td style={{ padding: '6px 16px 6px 10px', fontWeight: 700, color: t.grade?.startsWith('A') ? 'var(--accent-gold)' : t.grade?.startsWith('B') ? '#0088ff' : 'var(--text-secondary)', fontSize: '0.7rem' }}>
                          {t.grade || '-'} <span style={{ color: t.points >= 8 ? 'var(--accent-gold)' : 'var(--text-secondary)', fontSize: '0.6rem', fontWeight: 'normal' }}>({t.points} pts)</span>
                        </td>
                        <td style={{ padding: '6px 16px 6px 10px', color: resultColor(t.result), fontWeight: 700, fontSize: '0.7rem', textAlign: 'center' }}>{t.result || 'OPEN'}</td>
                        <td className="mono" style={{ padding: '6px 16px 6px 10px', color: (t.rMultiple || 0) > 0 ? 'var(--accent-green)' : (t.rMultiple || 0) < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)', fontSize: '0.7rem', fontWeight: 700, textAlign: 'right' }}>
                          {t.rMultiple !== undefined ? `${(t.rMultiple * riskUsd) >= 0 ? '+$' : '-$'}${Math.abs(t.rMultiple * riskUsd).toFixed(2)}` : '—'}
                        </td>
                        <td className="mono" style={{ padding: '6px 16px 6px 10px', color: (t.rMultiple || 0) > 0 ? 'var(--accent-green)' : (t.rMultiple || 0) < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)', fontSize: '0.7rem', fontWeight: 700, textAlign: 'right' }}>
                          {t.rMultiple !== undefined ? `${t.rMultiple > 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R` : '—'}
                        </td>
                        <td className="mono" style={{ padding: '6px 10px', fontSize: '0.65rem', color: 'var(--text-tertiary)', textAlign: 'right' }}>
                          {t.durationMin ? `${t.durationMin}m` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* SESSION HISTORY */}
          <div className="panel">
            <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <BookOpen size={18} color="var(--accent-gold)" /> HISTORIAL DE SESIONES (RÁPIDAS)
            </h3>
            {sessions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                Sin sesiones previas guardadas.
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '10px' }}>
                {sessions.map(s => {
                  const pnlNum = parseFloat(s.pnl);
                  return (
                  <div key={s.id}
                    style={{ minWidth: '220px', padding: '14px', cursor: 'pointer', backgroundColor: selectedSession === s.id ? 'rgba(255,170,0,0.1)' : 'var(--bg-base)', border: `1px solid ${selectedSession === s.id ? 'var(--accent-gold)' : 'var(--border-color)'}`, borderRadius: '6px', flexShrink: 0, position: 'relative' }}>
                    <div onClick={() => {
                      if (selectedSession === s.id) { setSelectedSession(null); }
                      else { 
                        setSelectedSession(s.id); 
                        if (s.tradeData) setTrades(s.tradeData); 
                         if (s.config) {
                          setMinBuyPoints(s.config.minBuyPoints);
                          setMinSellPoints(s.config.minSellPoints);
                          setSlBufferPercent(s.config.slBufferPercent);
                          setFixedRR(s.config.fixedRR);
                          setOteEntryPercent(s.config.oteEntryPercent);
                          setEntryTrigger(s.config.entryTrigger);
                          setPartialClosePct(s.config.partialClosePct ?? 0.5);
                          setSlAfterTp1(s.config.slAfterTp1 ?? 'midpoint');
                          setTp15BeEnabled(s.config.tp15BeEnabled ?? true);
                          setAtrTrailEnabled(s.config.atrTrailEnabled ?? true);
                          setStructuralTrailEnabled(s.config.structuralTrailEnabled ?? true);
                          setTp1StructuralMinRR(s.config.tp1StructuralMinRR ?? 1.2);
                          setEnabled(s.config.enabled !== false);
                          // @ts-ignore
                          if (s.config.sessions) {
                            // @ts-ignore
                            setSessionTriggers(s.config.sessions);
                          }

                          if (uploadedFiles.length > 0) {
                            const logs = new Map<string, string[]>();
                            uploadedFiles.forEach(f => logs.set(f.tf, f.lines));
                            
                            // @ts-ignore
                            const finalSessions = s.config.sessions || sessionTriggers;
                          }
                        }
                      }
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontWeight: 800, fontSize: '0.9rem', color: 'var(--text-primary)' }}>{s.ticker}</span>
                        <span style={{ fontSize: '0.65rem', padding: '2px 6px', borderRadius: '4px', backgroundColor: pnlNum >= 0 ? 'rgba(32,191,107,0.1)' : 'rgba(255,51,51,0.1)', color: pnlNum >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 700 }}>
                          {pnlNum > 0 ? '+' : ''}{pnlNum.toFixed(2)}R
                        </span>
                      </div>
                      
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginBottom: '8px' }}>{s.date}</div>
                      
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--border-color)' }}>
                        <span><span style={{ color: 'var(--text-tertiary)' }}>WR:</span> <span style={{ color: 'var(--accent-gold)', fontWeight: 600 }}>{s.winRate}%</span></span>
                        <span><span style={{ color: 'var(--text-tertiary)' }}>Trades:</span> <span style={{ fontWeight: 600 }}>{s.trades}</span></span>
                      </div>
                      
                      {s.config && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '0.65rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>⚙️ Trigger: <span style={{ color: '#0088ff', fontWeight: 600 }}>{s.config.entryTrigger}</span></span>
                          <span style={{ color: 'var(--text-secondary)' }}>🎯 RR: <span style={{ fontWeight: 600 }}>{s.config.fixedRR}x</span></span>
                          <span style={{ color: 'var(--text-secondary)' }}>🛡️ SL: <span style={{ fontWeight: 600 }}>{s.config.slBufferPercent}</span></span>
                          <span style={{ color: 'var(--text-secondary)' }}>📉 OTE: <span style={{ fontWeight: 600 }}>{s.config.oteEntryPercent}%</span></span>
                        </div>
                      )}
                    </div>
                    <button type="button" onClick={(e) => {
                      e.stopPropagation();
                      setSessions(prev => {
                        const next = prev.filter(x => x.id !== s.id);
                        localStorage.setItem('bt_sessions', JSON.stringify(next));
                        return next;
                      });
                      if (selectedSession === s.id) { setSelectedSession(null); setTrades([]); }
                      toast('Sesión eliminada', 'success');
                    }} style={{ position: 'absolute', top: '8px', right: '8px', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.8rem', padding: '2px', borderRadius: '4px' }}
                    title="Eliminar sesión">✕</button>
                  </div>
                )})}
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
      ) : (
        /* ================= PEPE: PORTAFOLIO GLOBAL TAB ================= */
        <div className="animate-fadeIn" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px', marginBottom: '24px' }}>
          
          {/* COLUMNA IZQUIERDA: CONTROLES Y CONFIGS */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            {/* CARGADOR MULTI-ACTIVO */}
            <div className="panel" style={{
              background: 'rgba(30, 30, 40, 0.65)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.95rem', fontWeight: 700 }}>
                <Upload size={18} color="var(--accent-gold)" /> IMPORTAR BACKTESTS (.JSON)
              </h3>
              <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginBottom: '16px', lineHeight: '1.4' }}>
                Subí múltiples archivos JSON de backtests individuales limpios (sin killswitches internos) para evaluar el comportamiento unificado de tu cuenta.
              </p>

              <div style={{
                border: '2px dashed rgba(255, 255, 255, 0.15)',
                borderRadius: '8px',
                padding: '24px 16px',
                textAlign: 'center',
                cursor: 'pointer',
                background: 'rgba(255, 255, 255, 0.02)',
                transition: 'all 0.2s ease',
                position: 'relative'
              }}
              onClick={() => {
                const input = document.getElementById('portfolio-file-upload');
                if (input) input.click();
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent-gold)'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)'}
              >
                <input
                  id="portfolio-file-upload"
                  type="file"
                  multiple
                  accept=".json"
                  onChange={handlePortfolioUpload}
                  style={{ display: 'none' }}
                />
                <Upload size={28} color="var(--text-secondary)" style={{ margin: '0 auto 8px auto', display: 'block' }} />
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-primary)', display: 'block' }}>
                  Seleccionar archivos JSON
                </span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginTop: '4px' }}>
                  Soporta selección múltiple (EURUSD, GBPUSD, etc.)
                </span>
              </div>

              {/* LISTA DE ACTIVOS CARGADOS */}
              {portfolioFiles.length > 0 && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-secondary)' }}>ACTIVOS ACTIVOS EN PORTAFOLIO:</span>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '6px' }}>
                    {portfolioFiles.map((file, idx) => (
                      <div key={idx} style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 12px',
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: '6px'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: file.ticker === 'BTCUSD' ? '#f7931a' : file.ticker === 'US100' ? '#00c49f' : '#0088ff'
                          }}></span>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#fff' }}>{file.ticker}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{file.trades.length} trades</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPortfolioFiles(prev => {
                                const next = prev.filter(f => f.ticker !== file.ticker);
                                setTimeout(() => {
                                  const res = runPortfolioSimulation(next, {
                                    mdl: globalMDL,
                                    dpt: globalDPT,
                                    mcl: globalMCL,
                                    mtd: globalMTD,
                                    tdd: globalTDD,
                                    disabledSessions: globalDisabledSessions
                                  });
                                  setPortfolioResults(res);
                                }, 50);
                                return next;
                              });
                            }}
                            style={{ background: 'none', border: 'none', color: 'var(--accent-red)', cursor: 'pointer', fontSize: '0.75rem' }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* PARÁMETROS DEL KILLSWITCH GLOBAL */}
            <div className="panel" style={{
              background: 'rgba(30, 30, 40, 0.65)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.95rem', fontWeight: 700 }}>
                <ShieldAlert size={18} color="var(--accent-red)" /> RIESGO CONSOLIDADO (CUENTA)
              </h3>

              {/* SLIDER MDL */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Max Daily Loss (MDL)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-red)' }}>{globalMDL > 0 ? `-${globalMDL.toFixed(1)}R` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={globalMDL}
                  onChange={(e) => handleGlobalParamChange('mdl', parseFloat(e.target.value))}
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Bloquea la cuenta al perder este monto R diario.</span>
              </div>

              {/* SLIDER DPT */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Daily Profit Target (DPT)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-green)' }}>{globalDPT > 0 ? `+${globalDPT.toFixed(1)}R` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="15"
                  step="0.5"
                  value={globalDPT}
                  onChange={(e) => handleGlobalParamChange('dpt', parseFloat(e.target.value))}
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Asegura ganancias cerrando la sesión al alcanzar esta meta R.</span>
              </div>

              {/* SLIDER MTD */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Max Trades / Día (MTD)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-gold)' }}>{globalMTD > 0 ? `${globalMTD} trades` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="1"
                  value={globalMTD}
                  onChange={(e) => handleGlobalParamChange('mtd', parseInt(e.target.value))}
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Número máximo de operaciones consolidadas permitidas por día.</span>
              </div>

              {/* SLIDER MCL */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Max Consec. Losses (MCL)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-red)' }}>{globalMCL > 0 ? `${globalMCL} racha` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="8"
                  step="1"
                  value={globalMCL}
                  onChange={(e) => handleGlobalParamChange('mcl', parseInt(e.target.value))}
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Racha de pérdidas seguidas permitidas globalmente en el día.</span>
              </div>

              {/* SLIDER TDD */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Trailing Drawdown (TDD)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#f7931a' }}>{globalTDD > 0 ? `${globalTDD.toFixed(1)}R` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="8"
                  step="0.5"
                  value={globalTDD}
                  onChange={(e) => handleGlobalParamChange('tdd', parseFloat(e.target.value))}
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Pérdida máxima admitida desde el punto más alto del PnL consolidado del día.</span>
              </div>

              {/* SESIONES DESHABILITADAS GLOBALES */}
              <div style={{ marginBottom: '20px' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>
                  Sesiones Apagadas (Killswitch Global de Sesión)
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {['ASIA', 'LONDON', 'NY', 'OFF'].map(s => {
                    const isOff = globalDisabledSessions.includes(s);
                    return (
                      <button
                        key={s}
                        onClick={() => {
                          const newVal = isOff ? globalDisabledSessions.filter(x => x !== s) : [...globalDisabledSessions, s];
                          setGlobalDisabledSessions(newVal);
                          handleGlobalParamChange('disabledSessions', newVal);
                        }}
                        style={{
                          flex: 1, padding: '6px', borderRadius: '4px', border: '1px solid',
                          borderColor: isOff ? 'var(--accent-red)' : 'var(--border-color)',
                          backgroundColor: isOff ? 'rgba(255, 51, 51, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                          color: isOff ? 'var(--accent-red)' : 'var(--text-secondary)',
                          fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s'
                        }}
                      >
                        {isOff ? `🚫 ${s} OFF` : `✅ ${s}`}
                      </button>
                    );
                  })}
                </div>
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginTop: '4px', display: 'block' }}>
                  Ignora por completo las operaciones que ocurran en estas sesiones para todos los activos.
                </span>
              </div>

              {/* BOTONES ACCION GLOBAL */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <button
                  type="button"
                  onClick={handlePushGlobalToBot}
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '6px',
                    border: 'none',
                    background: 'linear-gradient(135deg, #0088ff, #7c4dff)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    transition: 'opacity 0.2s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                  onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                >
                  <Wand2 size={14} /> PERSISTIR GLOBAL EN JARVIS LIVE
                </button>
              </div>
            </div>

            {/* GRID SEARCH POR METODO */}
            <div className="panel" style={{
              background: 'rgba(30, 30, 40, 0.65)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              <h3 style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.9rem', fontWeight: 700 }}>
                <Wand2 size={16} color="var(--accent-gold)" /> GRID SEARCH OPTIMIZER
              </h3>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: '14px', lineHeight: '1.4' }}>
                Calcula automáticamente las combinaciones ideales de MDL, DPT y MTD que maximizan el rendimiento global consolidado.
              </p>

              <button
                type="button"
                onClick={optimizePortfolioKillswitches}
                disabled={portfolioFiles.length === 0 || isOptimizingPortfolio}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  background: portfolioFiles.length === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 170, 0, 0.1)',
                  color: portfolioFiles.length === 0 ? 'var(--text-tertiary)' : 'var(--accent-gold)',
                  fontWeight: 700,
                  fontSize: '0.7rem',
                  cursor: portfolioFiles.length === 0 ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px'
                }}
              >
                {isOptimizingPortfolio ? 'Calculando combinaciones...' : 'Correr Optimización en Malla'}
              </button>

              {portfolioOptResults.length > 0 && (
                <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-secondary)' }}>TOP 5 COMBINACIONES ÓPTIMAS:</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {portfolioOptResults.map((opt, index) => (
                      <div
                        key={index}
                        onClick={() => {
                          setGlobalMDL(opt.config.mdl);
                          setGlobalDPT(opt.config.dpt);
                          setGlobalMTD(opt.config.mtd);
                          setGlobalDisabledSessions(opt.config.disabledSessions);
                          const res = runPortfolioSimulation(portfolioFiles, {
                            mdl: opt.config.mdl,
                            dpt: opt.config.dpt,
                            mcl: globalMCL,
                            mtd: opt.config.mtd,
                            tdd: globalTDD,
                            disabledSessions: opt.config.disabledSessions
                          });
                          setPortfolioResults(res);
                          toast(`Aplicada configuración Top ${index + 1}`, 'success');
                        }}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 10px',
                          background: 'rgba(255, 255, 255, 0.03)',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.borderColor = 'rgba(255, 170, 0, 0.3)'}
                        onMouseLeave={(e) => e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)'}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#fff' }}>
                            MDL: <span style={{ color: 'var(--accent-red)' }}>{opt.config.mdl}</span> | DPT: <span style={{ color: 'var(--accent-green)' }}>{opt.config.dpt}</span> | MTD: <span style={{ color: 'var(--accent-gold)' }}>{opt.config.mtd}</span>
                            {opt.config.disabledSessions && opt.config.disabledSessions.length > 0 && (
                              <span style={{ color: 'var(--accent-red)', marginLeft: '6px' }}>
                                (🚫 {opt.config.disabledSessions.join(', ')})
                              </span>
                            )}
                          </span>
                          <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>
                            Trades: {opt.active} ({opt.blocked} bloq) · WR: {opt.wr}% · MDD: <span style={{ color: opt.mdd > 7 ? 'var(--accent-red)' : 'var(--accent-gold)' }}>{opt.mdd.toFixed(1)}R</span> · Peor día: <span style={{ color: opt.worstDay < -4 ? 'var(--accent-red)' : 'var(--accent-gold)' }}>{opt.worstDay?.toFixed(1) || '0'}R</span>
                          </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--accent-green)' }}>
                            +{opt.pnlR.toFixed(1)}R
                          </span>
                          <span style={{ fontSize: '0.5rem', color: 'var(--text-tertiary)' }}>
                            Calmar: {opt.calmar?.toFixed(2) || '-'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* COLUMNA DERECHA: DASHBOARD, GRÁFICO Y DETALLES */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            {/* ESTADÍSTICAS DEL PORTAFOLIO */}
            <div className="panel" style={{
              background: 'rgba(30, 30, 40, 0.65)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.95rem', fontWeight: 700 }}>
                <BarChart2 size={18} color="var(--accent-gold)" /> DASHBOARD DE PORTAFOLIO CONSOLIDADO
              </h3>

              {!portfolioResults ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>
                  Subí los archivos de backtesting de tus activos para simular la cuenta.
                </div>
              ) : (
                <div>
                  <AdvancedDashboardMetrics metrics={portfolioExtendedMetrics} />

                  {/* INFO DE TRADES COMPONENTES */}
                  <div style={{ display: 'flex', gap: '16px', fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '20px', padding: '8px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
                    <span>✅ Operados: <strong>{portfolioResults.metrics.activeTradesCount}</strong></span>
                    <span>📈 Ganados: <strong>{portfolioResults.metrics.wins}</strong></span>
                    <span>📉 Perdidos: <strong>{portfolioResults.metrics.losses}</strong></span>
                    <span>🤝 Breakevens: <strong>{portfolioResults.metrics.be}</strong></span>
                    <span>📉 Max Drawdown: <strong style={{ color: 'var(--accent-red)' }}>{portfolioResults.metrics.maxDDR}R</strong></span>
                  </div>

                  {/* CURVA DE EQUIDAD PORTAFOLIO */}
                  <div style={{ height: '240px', width: '100%', marginBottom: '10px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={portfolioResults.equityData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="name" stroke="var(--text-tertiary)" style={{ fontSize: '0.6rem' }} />
                        <YAxis stroke="var(--text-tertiary)" style={{ fontSize: '0.6rem' }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', fontSize: '0.7rem', borderRadius: '6px' }}
                          labelStyle={{ fontWeight: 'bold' }}
                        />
                        <Line
                          type="monotone"
                          dataKey="PnL"
                          stroke="url(#portfolioEquityGrad)"
                          strokeWidth={2.5}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                        <defs>
                          <linearGradient id="portfolioEquityGrad" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#00c49f" />
                            <stop offset="50%" stopColor="var(--accent-gold)" />
                            <stop offset="100%" stopColor="#0088ff" />
                          </linearGradient>
                        </defs>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>

            {/* DETALLE CRONOLÓGICO DE TRADES MULTI-ACTIVO */}
            {portfolioResults && portfolioResults.trades.length > 0 && (
              <div className="panel" style={{
                background: 'rgba(30, 30, 40, 0.65)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '12px',
                padding: '20px'
              }}>
                <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.95rem', fontWeight: 700 }}>
                  <BookOpen size={18} color="var(--accent-gold)" /> HISTORIAL UNIFICADO Y FILTRADO CONSOLIDADO
                </h3>

                <div style={{ maxHeight: '350px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }}>
                  {portfolioResults.trades.slice().reverse().map((t, idx) => {
                    const isBlocked = t.blockedByGlobalKillswitch;
                    const r = Number(t.rMultiple) || 0;
                    const date = new Date(t.timestamp);
                    const formattedDate = date.toLocaleString('es-AR', {
                      timeZone: 'America/Argentina/Buenos_Aires',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    });

                    return (
                      <div key={idx} style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 14px',
                        background: isBlocked ? 'rgba(255, 51, 51, 0.02)' : 'rgba(255, 255, 255, 0.02)',
                        border: isBlocked ? '1px dashed rgba(255, 51, 51, 0.2)' : '1px solid rgba(255, 255, 255, 0.05)',
                        borderRadius: '8px',
                        opacity: isBlocked ? 0.40 : 1,
                        transition: 'opacity 0.2s ease'
                      }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{
                              fontSize: '0.75rem',
                              fontWeight: 800,
                              color: t.ticker === 'BTCUSD' ? '#f7931a' : t.ticker === 'US100' ? '#00c49f' : '#0088ff'
                            }}>{t.ticker}</span>
                            <span style={{
                              fontSize: '0.6rem',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              background: t.direction === 'BUY' ? 'rgba(32,191,107,0.1)' : 'rgba(255,51,51,0.1)',
                              color: t.direction === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)',
                              fontWeight: 700
                            }}>{t.direction}</span>
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{formattedDate} ART</span>
                          </div>
                          
                          {isBlocked ? (
                            <span style={{ fontSize: '0.6rem', color: 'var(--accent-red)', fontWeight: 600 }}>
                              🚫 BLOQUEADO: {t.blockReason}
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>
                              FIB: {t.fibLevel || 'OTE'} | SL: {t.slBufferPercent || '1.0'} | R:R: {t.fixedRR || '2.0'}x
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                          <span style={{
                            fontSize: '0.8rem',
                            fontWeight: 800,
                            color: isBlocked ? 'var(--text-tertiary)' : (r > 0 ? 'var(--accent-green)' : (r < 0 ? 'var(--accent-red)' : 'var(--text-secondary)'))
                          }}>
                            {isBlocked ? '0.00R' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`}
                          </span>
                          {!isBlocked && (
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>
                              Equidad: {t.cumulativePnLR.toFixed(2)}R
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
