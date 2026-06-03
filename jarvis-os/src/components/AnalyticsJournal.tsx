import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy, limit, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { 
  PieChart as PieChartIcon, 
  TrendingUp, 
  Crosshair, 
  CheckCircle, 
  XCircle, 
  MinusCircle, 
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
import { useToast } from './Toast';

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
}

const COLORS = ['#00ff00', '#ff3333', '#888888'];

const getTradeRR = (t: TradeLog): number => {
  if (t.result === 'LOSS') {
    return t.rMultiple !== undefined && t.rMultiple !== null && t.rMultiple < 0 ? t.rMultiple : -1;
  }
  if (t.result === 'BREAKEVEN') return 0;
  if (t.result === 'WIN') {
    if (t.rMultiple !== undefined && t.rMultiple !== null && t.rMultiple > 0) {
      return t.rMultiple;
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
    return 2; // Default fallback R:R
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
  return 2; // Default fallback R:R
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
  const [updating, setUpdating] = useState<string | null>(null);
  const [selectedTradeForModal, setSelectedTradeForModal] = useState<TradeLog | null>(null);
  const [modalResult, setModalResult] = useState<'WIN' | 'LOSS' | 'BREAKEVEN' | 'SKIP' | ''>('');
  const [modalRMultiple, setModalRMultiple] = useState<string>('');
  const { toast } = useToast();

  useEffect(() => {
    const q = query(collection(db, 'trade_journal'), orderBy('timestamp', 'desc'), limit(100));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TradeLog));
      setTrades(data);
    });
    return () => unsubscribe();
  }, []);

  const handleSetResult = async (tradeId: string, result: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'SKIP') => {
    setUpdating(tradeId);
    try {
      const tradeRef = doc(db, 'trade_journal', tradeId);
      await updateDoc(tradeRef, { result });
      const labels: Record<string, string> = { WIN: 'WIN ✅', LOSS: 'LOSS ❌', BREAKEVEN: 'BE ➖', SKIP: 'No operado 🚫' };
      toast(`Trade #${tradeId} → ${labels[result]}`, result === 'WIN' ? 'success' : result === 'LOSS' ? 'error' : 'info');
    } catch (e) {
      console.error('Error updating trade result:', e);
      toast('Error al registrar resultado', 'error');
    } finally {
      setUpdating(null);
    }
  };

  const handleSaveModalResult = async () => {
    if (!selectedTradeForModal) return;
    
    let finalR: number | null = null;
    if (modalResult === 'WIN') {
      const parsed = parseFloat(modalRMultiple);
      if (isNaN(parsed) || parsed <= 0) {
        toast('Por favor ingrese un múltiplo R válido mayor a 0', 'error');
        return;
      }
      finalR = parsed;
    } else if (modalResult === 'LOSS') {
      const parsed = parseFloat(modalRMultiple);
      if (isNaN(parsed) || parsed <= 0) {
        toast('Por favor ingrese un múltiplo R válido de pérdida (mayor a 0)', 'error');
        return;
      }
      // Store as negative number in DB
      finalR = -parsed;
    } else if (modalResult === 'BREAKEVEN') {
      finalR = 0;
    }

    setUpdating(selectedTradeForModal.id);
    try {
      const tradeRef = doc(db, 'trade_journal', selectedTradeForModal.id);
      
      const updateData: any = { 
        result: modalResult,
        rMultiple: finalR
      };

      await updateDoc(tradeRef, updateData);
      
      const labels: Record<string, string> = { WIN: 'WIN ✅', LOSS: 'LOSS ❌', BREAKEVEN: 'BE ➖', SKIP: 'No operado 🚫' };
      toast(`Trade #${selectedTradeForModal.id} actualizado → ${labels[modalResult as string]} (${finalR !== null ? finalR + ' R' : 'N/A'})`, modalResult === 'WIN' ? 'success' : modalResult === 'LOSS' ? 'error' : 'info');
      
      setSelectedTradeForModal(null);
    } catch (e) {
      console.error('Error updating trade result:', e);
      toast('Error al actualizar el resultado', 'error');
    } finally {
      setUpdating(null);
    }
  };

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
  
  const totalCompleted = stats.reduce((acc, curr) => acc + curr.value, 0);
  const winRate = totalCompleted > 0 ? ((stats[0].value / totalCompleted) * 100).toFixed(1) : '0.0';
  
  const getAccumulatedR = () => {
    let currentR = 0;
    trades.forEach(t => {
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
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)' }}>PROFIT FACTOR</span>
              <ShieldCheck size={14} color="#0088ff" />
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '8px 0 4px 0', color: '#0088ff' }}>
              {kpis.profitFactor}
            </div>
          </div>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
            Retorno bruto vs pérdida bruta
          </span>
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

      {/* HISTORIAL RECIENTE */}
      <div className="panel">
         <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity size={18} color="var(--accent-gold)" /> BITÁCORA DE TRADES RECIENTES
         </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Aquí puedes marcar el resultado real de las alertas de Smart Money Concepts emitidas por el bot de Telegram.
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>FECHA</th>
                <th>ACTIVO</th>
                <th>DIRECCIÓN</th>
                <th>GATILLO / TIPO</th>
                <th>CALIDAD / PUNTOS</th>
                <th>NIVELES</th>
                <th>RESULTADO</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 15).map(t => (
                <tr key={t.id} style={{ opacity: updating === t.id ? 0.5 : 1, transition: 'opacity 0.2s' }}>
                  <td>{new Date(t.timestamp).toLocaleString()}</td>
                  <td style={{ fontWeight: 700 }}>{t.ticker}</td>
                  <td className={t.direction === 'BUY' ? 'text-green' : 'text-red'} style={{ fontWeight: 700 }}>
                    {t.direction}
                  </td>
                  <td>
                    {(() => {
                      const badge = getEntryTypeBadge(t);
                      return (
                        <span style={{ 
                          padding: '2px 8px', 
                          backgroundColor: badge.bg, 
                          color: badge.color, 
                          border: `1px solid ${badge.color}33`,
                          borderRadius: '4px', 
                          fontWeight: 700,
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)'
                        }}>
                          {badge.label}
                        </span>
                      );
                    })()}
                  </td>
                  <td>
                    <span style={{ padding: '2px 6px', backgroundColor: 'rgba(255,170,0,0.1)', color: 'var(--accent-gold)', borderRadius: '4px', marginRight: '8px', fontWeight: 600 }}>
                      {t.grade}
                    </span>
                    {t.points !== undefined && (
                      <span style={{ padding: '2px 6px', backgroundColor: 'rgba(100,100,100,0.2)', color: 'var(--text-secondary)', borderRadius: '4px', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                        {t.points} pts
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                    {t.slPrice !== undefined && t.tp1Price !== undefined ? (
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                        <span title="Stop Loss" style={{ color: 'var(--accent-red)', opacity: t.slHit ? 0.4 : 0.7 }}>🛑{t.slPrice}</span>
                        <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                        <span title="Take Profit 1" style={{ color: 'var(--accent-gold)', opacity: t.tp1Hit ? 0.4 : 0.7 }}>🎯{t.tp1Price}</span>
                        {t.tp2Price && t.tp2Price > 0 && (
                          <>
                            <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                            <span title="Take Profit 2" style={{ color: 'var(--accent-green)', opacity: t.tp2Hit ? 0.4 : 0.7 }}>🚀{t.tp2Price}</span>
                          </>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem' }}>—</span>
                    )}
                  </td>
                  <td>
                    {t.result ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span className={t.result === 'WIN' ? 'text-green' : t.result === 'LOSS' ? 'text-red' : 'text-muted'} style={{ fontWeight: 700 }}>
                          {t.result === 'WIN' ? `✅ WIN (+${getTradeRR(t)} R)` : t.result === 'LOSS' ? `❌ LOSS (${getTradeRR(t)} R)` : t.result === 'SKIP' ? '🚫 NO OPERADO' : `➖ BE (${getTradeRR(t).toFixed(1)} R)`}
                        </span>
                        <button
                          onClick={() => {
                            setSelectedTradeForModal(t);
                            setModalResult(t.result as any);
                            if (t.result === 'WIN') {
                              setModalRMultiple(t.rMultiple !== undefined && t.rMultiple !== null ? t.rMultiple.toString() : getSuggestedR(t).toString());
                            } else if (t.result === 'LOSS') {
                              setModalRMultiple(t.rMultiple !== undefined && t.rMultiple !== null ? Math.abs(t.rMultiple).toString() : '1');
                            } else {
                              setModalRMultiple('');
                            }
                          }}
                          style={{ 
                            background: 'none', border: 'none', cursor: 'pointer', 
                            color: 'var(--text-tertiary)', fontSize: '0.7rem', padding: '2px 4px',
                            opacity: 0.5, transition: 'opacity 0.2s'
                          }}
                          title="Modificar resultado"
                          onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                          onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                        >
                          ✏️
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button 
                          onClick={() => {
                            setSelectedTradeForModal(t);
                            setModalResult('WIN');
                            setModalRMultiple(getSuggestedR(t).toString());
                          }}
                          disabled={updating === t.id}
                          style={resultButtonStyle('#00ff00', false) as React.CSSProperties}
                          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#00ff00'; e.currentTarget.style.color = 'var(--bg-base)'; }}
                          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#00ff00'; }}
                        >
                          <CheckCircle size={12} /> WIN
                        </button>
                        <button 
                          onClick={() => {
                            setSelectedTradeForModal(t);
                            setModalResult('LOSS');
                            setModalRMultiple('1');
                          }}
                          disabled={updating === t.id}
                          style={resultButtonStyle('#ff3333', false) as React.CSSProperties}
                          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#ff3333'; e.currentTarget.style.color = 'var(--bg-base)'; }}
                          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#ff3333'; }}
                        >
                          <XCircle size={12} /> LOSS
                        </button>
                        <button 
                          onClick={() => handleSetResult(t.id, 'BREAKEVEN')}
                          disabled={updating === t.id}
                          style={resultButtonStyle('#888888', false) as React.CSSProperties}
                          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#888888'; e.currentTarget.style.color = 'var(--bg-base)'; }}
                          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#888888'; }}
                        >
                          <MinusCircle size={12} /> BE
                        </button>
                        <button 
                          onClick={() => handleSetResult(t.id, 'SKIP')}
                          disabled={updating === t.id}
                          style={{ ...resultButtonStyle('#555555', false) as React.CSSProperties, fontSize: '0.65rem' }}
                          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#555555'; e.currentTarget.style.color = 'var(--bg-base)'; }}
                          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#555555'; }}
                        >
                          🚫 NO OPERÉ
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {trades.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-tertiary)' }}>
                    No se registran alertas de trading en el diario actualmente. Las alertas en vivo de SMC aparecerán aquí de forma automática.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
      </div>

      {/* Modal de Asignación y Edición de R-Multiple */}
      {selectedTradeForModal && (
        <div className="modal-overlay" onClick={() => setSelectedTradeForModal(null)}>
          <div className="modal-content-premium" onClick={(e) => e.stopPropagation()} style={{ borderColor: 'var(--border-color)', maxWidth: '400px' }}>
            <div className="modal-header-premium" style={{ justifyContent: 'space-between', width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="modal-title-icon" style={{ color: 'var(--accent-gold)' }}>✏️</span>
                <h3 style={{ margin: 0 }}>REGISTRAR RESULTADO</h3>
              </div>
              <button 
                onClick={() => setSelectedTradeForModal(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.2rem' }}
              >
                ✕
              </button>
            </div>
            
            <div className="modal-body-premium" style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '4px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Ticker:</span>
                  <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{selectedTradeForModal.ticker}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Dirección:</span>
                  <span className={selectedTradeForModal.direction === 'BUY' ? 'text-green' : 'text-red'} style={{ fontWeight: 700 }}>
                    {selectedTradeForModal.direction}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Niveles:</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                    🛑 SL: {selectedTradeForModal.slPrice} | 🎯 TP1: {selectedTradeForModal.tp1Price}
                  </span>
                </div>
              </div>

              {/* Selector de resultado */}
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
                        setModalResult(res);
                        if (res === 'WIN') {
                          setModalRMultiple(getSuggestedR(selectedTradeForModal).toString());
                        } else if (res === 'LOSS') {
                          setModalRMultiple('1');
                        } else {
                          setModalRMultiple('');
                        }
                      }}
                      style={{
                        padding: '10px 4px',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        border: `1px solid ${isActive ? colorMap[res] : 'var(--border-color)'}`,
                        borderRadius: '4px',
                        cursor: 'pointer',
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

              {/* R-Multiple input field (only for WIN or LOSS) */}
              {(modalResult === 'WIN' || modalResult === 'LOSS') && (
                <div className="animate-fadeIn">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <label style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {modalResult === 'WIN' ? 'MÚLTIPLO R OBTENIDO' : 'MÚLTIPLO R PERDIDO'}
                    </label>
                    {modalResult === 'WIN' && (
                      <button
                        type="button"
                        onClick={() => setModalRMultiple(getSuggestedR(selectedTradeForModal).toString())}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent-gold)',
                          fontSize: '0.7rem',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0
                        }}
                      >
                        Usar calculado ({getSuggestedR(selectedTradeForModal)} R)
                      </button>
                    )}
                  </div>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={modalRMultiple}
                      onChange={(e) => setModalRMultiple(e.target.value)}
                      placeholder={modalResult === 'WIN' ? 'Ej: 2.5' : 'Ej: 1'}
                      style={{
                        width: '100%',
                        padding: '10px',
                        backgroundColor: 'var(--bg-base)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '4px',
                        color: 'var(--text-primary)',
                        outline: 'none',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        fontFamily: 'var(--font-mono)'
                      }}
                    />
                    <span style={{ position: 'absolute', right: '12px', fontSize: '0.85rem', color: 'var(--text-tertiary)', fontWeight: 700 }}>
                      R
                    </span>
                  </div>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '6px' }}>
                    {modalResult === 'WIN' 
                      ? 'Especifica cuántas veces el riesgo inicial ganaste.' 
                      : 'Especifica cuántas veces el riesgo inicial perdiste (se guardará como negativo en la base de datos).'}
                  </p>
                </div>
              )}
            </div>

            <div className="modal-footer-premium" style={{ flexDirection: 'row', gap: '12px' }}>
              <button 
                className="btn-cancel" 
                onClick={() => setSelectedTradeForModal(null)}
                style={{ flex: 1, padding: '10px', margin: 0 }}
              >
                Cancelar
              </button>
              <button 
                onClick={handleSaveModalResult}
                disabled={updating !== null || !modalResult}
                style={{ 
                  flex: 1, 
                  padding: '10px', 
                  backgroundColor: !modalResult ? 'var(--bg-panel-hover)' : modalResult === 'WIN' ? 'rgba(0, 255, 0, 0.2)' : modalResult === 'LOSS' ? 'rgba(255, 51, 51, 0.2)' : 'var(--accent-gold)', 
                  color: !modalResult ? 'var(--text-secondary)' : '#ffffff',
                  border: `1px solid ${!modalResult ? 'var(--border-color)' : modalResult === 'WIN' ? 'var(--accent-green)' : modalResult === 'LOSS' ? 'var(--accent-red)' : 'var(--accent-gold)'}`,
                  borderRadius: '4px', 
                  cursor: (!modalResult || updating !== null) ? 'not-allowed' : 'pointer',
                  fontWeight: 700, 
                  fontSize: '0.85rem',
                  margin: 0
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
