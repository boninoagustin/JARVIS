import { useEffect, useMemo, useState } from 'react';
import { useToast } from './Toast';
import { collection, query, orderBy, limit, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import {
  PieChart as PieChartIcon,
  TrendingUp,
  Crosshair,
  Target,
  Award,
  Download,
  ShieldCheck,
  Filter,
  Table2,
  LayoutGrid,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, AreaChart, Area, CartesianGrid
} from 'recharts';

import { getSessionForTimestamp } from '../services/backtestEngine';
import { TICKERS } from './admin/types';

interface TradeLog {
  id: string;
  ticker: string;
  direction: string;
  grade: string;
  points?: number;
  result?: string;
  timestamp: number;
  entryPrice?: number;
  tp1Price?: number;
  tp2Price?: number;
  slPrice?: number;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  slHit?: boolean;
  tp1Timestamp?: number;
  tp2Timestamp?: number;
  slTimestamp?: number;
  // 🆕 toma parcial de TP1 (ago-2026): datos reales del deal de cierre parcial
  tp1PartialPct?: number;
  tp1PartialPrice?: number;
  tp1PartialPnlUsd?: number;
  tp1PartialAt?: number;
  events?: string[];
  isChochEntry?: boolean;
  rMultiple?: number;
  tf?: string;
  ctraderStatus?: string;
  ctrader_real_pnl?: number;
  // 🆕 gatillo real de la entrada (escrito por el backend desde ago-2026)
  triggerKey?: string;
  triggerFam?: string;
  entryType?: string;
}

const COLORS = ['#00ff00', '#ff3333', '#888888'];
const MAX_LOADED = 500; // sin where() server-side → evitamos depender de índices compuestos

const getTradeRR = (t: TradeLog): number => {
  // 1. rMultiple del backend = PnL real en USD / riesgo real en USD (fuente de verdad).
  if (t.rMultiple !== undefined && t.rMultiple !== null) {
    return t.rMultiple;
  }
  // 2. Fallback: PnL real de cTrader en dólares → R (riesgo $50 legacy, solo si no hay rMultiple).
  if (t.ctrader_real_pnl !== undefined && t.ctrader_real_pnl !== null) {
    return Number((t.ctrader_real_pnl / 50).toFixed(2));
  }

  if (t.result === 'LOSS') {
    return t.rMultiple !== undefined && t.rMultiple !== null && t.rMultiple < 0 ? t.rMultiple : -1;
  }
  if (t.result === 'BREAKEVEN') {
    return t.rMultiple !== undefined && t.rMultiple !== null ? t.rMultiple : 0;
  }
  if (t.result === 'WIN') {
    // 1. Usar rMultiple explícito si existe (manual o auto-calculado)
    if (t.rMultiple !== undefined && t.rMultiple !== null && t.rMultiple > 0) {
      return t.rMultiple;
    }
    // 2. Calcular R:R desde precios reales de la alerta
    if (t.entryPrice && t.slPrice) {
      const risk = Math.abs(t.entryPrice - t.slPrice);
      if (risk > 0) {
        // Determinar qué TP se alcanzó realmente
        let targetPrice: number | undefined;
        if (t.tp2Hit && t.tp2Price) {
          targetPrice = t.tp2Price;
        } else if (t.tp1Hit && t.tp1Price) {
          targetPrice = t.tp1Price;
        } else if (t.tp1Price) {
          targetPrice = t.tp1Price; // Fallback a TP1 si no hay hit registrado
        } else if (t.tp2Price) {
          targetPrice = t.tp2Price;
        }

        if (targetPrice) {
          const reward = Math.abs(targetPrice - t.entryPrice);
          return Number((reward / risk).toFixed(2));
        }
      }
    }
    // 3. Sin datos de precio → asumir 1R conservador (no inflar con ficticio)
    return 1;
  }
  return 0;
};

/** Clasificación del gatillo REAL de la entrada.
 *  Preferencia: triggerKey del backend (choch5m, bos15m, oteChoch15m, ...).
 *  Fallback para docs viejos: el evento ejecutor con emoji (CHoCH🚀/BOS🔨) o el último estructural. */
const classifyTrigger = (t: TradeLog): string => {
  if (t.triggerKey) return t.triggerKey;
  const ev = (t.events || []).map(e => String(e));
  const entry = ev.find(e => e.includes('🚀') || e.includes('🔨'));
  const structural = entry ?? [...ev].reverse().find(e => /^(CHoCH|BOS)_/.test(e));
  const fam = structural?.includes('BOS') ? 'BOS' : structural?.includes('CHoCH') ? 'CHoCH' : null;
  const tf = (structural?.match(/_(\d+M|1H|4H|D|W)$/)?.[1]?.toLowerCase() ?? '').replace('m', 'm');
  const isOte = t.isChochEntry === false || ev.some(e => /OTE|Retracement/i.test(e));
  if (!fam) return isOte ? 'ote_unknown' : 'Otro';
  return `${isOte ? 'ote' + (fam === 'BOS' ? 'Bos' : 'Choch') : fam.toLowerCase()}${tf}`;
};

/** R sugerido para el modal de registro manual (mismo criterio que el backend). */
const getSuggestedR = (t: TradeLog): number => {
  if (t.rMultiple !== undefined && t.rMultiple !== null) return Math.abs(t.rMultiple);
  if (t.entryPrice && t.slPrice) {
    const risk = Math.abs(t.entryPrice - t.slPrice);
    if (risk > 0) {
      let targetPrice = t.tp1Price;
      if (t.tp2Hit && t.tp2Price) targetPrice = t.tp2Price;
      else if (t.tp1Price) targetPrice = t.tp1Price;
      else if (t.tp2Price) targetPrice = t.tp2Price;
      if (targetPrice) {
        const reward = Math.abs(targetPrice - t.entryPrice);
        return Number((reward / risk).toFixed(2));
      }
    }
  }
  return 1;
};

const sessionKey = (ts: number) => {
  const s = getSessionForTimestamp(ts);
  return s === 'OFF' ? 'OFF' : s;
};

export default function AnalyticsJournal() {
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [tickerFilter, setTickerFilter] = useState<string>('ALL');
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [showAllRows, setShowAllRows] = useState(false);
  const { toast } = useToast();

  // 🆕 Registro manual de resultado (heredado de la vieja bitácora del radar).
  const [selectedTrade, setSelectedTrade] = useState<TradeLog | null>(null);
  const [modalResult, setModalResult] = useState<'WIN' | 'LOSS' | 'BREAKEVEN' | 'SKIP' | ''>('');
  const [modalRMultiple, setModalRMultiple] = useState<string>('');
  // 🆕 ago-2026: precio de salida para calcular el R automáticamente
  const [modalExitPrice, setModalExitPrice] = useState<string>('');
  const [updating, setUpdating] = useState<string | null>(null);

  // 🆕 ago-2026: calcula R (y el resultado) desde el precio de salida real.
  // R = (salida − entrada)/riesgo (BUY) | (entrada − salida)/riesgo (SELL), riesgo = |entrada − SL|.
  const applyExitPrice = (exitStr: string) => {
    setModalExitPrice(exitStr);
    if (!selectedTrade) return;
    const exit = parseFloat(exitStr.replace(',', '.'));
    if (isNaN(exit)) return;
    const { entryPrice, slPrice, direction } = selectedTrade;
    if (!entryPrice || !slPrice) return; // sin niveles no se puede calcular → R manual
    const risk = Math.abs(entryPrice - slPrice);
    if (risk <= 0) return;
    const rawR = direction === 'BUY' ? (exit - entryPrice) / risk : (entryPrice - exit) / risk;
    const r = Math.round(rawR * 100) / 100;
    setModalRMultiple(String(Math.abs(r)));
    if (Math.abs(r) < 0.03) setModalResult('BREAKEVEN');
    else if (r > 0) setModalResult('WIN');
    else setModalResult('LOSS');
  };

  const handleSaveModalResult = async () => {
    if (!selectedTrade) return;

    let finalR: number | null = null;
    if (modalResult === 'WIN') {
      const parsed = parseFloat(modalRMultiple);
      if (isNaN(parsed) || parsed <= 0) {
        toast('Ingresá un múltiplo R válido mayor a 0', 'error');
        return;
      }
      finalR = parsed;
    } else if (modalResult === 'LOSS') {
      const parsed = parseFloat(modalRMultiple);
      if (isNaN(parsed) || parsed <= 0) {
        toast('Ingresá un múltiplo R de pérdida válido (mayor a 0)', 'error');
        return;
      }
      finalR = -parsed;
    } else if (modalResult === 'BREAKEVEN') {
      finalR = 0;
    }

    setUpdating(selectedTrade.id);
    try {
      const tradeRef = doc(db, 'trade_journal', selectedTrade.id);
      const updateData: any = { result: modalResult, rMultiple: finalR, manualResult: true, manualResultAt: Date.now() };
      await updateDoc(tradeRef, updateData);
      const labels: Record<string, string> = { WIN: 'WIN ✅', LOSS: 'LOSS ❌', BREAKEVEN: 'BE ➖', SKIP: 'No operado 🚫' };
      toast(`Trade #${selectedTrade.id} actualizado → ${labels[modalResult as string]} (${finalR !== null ? finalR + ' R' : 'N/A'})`, modalResult === 'WIN' ? 'success' : modalResult === 'LOSS' ? 'error' : 'info');
      setSelectedTrade(null);
    } catch (e) {
      console.error('Error updating trade result:', e);
      toast('Error al actualizar el resultado', 'error');
    } finally {
      setUpdating(null);
    }
  };

  useEffect(() => {
    const q = query(collection(db, 'trade_journal'), orderBy('timestamp', 'desc'), limit(MAX_LOADED));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      try {
        const data = snapshot.docs
          .map(d => ({ id: d.id, ...d.data() } as TradeLog))
          // 🛡️ ago-2026: incluir ABORTED (entradas abortadas por seguridad, result=SKIP) para que
          // aparezcan en TRADES DEL PERÍODO. Los ghost/duplicados (sin ctraderStatus) siguen fuera.
          .filter(t => t.ctraderStatus === 'EXECUTED' || t.ctraderStatus === 'ABORTED');
        setTrades(data);
      } catch (err) {
        console.error('Error processing trade journal snapshot:', err);
      }
    }, (err) => {
      console.error('Error listening to trade journal:', err);
    });

    return () => unsubscribe();
  }, []);

  // ─── Filtros (client-side: sin índices compuestos, sin costo de Firestore) ───
  const filtered = useMemo(() => {
    const from = rangeDays > 0 ? Date.now() - rangeDays * 24 * 3600 * 1000 : 0;
    return trades.filter(t =>
      (tickerFilter === 'ALL' || t.ticker === tickerFilter) && t.timestamp >= from
    );
  }, [trades, tickerFilter, rangeDays]);

  const getStats = () => {
    let wins = 0, losses = 0, breakevens = 0;
    filtered.forEach(t => {
      if (t.result === 'WIN') wins++;
      else if (t.result === 'LOSS') losses++;
      else if (t.result === 'BREAKEVEN') breakevens++;
    });
    return [
      { name: 'WINS', value: wins },
      { name: 'LOSSES', value: losses },
      { name: 'BREAKEVEN', value: breakevens }
    ];
  };

  const getGradeStats = () => {
    const grades: Record<string, number> = {};
    filtered.forEach(t => {
      if (t.result && t.result !== 'SKIP') {
        const g = t.grade || 'Sin setup';
        if (!grades[g]) grades[g] = 0;
        grades[g]++;
      }
    });
    return Object.keys(grades).map(k => ({ name: k, value: grades[k] }));
  };

  const getPointsStats = () => {
    const pts: Record<string, { wins: number, losses: number }> = {};
    filtered.forEach(t => {
      if (t.result && t.result !== 'SKIP' && t.points !== undefined) {
        const key = t.points.toString();
        if (!pts[key]) pts[key] = { wins: 0, losses: 0 };
        if (t.result === 'WIN') pts[key].wins++;
        else if (t.result === 'LOSS') pts[key].losses++;
      }
    });

    return Object.keys(pts).map(p => {
      const data = pts[p];
      const total = data.wins + data.losses;
      return {
        name: `${p} pts`,
        points: Number(p),
        winRate: total > 0 ? Number(((data.wins / total) * 100).toFixed(1)) : 0,
        total,
      };
    }).sort((a, b) => a.points - b.points);
  };

  const getEquityData = () => {
    const sortedTrades = [...filtered]
      .filter(t => t.result && t.result !== 'SKIP')
      .sort((a, b) => a.timestamp - b.timestamp);

    let currentR = 0;
    const data = [{ index: 0, balance: 0, date: 'Inicio' }];

    sortedTrades.forEach((t, i) => {
      currentR += getTradeRR(t);
      data.push({
        index: i + 1,
        balance: Number(currentR.toFixed(2)),
        date: new Date(t.timestamp).toLocaleDateString()
      });
    });

    return data;
  };

  const getAdvancedKPIs = () => {
    const closed = filtered.filter(t => t.result && t.result !== 'SKIP');

    let maxConsecutiveWins = 0;
    let currentConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let currentConsecutiveLosses = 0;

    let totalWins = 0;
    let totalLosses = 0;

    const chronological = [...closed].sort((a, b) => a.timestamp - b.timestamp);

    let grossProfit = 0;
    let grossLoss = 0;

    chronological.forEach(t => {
      const rr = getTradeRR(t);
      if (t.result === 'WIN') {
        totalWins++;
        grossProfit += rr;
        currentConsecutiveWins++;
        currentConsecutiveLosses = 0;
        if (currentConsecutiveWins > maxConsecutiveWins) {
          maxConsecutiveWins = currentConsecutiveWins;
        }
      } else if (t.result === 'LOSS') {
        totalLosses++;
        grossLoss += Math.abs(rr);
        currentConsecutiveLosses++;
        currentConsecutiveWins = 0;
        if (currentConsecutiveLosses > maxConsecutiveLosses) {
          maxConsecutiveLosses = currentConsecutiveLosses;
        }
      } else if (t.result === 'BREAKEVEN') {
        currentConsecutiveWins = 0;
        currentConsecutiveLosses = 0;
      }
    });

    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? '∞' : '0.00';

    const totalNetR = chronological.reduce((sum, t) => sum + getTradeRR(t), 0);
    const mathExpectancy = closed.length > 0 ? (totalNetR / closed.length).toFixed(2) : '0.00';

    return {
      profitFactor,
      maxConsecutiveWins,
      maxConsecutiveLosses,
      mathExpectancy: Number(mathExpectancy) >= 0 ? `+${mathExpectancy} R` : `${mathExpectancy} R`
    };
  };

  const exportToCSV = () => {
    if (filtered.length === 0) {
      toast('No hay registros en la bitácora para exportar.', 'error');
      return;
    }

    const headers = [
      'ID',
      'Fecha',
      'Activo (Ticker)',
      'Direccion',
      'Calidad Setup',
      'Puntos Confluencia',
      'Precio Entrada',
      'Stop Loss',
      'Take Profit 1',
      'Take Profit 2',
      'Resultado Real'
    ];

    const rows = filtered.map(t => [
      t.id,
      new Date(t.timestamp).toISOString(),
      t.ticker,
      t.direction,
      t.grade,
      t.points ?? 'N/A',
      t.entryPrice ?? 'N/A',
      t.slPrice ?? 'N/A',
      t.tp1Price ?? 'N/A',
      t.tp2Price ?? 'N/A',
      t.result ?? 'PENDIENTE'
    ]);

    const csvContent = "data:text/csv;charset=utf-8,\uFEFF"
      + [headers.join(','), ...rows.map(e => e.map(val => `"${val}"`).join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `jarvis_bitacora_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast('✅ Bitácora analítica exportada a CSV con éxito.', 'success');
  };

  const stats = getStats();
  const gradeStats = getGradeStats();
  const pointsStats = getPointsStats();
  const equityData = getEquityData();
  const kpis = getAdvancedKPIs();

  const getSessionStats = () => {
    const closed = filtered.filter(t => t.result && t.result !== 'SKIP');

    const sessions: Record<string, { gp: number, gl: number }> = {
      'LONDON': { gp: 0, gl: 0 },
      'NY': { gp: 0, gl: 0 },
      'ASIA': { gp: 0, gl: 0 },
      'OFF': { gp: 0, gl: 0 },
      'ALL': { gp: 0, gl: 0 }
    };

    closed.forEach(t => {
      const sKey = sessionKey(t.timestamp) === 'OFF' ? 'OFF' : sessionKey(t.timestamp);
      const rr = getTradeRR(t);
      if (t.result === 'WIN') {
        sessions[sKey].gp += rr;
      } else if (t.result === 'LOSS') {
        sessions[sKey].gl += Math.abs(rr);
      }
    });

    const getPF = (p: number, l: number) => {
      if (p === 0 && l === 0) return '-';
      return l > 0 ? (p / l).toFixed(2) : p > 0 ? '∞' : '0.00';
    };

    return {
      LONDON: getPF(sessions['LONDON'].gp, sessions['LONDON'].gl),
      NY: getPF(sessions['NY'].gp, sessions['NY'].gl),
      ASIA: getPF(sessions['ASIA'].gp, sessions['ASIA'].gl)
    };
  };

  const sessionKPIs = getSessionStats();

  const totalCompleted = stats.reduce((acc, curr) => acc + curr.value, 0);
  // 🛡️ FIX: win rate mide puntería real → excluye BREAKEVEN del denominador.
  // Antes: wins / (wins+losses+breakevens) bajaba el % de forma engañosa (los BE no son pérdidas).
  // Ahora: wins / (wins+losses). Los BE ya se muestran como categoría aparte en el panel.
  const decided = stats[0].value + stats[1].value; // WINS + LOSSES
  const winRate = decided > 0 ? ((stats[0].value / decided) * 100).toFixed(1) : '0.0';

  const totalR = filtered
    .filter(t => t.result && t.result !== 'SKIP')
    .reduce((s, t) => s + getTradeRR(t), 0);
  const currentDrawdown = equityData.length > 0 ? Math.max(...equityData.map(d => d.balance)) - equityData[equityData.length - 1].balance : 0;

  // ─── Resumen por activo (tabla nueva) ────────────────────────────────────────
  const tickerSummary = useMemo(() => {
    const list = tickerFilter === 'ALL' ? TICKERS : [tickerFilter as any];
    return list.map(tk => {
      const closed = filtered.filter(t => t.ticker === tk && t.result && t.result !== 'SKIP');
      const chrono = [...closed].sort((a, b) => a.timestamp - b.timestamp);
      let peak = 0, eq = 0, mdd = 0, gp = 0, gl = 0, wins = 0, losses = 0;
      chrono.forEach(t => {
        const rr = getTradeRR(t);
        eq += rr; if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq);
        if (t.result === 'WIN') { wins++; gp += rr; } else if (t.result === 'LOSS') { losses++; gl += Math.abs(rr); }
      });
      const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
      // 🛡️ FIX: win rate excluye BREAKEVEN (wins / (wins+losses)), consistente con el panel principal.
      const decided = wins + losses;
      const wr = decided > 0 ? wins / decided : 0;
      const netR = chrono.reduce((s, t) => s + getTradeRR(t), 0);
      const exp = closed.length > 0 ? netR / closed.length : 0;
      return { ticker: tk, n: closed.length, wr, pf, netR, mdd, exp };
    }).sort((a, b) => b.exp - a.exp);
  }, [filtered, tickerFilter]);

  // ─── Matriz sesión × gatillo (nueva) ────────────────────────────────────────
  const matrix = useMemo(() => {
    const sessions = ['LONDON', 'NY', 'ASIA', 'OFF'];
    const preferred = ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m', 'Otro', 'ote_unknown'];
    const used = new Set<string>();
    const cells: Record<string, Record<string, { n: number; decided: number; wins: number; netR: number }>> = {};
    for (const s of sessions) cells[s] = {};
    filtered.forEach(t => {
      if (!t.result || t.result === 'SKIP') return;
      const s = sessionKey(t.timestamp);
      const g = classifyTrigger(t);
      used.add(g);
      if (!cells[s]) return;
      if (!cells[s][g]) cells[s][g] = { n: 0, decided: 0, wins: 0, netR: 0 };
      const c = cells[s][g];
      c.n++;
      c.netR += getTradeRR(t);
      if (t.result === 'WIN') { c.wins++; c.decided++; }
      else if (t.result === 'LOSS') c.decided++;
    });
    // columnas dinámicas: solo gatillos presentes, en orden canónico
    const triggers = preferred.filter(g => used.has(g)).concat([...used].filter(g => !preferred.includes(g)));
    return { sessions, triggers, cells };
  }, [filtered]);

  const inputClass = {
    padding: '8px 12px', backgroundColor: '#111', border: '1px solid #333',
    borderRadius: '4px', color: '#e6e6e6', fontFamily: "'JetBrains Mono', monospace",
    fontSize: '0.8rem', outline: 'none', cursor: 'pointer',
  };

  return (
    <div className="animate-fadeIn">
      {/* HEADER */}
      <div className="panel-header" style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <PieChartIcon size={14} style={{ marginRight: 8 }} />
          <span>DIARIO ANALÍTICO & MONITOREO DE PERFORMANCE</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {/* 🆕 FILTROS */}
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            <Filter size={13} /> Filtros
          </span>
          <select value={tickerFilter} onChange={e => setTickerFilter(e.target.value)} style={inputClass}>
            <option value="ALL">Todos los activos</option>
            {TICKERS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={rangeDays} onChange={e => setRangeDays(Number(e.target.value))} style={inputClass}>
            <option value={7}>Últimos 7 días</option>
            <option value={30}>Últimos 30 días</option>
            <option value={90}>Últimos 90 días</option>
            <option value={0}>Todo el historial</option>
          </select>
          <button
            onClick={exportToCSV}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '6px 12px',
              backgroundColor: 'rgba(255,170,0,0.1)',
              border: '1px solid rgba(255,170,0,0.3)',
              borderRadius: '4px', color: 'var(--accent-gold)',
              fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer',
            }}
          >
            <Download size={14} /> EXPORTAR CSV
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Métricas Institucionales</span>
            <span className="live-dot" style={{ backgroundColor: 'var(--accent-gold)' }}></span>
          </div>
        </div>
      </div>

      {/* ─── FILA DE METRICAS PREMIUM (KPIs) ─── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '16px',
        marginBottom: '24px'
      }}>
        {/* WIN RATE */}
        <div className="panel" style={{ padding: '16px', marginBottom: 0, borderLeft: '3px solid var(--accent-gold)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>WIN RATE REAL</span>
              <Crosshair size={14} color="var(--accent-gold)" />
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '8px 0 4px 0', color: 'var(--text-primary)' }}>
              {winRate}%
            </div>
          </div>
          <div>
            <div style={{ width: '100%', height: '6px', backgroundColor: 'var(--bg-panel-hover)', borderRadius: '3px', marginTop: '6px', overflow: 'hidden' }}>
              <div style={{ width: `${winRate}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent-red) 0%, var(--accent-gold) 50%, var(--accent-green) 100%)', borderRadius: '3px', transition: 'width 0.5s ease-in-out' }} />
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: '6px' }}>
              {stats[0].value} ganados de {totalCompleted} trades
            </div>
          </div>
        </div>

        {/* RETORNO R TOTAL ACUMULADO */}
        <div className="panel" style={{ padding: '16px', marginBottom: 0, borderLeft: '3px solid var(--accent-green)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>RETORNO TOTAL ACUMULADO</span>
              <TrendingUp size={14} color="var(--accent-green)" />
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '8px 0 4px 0', color: totalR >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              {totalR >= 0 ? `+${totalR.toFixed(2)}` : totalR.toFixed(2)} R
            </div>
          </div>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
            Resultado neto exacto en múltiplos R
          </span>
        </div>

        {/* PROFIT FACTOR */}
        <div className="panel" style={{ padding: '16px', marginBottom: 0, borderLeft: '3px solid #0088ff', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>PROFIT FACTOR GLOBAL</span>
              <ShieldCheck size={14} color="#0088ff" />
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '8px 0 4px 0', color: '#0088ff' }}>
              {kpis.profitFactor}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', backgroundColor: 'rgba(0,0,0,0.15)', padding: '4px 6px', borderRadius: '4px' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-tertiary)' }}>LN: <span style={{ color: 'var(--accent-blue)', fontWeight: 800 }}>{sessionKPIs.LONDON}</span></span>
            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-tertiary)' }}>NY: <span style={{ color: 'var(--accent-gold)', fontWeight: 800 }}>{sessionKPIs.NY}</span></span>
            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-tertiary)' }}>AS: <span style={{ color: 'var(--accent-red)', fontWeight: 800 }}>{sessionKPIs.ASIA}</span></span>
          </div>
        </div>

        {/* EXPECTATIVA MATEMÁTICA */}
        <div className="panel" style={{ padding: '16px', marginBottom: 0, borderLeft: '3px solid #7c4dff', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>EXPECTATIVA</span>
              <Target size={14} color="#7c4dff" />
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '8px 0 4px 0', color: 'var(--text-primary)' }}>
              {kpis.mathExpectancy}
            </div>
          </div>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
            Esperanza matemática por trade
          </span>
        </div>

        {/* CONTROLES DE RACHA */}
        <div className="panel" style={{ padding: '16px', marginBottom: 0, borderLeft: '3px solid var(--status-neutral)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>RACHAS CONSEC.</span>
              <Award size={14} color="var(--text-secondary)" />
            </div>
            <div style={{ display: 'flex', gap: '12px', margin: '8px 0 4px 0', alignItems: 'baseline' }}>
              <span style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent-green)' }}>
                +{kpis.maxConsecutiveWins}
              </span>
              <span style={{ fontSize: '0.9rem', color: 'var(--text-tertiary)' }}>/</span>
              <span style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent-red)' }}>
                -{kpis.maxConsecutiveLosses}
              </span>
            </div>
          </div>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
            Racha ganadora vs perdedora
          </span>
        </div>
      </div>

      {/* 🆕 TABLA RESUMEN POR ACTIVO */}
      <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-gold)', margin: 0, marginBottom: '14px', fontSize: '0.9rem' }}>
          <Table2 size={16} /> RESUMEN POR ACTIVO {tickerFilter !== 'ALL' ? `— ${tickerFilter}` : ''}
        </h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ color: '#888', textAlign: 'left' }}>
              <th style={{ padding: '6px 8px' }}>ACTIVO</th>
              <th style={{ padding: '6px 8px' }}>TRADES</th>
              <th style={{ padding: '6px 8px' }}>WIN RATE</th>
              <th style={{ padding: '6px 8px' }}>PROFIT FACTOR</th>
              <th style={{ padding: '6px 8px' }}>R NETO</th>
              <th style={{ padding: '6px 8px' }}>MAX DD (R)</th>
              <th style={{ padding: '6px 8px' }}>EXPECTATIVA</th>
            </tr>
          </thead>
          <tbody>
            {tickerSummary.map(r => {
              const expColor = r.exp > 0.05 ? '#00e676' : r.exp < -0.05 ? '#ff3333' : '#ffaa00';
              return (
                <tr key={r.ticker} style={{ borderTop: '1px solid #1a1a1a', cursor: tickerFilter === 'ALL' ? 'pointer' : 'default' }}
                  onClick={() => tickerFilter === 'ALL' && setTickerFilter(r.ticker)}
                  title={tickerFilter === 'ALL' ? 'Click para filtrar este activo' : undefined}
                >
                  <td style={{ padding: '8px', fontWeight: 700, color: '#e6e6e6' }}>{r.ticker}</td>
                  <td style={{ padding: '8px', color: '#aaa' }}>{r.n}</td>
                  <td style={{ padding: '8px', color: r.wr >= 0.55 ? '#00e676' : r.wr >= 0.45 ? '#ffaa00' : '#ff3333', fontFamily: 'monospace' }}>
                    {r.n > 0 ? `${(r.wr * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td style={{ padding: '8px', fontFamily: 'monospace', color: r.pf >= 1.5 ? '#00e676' : r.pf >= 1 ? '#ffaa00' : '#ff3333' }}>
                    {r.pf === Infinity ? '∞' : r.pf.toFixed(2)}
                  </td>
                  <td style={{ padding: '8px', fontFamily: 'monospace', color: r.netR >= 0 ? '#00e676' : '#ff3333' }}>
                    {r.netR >= 0 ? '+' : ''}{r.netR.toFixed(1)}R
                  </td>
                  <td style={{ padding: '8px', fontFamily: 'monospace', color: '#ff9999' }}>{r.mdd.toFixed(1)}</td>
                  <td style={{ padding: '8px', fontFamily: 'monospace', fontWeight: 700, color: expColor }}>
                    {r.n > 0 ? `${r.exp >= 0 ? '+' : ''}${r.exp.toFixed(2)}R` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {tickerFilter === 'ALL' && <p style={{ fontSize: '0.7rem', color: '#666', margin: '10px 0 0 0' }}>Click en un activo para filtrar todo el panel por ese ticker.</p>}
      </div>

      {/* 🆕 MATRIZ SESIÓN × GATILLO */}
      <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#7c4dff', margin: 0, marginBottom: '6px', fontSize: '0.9rem' }}>
          <LayoutGrid size={16} /> MATRIZ SESIÓN × GATILLO (WR / R neto)
        </h3>
        <p style={{ fontSize: '0.7rem', color: '#666', margin: '0 0 14px 0' }}>
          Win rate y R neto por sesión y tipo de entrada. Clasificación aproximada desde los eventos del journal.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ color: '#888' }}>
              <th style={{ padding: '6px 8px', textAlign: 'left' }}>SESIÓN</th>
              {matrix.triggers.map(g => <th key={g} style={{ padding: '6px 8px' }}>{g}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.sessions.map(s => (
              <tr key={s} style={{ borderTop: '1px solid #1a1a1a' }}>
                <td style={{ padding: '8px', fontWeight: 700, color: '#e6e6e6' }}>
                  {s === 'OFF' ? '🌙 Nocturna' : s === 'LONDON' ? '🇬🇧 London' : s === 'NY' ? '🇺🇸 NY' : '🌏 Asia'}
                </td>
                {matrix.triggers.map(g => {
                  const c = matrix.cells[s][g];
                  if (!c || c.n === 0) return <td key={g} style={{ padding: '8px', color: '#444', fontFamily: 'monospace' }}>—</td>;
                  const wrRatio = c.decided > 0 ? c.wins / c.decided : 0;
                  const wrColor = wrRatio >= 0.55 ? '#00e676' : wrRatio >= 0.45 ? '#ffaa00' : '#ff3333';
                  return (
                    <td key={g} style={{ padding: '8px', fontFamily: 'monospace' }}>
                      <span style={{ color: wrColor }}>{(wrRatio * 100).toFixed(0)}%</span>
                      <span style={{ color: c.netR >= 0 ? '#00e676' : '#ff3333' }}> · {c.netR >= 0 ? '+' : ''}{c.netR.toFixed(1)}R</span>
                      <span style={{ color: '#555', fontSize: '0.7rem' }}> ({c.n})</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── GRÁFICO PRINCIPAL DE CURVA DE EQUIDAD DE R-MULTIPLES ─── */}
      <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-green)', margin: 0 }}>
              <TrendingUp size={18} /> CURVA DE CRECIMIENTO ACUMULADO (R-MULTIPLES)
            </h3>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Retorno neto en múltiplos de riesgo (calculado con niveles reales de entrada, SL y TP de cada alerta)
            </span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>Drawdown Reciente:</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--accent-red)', marginLeft: '6px' }}>
              {currentDrawdown.toFixed(2)} R
            </span>
          </div>
        </div>

        <div style={{ height: '300px', width: '100%', marginTop: '20px' }}>
          {equityData.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={equityData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent-green)" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="var(--accent-green)" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                <XAxis dataKey="date" stroke="var(--text-tertiary)" fontSize={10} tickLine={false} />
                <YAxis stroke="var(--text-tertiary)" fontSize={10} tickLine={false} unit=" R" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-color)',
                    color: 'var(--text-primary)',
                    borderRadius: '4px',
                    fontFamily: 'var(--font-mono)'
                  }}
                  formatter={(value: any) => [`${value} R`, 'Retorno Acumulado']}
                />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke="var(--accent-green)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorEquity)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
              Sin trades cerrados en el período seleccionado.
            </div>
          )}
        </div>
      </div>

      {/* GRÁFICOS SECUNDARIOS */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <div className="panel" style={{ height: '300px', marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>DISTRIBUCIÓN DE OPERACIONES</h3>
          {totalCompleted > 0 ? (
            <ResponsiveContainer width="100%" height="80%">
              <PieChart>
                <Pie data={stats} cx="50%" cy="50%" innerRadius={50} outerRadius={70} paddingAngle={5} dataKey="value">
                  {stats.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-tertiary)' }}>Sin datos suficientes</div>
          )}
        </div>

        <div className="panel" style={{ height: '300px', marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>TRADES POR SETUP / CALIDAD</h3>
          {gradeStats.length > 0 ? (
            <ResponsiveContainer width="100%" height="80%">
              <BarChart data={gradeStats}>
                <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--text-secondary)" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'var(--bg-panel-hover)' }} contentStyle={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
                <Bar dataKey="value" fill="var(--accent-blue)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-tertiary)' }}>Sin datos suficientes</div>
          )}
        </div>

        <div className="panel" style={{ height: '300px', marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Target size={16} /> WIN RATE POR PUNTOS (CONFLUENCIAS)
          </h3>
          {pointsStats.length > 0 ? (
            <ResponsiveContainer width="100%" height="80%">
              <BarChart data={pointsStats} layout="vertical" margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                <XAxis type="number" domain={[0, 100]} stroke="var(--text-secondary)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(tick) => `${tick}%`} />
                <YAxis type="category" dataKey="name" stroke="var(--text-secondary)" fontSize={11} tickLine={false} axisLine={false} width={60} />
                <Tooltip
                  cursor={{ fill: 'var(--bg-panel-hover)' }}
                  contentStyle={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  formatter={(value: any, _name: any, props: any) => [`${value}% (${props.payload.total} trades)`, 'Win Rate']}
                />
                <Bar dataKey="winRate" fill="#00ff00" radius={[0, 4, 4, 0]} barSize={16}>
                  {pointsStats.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.winRate >= 60 ? '#00ff00' : entry.winRate >= 40 ? '#ffaa00' : '#ff3333'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-tertiary)' }}>Sin datos suficientes</div>
          )}
        </div>
      </div>

      {/* 🆕 TABLA DE TRADES */}
      <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#e6e6e6', margin: 0, marginBottom: '12px', fontSize: '0.9rem' }}>
          📜 TRADES DEL PERÍODO <span style={{ fontSize: '0.7rem', color: '#888' }}>({filtered.length} en total)</span>
        </h3>
        {filtered.length === 0 ? (
          <p style={{ color: '#666', fontSize: '0.85rem' }}>Sin trades en el período seleccionado.</p>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ color: '#888', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>FECHA</th>
                  <th style={{ padding: '6px 8px' }}>ACTIVO</th>
                  <th style={{ padding: '6px 8px' }}>DIR</th>
                  <th style={{ padding: '6px 8px' }}>GATILLO</th>
                  <th style={{ padding: '6px 8px' }}>PTS</th>
                  <th style={{ padding: '6px 8px' }}>R</th>
                  <th style={{ padding: '6px 8px' }}>PARCIAL</th>
                  <th style={{ padding: '6px 8px' }}>RESULTADO</th>
                  <th style={{ padding: '6px 8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {(showAllRows ? filtered : filtered.slice(0, 50)).map(t => {
                  const rr = getTradeRR(t);
                  return (
                    <tr key={t.id} style={{ borderTop: '1px solid #1a1a1a' }}>
                      <td style={{ padding: '7px 8px', color: '#aaa' }}>{new Date(t.timestamp).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td style={{ padding: '7px 8px', color: '#e6e6e6', fontWeight: 600 }}>{t.ticker}</td>
                      <td style={{ padding: '7px 8px', color: t.direction === 'BUY' ? '#00e676' : '#ff3333', fontWeight: 700 }}>{t.direction === 'BUY' ? 'L' : 'S'}</td>
                      <td style={{ padding: '7px 8px', color: '#aaa' }}>{classifyTrigger(t)}</td>
                      <td style={{ padding: '7px 8px', color: '#aaa', fontFamily: 'monospace' }}>{t.points ?? '—'}</td>
                      <td style={{ padding: '7px 8px', fontFamily: 'monospace', color: rr >= 0 ? '#00e676' : '#ff3333' }}>{rr >= 0 ? '+' : ''}{rr.toFixed(2)}</td>
                      <td style={{ padding: '7px 8px', fontFamily: 'monospace', fontSize: '0.78rem', color: '#ffaa00' }}>
                        {t.tp1Hit
                          ? `${Math.round((t.tp1PartialPct ?? 0.8) * 100)}%${t.tp1PartialPrice != null ? ` @ ${t.tp1PartialPrice}` : ''}${t.tp1PartialPnlUsd != null ? ` (+${t.tp1PartialPnlUsd.toFixed(2)})` : ''}`
                          : '—'}
                      </td>
                      <td style={{ padding: '7px 8px', fontWeight: 700, color: t.result === 'WIN' ? '#00e676' : t.result === 'LOSS' ? '#ff3333' : '#ffaa00' }}>
                        {t.result === 'WIN' ? '✓ WIN' : t.result === 'LOSS' ? '✗ LOSS' : t.result === 'BREAKEVEN' ? 'BE ➖' : t.result || (t.tp1Hit ? '🏳️ PARCIAL (abierto)' : 'EN CURSO')}
                      </td>
                      <td style={{ padding: '2px 4px' }}>
                        <button
                          onClick={() => {
                            setSelectedTrade(t);
                            setModalExitPrice('');
                            setModalResult((t.result as any) || '');
                            if (t.result === 'WIN') setModalRMultiple(t.rMultiple != null ? String(Math.abs(t.rMultiple)) : getSuggestedR(t).toString());
                            else if (t.result === 'LOSS') setModalRMultiple(t.rMultiple != null ? String(Math.abs(t.rMultiple)) : '1');
                            else if (!t.result) { setModalResult(''); setModalRMultiple(getSuggestedR(t).toString()); }
                            else setModalRMultiple('');
                          }}
                          title="Registrar / corregir resultado"
                          style={{ background: 'none', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer', color: '#888', fontSize: '0.8rem', padding: '2px 8px' }}
                        >
                          ✏️
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length > 50 && !showAllRows && (
              <button onClick={() => setShowAllRows(true)} style={{ marginTop: '10px', padding: '6px 14px', background: '#111', color: '#e6e6e6', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem' }}>
                Mostrar todos ({filtered.length})
              </button>
            )}
          </>
        )}
      </div>

      {/* 🆕 Modal de registro manual de resultado (heredado de la bitácora) */}
      {selectedTrade && (
        <div className="modal-overlay" onClick={() => setSelectedTrade(null)}>
          <div className="modal-content-premium" onClick={(e) => e.stopPropagation()} style={{ borderColor: 'var(--border-color)', maxWidth: '420px' }}>
            <div className="modal-header-premium" style={{ justifyContent: 'space-between', width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="modal-title-icon" style={{ color: 'var(--accent-gold)' }}>✏️</span>
                <h3 style={{ margin: 0 }}>REGISTRAR RESULTADO — #{selectedTrade.id}</h3>
              </div>
              <button
                onClick={() => setSelectedTrade(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.2rem' }}
              >
                ✕
              </button>
            </div>

            <div className="modal-body-premium" style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '4px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Ticker:</span>
                  <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{selectedTrade.ticker}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Dirección:</span>
                  <span className={selectedTrade.direction === 'BUY' ? 'text-green' : 'text-red'} style={{ fontWeight: 700 }}>{selectedTrade.direction}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Niveles:</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                    🛑 SL: {selectedTrade.slPrice} | 🎯 TP1: {selectedTrade.tp1Price}
                  </span>
                </div>
              </div>

              <label style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', marginBottom: '8px', color: 'var(--text-secondary)' }}>
                PRECIO DE SALIDA (donde tocó TP / cerró)
              </label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: '6px' }}>
                <input
                  type="number"
                  step="any"
                  value={modalExitPrice}
                  onChange={(e) => applyExitPrice(e.target.value)}
                  placeholder={selectedTrade?.tp1Price ? `Ej: ${selectedTrade.tp1Price} (TP1)` : 'Ej: 159.010'}
                  style={{
                    width: '100%', padding: '10px', backgroundColor: 'var(--bg-base)',
                    border: '1px solid var(--border-color)', borderRadius: '4px',
                    color: 'var(--text-primary)', outline: 'none', fontWeight: 600,
                    fontSize: '0.85rem', fontFamily: 'var(--font-mono)',
                  }}
                />
              </div>
              {selectedTrade && !(selectedTrade.entryPrice && selectedTrade.slPrice) && (
                <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: '0 0 12px 0' }}>
                  ⚠️ Este trade no tiene entrada/SL registrados — usá el múltiplo R manual.
                </p>
              )}
              <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: '0 0 20px 0' }}>
                Con este precio calculo el múltiplo R y el resultado automáticamente (lo podés ajustar a mano después).
              </p>

              <label style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', marginBottom: '8px', color: 'var(--text-secondary)' }}>
                RESULTADO DEL TRADE
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '20px' }}>
                {(['WIN', 'LOSS', 'BREAKEVEN', 'SKIP'] as const).map((res) => {
                  const isActive = modalResult === res;
                  const labelMap = { WIN: 'WIN ✅', LOSS: 'LOSS ❌', BREAKEVEN: 'BE ➖', SKIP: 'SKIP 🚫' };
                  const colorMap = { WIN: '#00ff00', LOSS: '#ff3333', BREAKEVEN: '#888888', SKIP: '#555555' };
                  return (
                    <button
                      key={res}
                      type="button"
                      onClick={() => {
                        setModalExitPrice('');
                        setModalResult(res);
                        if (res === 'WIN') setModalRMultiple(getSuggestedR(selectedTrade).toString());
                        else if (res === 'LOSS') setModalRMultiple('1');
                        else setModalRMultiple('');
                      }}
                      style={{
                        padding: '10px 4px', fontSize: '0.75rem', fontWeight: 700,
                        border: `1px solid ${isActive ? colorMap[res] : 'var(--border-color)'}`,
                        borderRadius: '4px', cursor: 'pointer',
                        backgroundColor: isActive ? `${colorMap[res]}1a` : 'transparent',
                        color: isActive ? colorMap[res] : 'var(--text-secondary)',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {labelMap[res]}
                    </button>
                  );
                })}
              </div>

              {(modalResult === 'WIN' || modalResult === 'LOSS') && (
                <div className="animate-fadeIn">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <label style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {modalResult === 'WIN' ? 'MÚLTIPLO R OBTENIDO' : 'MÚLTIPLO R PERDIDO'}
                    </label>
                    {modalResult === 'WIN' && (
                      <button
                        type="button"
                        onClick={() => { setModalExitPrice(''); setModalRMultiple(getSuggestedR(selectedTrade).toString()); }}
                        style={{ background: 'none', border: 'none', color: 'var(--accent-gold)', fontSize: '0.7rem', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                      >
                        Usar calculado ({getSuggestedR(selectedTrade)} R)
                      </button>
                    )}
                  </div>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="number" step="0.01" min="0"
                      value={modalRMultiple}
                      onChange={(e) => setModalRMultiple(e.target.value)}
                      placeholder={modalResult === 'WIN' ? 'Ej: 2.5' : 'Ej: 1'}
                      style={{
                        width: '100%', padding: '10px', backgroundColor: 'var(--bg-base)',
                        border: '1px solid var(--border-color)', borderRadius: '4px',
                        color: 'var(--text-primary)', outline: 'none', fontWeight: 600,
                        fontSize: '0.85rem', fontFamily: 'var(--font-mono)',
                      }}
                    />
                    <span style={{ position: 'absolute', right: '12px', fontSize: '0.85rem', color: 'var(--text-tertiary)', fontWeight: 700 }}>R</span>
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer-premium" style={{ flexDirection: 'row', gap: '12px' }}>
              <button className="btn-cancel" onClick={() => setSelectedTrade(null)} style={{ flex: 1, padding: '10px', margin: 0 }}>
                Cancelar
              </button>
              <button
                onClick={handleSaveModalResult}
                disabled={updating !== null || !modalResult}
                style={{
                  flex: 1, padding: '10px',
                  backgroundColor: !modalResult ? 'var(--bg-panel-hover)' : modalResult === 'WIN' ? 'rgba(0, 255, 0, 0.2)' : modalResult === 'LOSS' ? 'rgba(255, 51, 51, 0.2)' : 'var(--accent-gold)',
                  color: !modalResult ? 'var(--text-secondary)' : '#ffffff',
                  border: `1px solid ${!modalResult ? 'var(--border-color)' : modalResult === 'WIN' ? 'var(--accent-green)' : modalResult === 'LOSS' ? 'var(--accent-red)' : 'var(--accent-gold)'}`,
                  borderRadius: '4px', cursor: (!modalResult || updating !== null) ? 'not-allowed' : 'pointer',
                  fontWeight: 700, fontSize: '0.85rem', margin: 0,
                }}
              >
                {updating !== null ? 'Guardando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>

  );
}
