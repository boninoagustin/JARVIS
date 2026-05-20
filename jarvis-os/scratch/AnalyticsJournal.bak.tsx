import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, orderBy, limit, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { PieChart as PieChartIcon, TrendingUp, Crosshair, CheckCircle, XCircle, MinusCircle, Target } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis } from 'recharts';
import { useToast } from './Toast';

interface TradeLog {
  id: string;
  ticker: string;
  direction: string;
  grade: string;
  points?: number;
  result?: string;
  timestamp: number;
  // 🆕 Niveles de ejecución
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
}

const COLORS = ['#00ff00', '#ff3333', '#888888'];

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

export default function AnalyticsJournal() {
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [updating, setUpdating] = useState<string | null>(null);
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
      if (!grades[t.grade]) grades[t.grade] = 0;
      grades[t.grade]++;
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

  const stats = getStats();
  const gradeStats = getGradeStats();
  const pointsStats = getPointsStats();
  
  const totalCompleted = stats.reduce((acc, curr) => acc + curr.value, 0);
  const winRate = totalCompleted > 0 ? ((stats[0].value / totalCompleted) * 100).toFixed(1) : '0.0';
  const pendingCount = trades.filter(t => !t.result).length;
  const skippedCount = trades.filter(t => t.result === 'SKIP').length;

  return (
    <div>
      <div className="panel-header">
        <span><PieChartIcon size={14} style={{ marginRight: 8 }} /> DIARIO ANALÍTICO Y ESTADÍSTICAS</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <div className="panel">
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Crosshair size={18} /> WIN RATE GLOBAL
          </h3>
          <div style={{ fontSize: '3rem', fontWeight: 700, color: 'var(--accent-gold)', textAlign: 'center', margin: '24px 0' }}>
            {winRate}%
          </div>
          <p className="text-muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>Basado en los últimos {totalCompleted} trades cerrados</p>
          {pendingCount > 0 && (
            <p style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--accent-gold)', marginTop: '8px' }}>
              ⏳ {pendingCount} trade{pendingCount > 1 ? 's' : ''} pendiente{pendingCount > 1 ? 's' : ''} de resultado
            </p>
          )}
          {skippedCount > 0 && (
            <p style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '4px' }}>
              🚫 {skippedCount} no operado{skippedCount > 1 ? 's' : ''}
            </p>
          )}
        </div>

        <div className="panel" style={{ height: '300px' }}>
          <h3 style={{ marginBottom: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>RESULTADOS (ÚLTIMOS 100)</h3>
          {totalCompleted > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stats} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
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

        <div className="panel" style={{ height: '300px' }}>
          <h3 style={{ marginBottom: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>TRADES POR CALIDAD</h3>
          {trades.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={gradeStats}>
                <XAxis dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'var(--bg-panel-hover)' }} contentStyle={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
                <Bar dataKey="value" fill="var(--accent-blue)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
             <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-tertiary)' }}>Sin datos suficientes</div>
          )}
        </div>

        <div className="panel" style={{ height: '300px' }}>
          <h3 style={{ marginBottom: '16px', fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Target size={16} /> WIN RATE POR PUNTOS (CONFLUENCIAS)
          </h3>
          {pointsStats.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pointsStats} layout="vertical" margin={{ top: 0, right: 30, left: 0, bottom: 0 }}>
                <XAxis type="number" domain={[0, 100]} stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(tick) => `${tick}%`} />
                <YAxis type="category" dataKey="name" stroke="var(--text-secondary)" fontSize={12} tickLine={false} axisLine={false} width={60} />
                <Tooltip 
                  cursor={{ fill: 'var(--bg-panel-hover)' }} 
                  contentStyle={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} 
                  formatter={(value: any, _name: any, props: any) => [`${value}% (${props.payload.total} trades)`, 'Win Rate']}
                />
                <Bar dataKey="winRate" fill="#00ff00" radius={[0, 4, 4, 0]} barSize={20}>
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

      <div className="panel">
         <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <TrendingUp size={18} /> HISTORIAL RECIENTE
          </h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>FECHA</th>
                <th>ACTIVO</th>
                <th>DIRECCIÓN</th>
                <th>CALIDAD / PUNTOS</th>
                <th>NIVELES</th>
                <th>RESULTADO</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 15).map(t => (
                <tr key={t.id} style={{ opacity: updating === t.id ? 0.5 : 1, transition: 'opacity 0.2s' }}>
                  <td>{new Date(t.timestamp).toLocaleString()}</td>
                  <td style={{ fontWeight: 600 }}>{t.ticker}</td>
                  <td className={t.direction === 'BUY' ? 'text-green' : 'text-red'}>{t.direction}</td>
                  <td>
                    <span style={{ padding: '2px 6px', backgroundColor: 'rgba(255,170,0,0.1)', color: 'var(--accent-gold)', borderRadius: '4px', marginRight: '8px' }}>
                      {t.grade}
                    </span>
                    {t.points !== undefined && (
                      <span style={{ padding: '2px 6px', backgroundColor: 'rgba(100,100,100,0.2)', color: 'var(--text-secondary)', borderRadius: '4px', fontSize: '0.8rem' }}>
                        {t.points} pts
                      </span>
                    )}
                  </td>
                  {/* 🆕 Columna de niveles SL / TP1 / TP2 */}
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
                        <span className={t.result === 'WIN' ? 'text-green' : t.result === 'LOSS' ? 'text-red' : 'text-muted'} style={{ fontWeight: 600 }}>
                          {t.result === 'WIN' ? '✅' : t.result === 'LOSS' ? '❌' : t.result === 'SKIP' ? '🚫' : '➖'} {t.result === 'SKIP' ? 'NO OPERÉ' : t.result}
                        </span>
                        <button
                          onClick={() => handleSetResult(t.id, t.result === 'WIN' ? 'WIN' : t.result === 'LOSS' ? 'LOSS' : 'BREAKEVEN')}
                          style={{ 
                            background: 'none', border: 'none', cursor: 'pointer', 
                            color: 'var(--text-tertiary)', fontSize: '0.7rem', padding: '2px 4px',
                            opacity: 0.5, transition: 'opacity 0.2s'
                          }}
                          title="Cambiar resultado"
                          onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                          onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                        >
                          ✏️
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button 
                          onClick={() => handleSetResult(t.id, 'WIN')}
                          disabled={updating === t.id}
                          style={resultButtonStyle('#00ff00', false) as React.CSSProperties}
                          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#00ff00'; e.currentTarget.style.color = 'var(--bg-base)'; }}
                          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#00ff00'; }}
                        >
                          <CheckCircle size={12} /> WIN
                        </button>
                        <button 
                          onClick={() => handleSetResult(t.id, 'LOSS')}
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
            </tbody>
          </table>
      </div>
    </div>
  );
}
