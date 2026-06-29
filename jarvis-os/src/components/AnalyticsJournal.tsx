import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { 
  PieChart as PieChartIcon, 
  TrendingUp, 
  Crosshair, 
  Target, 
  Award,
  Activity,
  Download,
  ShieldCheck
} from 'lucide-react';
import { 
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, 
  BarChart, Bar, XAxis, YAxis, AreaChart, Area, CartesianGrid 
} from 'recharts';

import { getSessionForTimestamp } from '../services/backtestEngine';

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
  events?: string[];
  isChochEntry?: boolean;
  rMultiple?: number;
  tf?: string;
}

const COLORS = ['#00ff00', '#ff3333', '#888888'];

const getTradeRR = (t: TradeLog): number => {
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

const getSuggestedR = (t: TradeLog): number => {
  if (t.rMultiple !== undefined && t.rMultiple !== null) {
    return Math.abs(t.rMultiple);
  }
  if (t.entryPrice && t.slPrice) {
    const risk = Math.abs(t.entryPrice - t.slPrice);
    if (risk > 0) {
      let targetPrice = t.tp1Price;
      if (t.tp2Hit && t.tp2Price) {
        targetPrice = t.tp2Price;
      } else if (t.tp1Price) {
        targetPrice = t.tp1Price;
      } else if (t.tp2Price) {
        targetPrice = t.tp2Price;
      }
      
      if (targetPrice) {
        const reward = Math.abs(targetPrice - t.entryPrice);
        return Number((reward / risk).toFixed(2));
      }
    }
  }
  return 1; // Conservador: sin datos suficientes para calcular
};

const resultButtonStyle = (color: string, isActive: boolean) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 10px',
  fontSize: '0.75rem',
  fontWeight: 600,
  fontFamily: 'var(--font-mono)',
  border: `1px solid ${color}`,
  borderRadius: '4px',
  cursor: 'pointer',
  transition: 'all 0.2s ease',
  backgroundColor: isActive ? color : 'transparent',
  color: isActive ? 'var(--bg-base)' : color,
  opacity: isActive ? 1 : 0.7,
});

const getEntryTypeBadge = (t: TradeLog) => {
  const events = t.events || [];
  const hasBos = events.some(e => e.includes('BOS🔨'));
  const hasChoch = events.some(e => e.includes('CHoCH🚀'));
  const hasOte = events.includes('🎯_OTE_Retracement_3M');

  if (t.isChochEntry) {
    if (hasBos) {
      return { label: 'BOS Directo', color: '#7c4dff', bg: 'rgba(124,77,255,0.1)' };
    }
    return { label: 'CHoCH Directo', color: '#ffaa00', bg: 'rgba(255,170,0,0.1)' };
  }
  
  if (hasOte) {
    if (hasChoch) return { label: 'OTE (CHoCH)', color: '#00ffcc', bg: 'rgba(0,255,204,0.1)' };
    if (hasBos) return { label: 'OTE (BOS)', color: '#00ccff', bg: 'rgba(0,204,255,0.1)' };
    return { label: 'OTE', color: '#00ffcc', bg: 'rgba(0,255,204,0.1)' };
  }
  
  if (hasChoch) return { label: 'CHoCH', color: '#ff7700', bg: 'rgba(255,119,0,0.1)' };
  if (hasBos) return { label: 'BOS', color: '#7c4dff', bg: 'rgba(124,77,255,0.1)' };
  
  return { label: 'SMC', color: 'var(--text-secondary)', bg: 'rgba(100,100,100,0.1)' };
};

export default function AnalyticsJournal() {
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const { toast } = useToast();

  useEffect(() => {
    const fetchTrades = async () => {
      try {
        const q = query(collection(db, 'trade_journal'), orderBy('timestamp', 'desc'), limit(100));
        const snapshot = await getDocs(q);
        const data = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as TradeLog));
        setTrades(data);
      } catch (err) {
        console.error('Error fetching trade journal:', err);
      }
    };

    fetchTrades();
    const intervalId = setInterval(fetchTrades, 60000); // Polling 60s

    return () => clearInterval(intervalId);
  }, []);


  const getStats = () => {
    let wins = 0, losses = 0, breakevens = 0;
    trades.forEach(t => {
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
    trades.forEach(t => {
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
    trades.forEach(t => {
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
    const sortedTrades = [...trades]
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
    const closed = trades.filter(t => t.result && t.result !== 'SKIP');
    
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
    if (trades.length === 0) {
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

    const rows = trades.map(t => [
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
    const closed = trades.filter(t => t.result && t.result !== 'SKIP');
    
    const sessions: Record<string, { gp: number, gl: number }> = {
      'LONDON': { gp: 0, gl: 0 },
      'NY': { gp: 0, gl: 0 },
      'ASIA': { gp: 0, gl: 0 },
      'ALL': { gp: 0, gl: 0 }
    };

    closed.forEach(t => {
      const session = getSessionForTimestamp(t.timestamp);
      const sKey = session === 'OFF' ? 'ALL' : session;
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
  const winRate = totalCompleted > 0 ? ((stats[0].value / totalCompleted) * 100).toFixed(1) : '0.0';
  
  const getAccumulatedR = () => {
    let currentR = 0;
    trades
      .filter(t => t.result && t.result !== 'SKIP')
      .forEach(t => {
        currentR += getTradeRR(t);
      });
    return Number(currentR.toFixed(2));
  };
  const totalR = getAccumulatedR();
  const currentDrawdown = equityData.length > 0 ? Math.max(...equityData.map(d => d.balance)) - equityData[equityData.length - 1].balance : 0;
  
  return (
    <div className="animate-fadeIn">
      {/* HEADER */}
      <div className="panel-header" style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <PieChartIcon size={14} style={{ marginRight: 8 }} /> 
          <span>DIARIO ANALÍTICO & MONITOREO DE PERFORMANCE</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={exportToCSV}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              backgroundColor: 'rgba(255,170,0,0.1)',
              border: '1px solid rgba(255,170,0,0.3)',
              borderRadius: '4px',
              color: 'var(--accent-gold)',
              fontSize: '0.75rem',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = 'rgba(255,170,0,0.2)';
              e.currentTarget.style.borderColor = 'var(--accent-gold)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = 'rgba(255,170,0,0.1)';
              e.currentTarget.style.borderColor = 'rgba(255,170,0,0.3)';
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
              {totalR >= 0 ? `+${totalR}` : totalR} R
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
                    <stop offset="5%" stopColor="var(--accent-green)" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="var(--accent-green)" stopOpacity={0.0}/>
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
              Registra los resultados (WIN/LOSS) de tus trades en el historial reciente para construir la curva de capital.
            </div>
          )}
        </div>
      </div>

      {/* GRÁFICOS SECUNDARIOS */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <div className="panel" style={{ height: '300px', marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>DISTRIBUCIÓN DE OPERACIONES (ÚLTIMOS 100)</h3>
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

      </div>

  );
}
