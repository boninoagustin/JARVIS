import { useState, useEffect } from 'react';
import { collection, onSnapshot, query, where, orderBy, limit, addDoc, serverTimestamp, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { Play, Calendar, TrendingUp, BarChart2, BookOpen } from 'lucide-react';
import { useToast } from './Toast';

interface TradeLog {
  id: string;
  ticker: string;
  direction: string;
  grade: string;
  points?: number;
  result?: string;
  timestamp: number;
  mode?: string;
  sessionId?: string;
  pnl?: number;
  entryPrice?: number;
  tp1Price?: number;
  slPrice?: number;
}

interface Session {
    id: string;
    ticker: string;
    startDate: string;
    timestamp: number;
    status: string;
    configNote?: string;
}

export default function BacktestingPanel() {
  const [ticker, setTicker] = useState('EURUSD');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [configNote, setConfigNote] = useState('');
  const [minBuyPoints, setMinBuyPoints] = useState(5);
  const [minSellPoints, setMinSellPoints] = useState(5);
  const [isRunning, setIsRunning] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const { toast } = useToast();

  useEffect(() => {
    // 1. Escuchar estado de la sesión activa
    const unsubStatus = onSnapshot(doc(db, 'app_settings', 'backtesting_status'), (snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.data();
            setIsRunning(data.active || false);
            setCurrentSessionId(data.sessionId || null);
            if (data.active) {
                setMinBuyPoints(data.minBuyPoints || 5);
                setMinSellPoints(data.minSellPoints || 5);
            }
        }
    });

    // 2. Escuchar sesiones históricas
    const qSessions = query(collection(db, 'backtesting_sessions'), orderBy('timestamp', 'desc'), limit(10));
    const unsubSessions = onSnapshot(qSessions, (snapshot) => {
        setSessions(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Session)));
    });

    return () => {
        unsubStatus();
        unsubSessions();
    };
  }, []);

  useEffect(() => {
    // 3. Escuchar trades de la sesión actual o todos los de backtesting si no hay activa
    if (!currentSessionId) {
        const q = query(collection(db, 'trade_journal'), where('mode', '==', 'backtesting'), orderBy('timestamp', 'desc'), limit(50));
        return onSnapshot(q, (snapshot) => {
            setTrades(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TradeLog)));
        });
    } else {
        const q = query(collection(db, 'trade_journal'), where('sessionId', '==', currentSessionId), orderBy('timestamp', 'desc'));
        return onSnapshot(q, (snapshot) => {
            setTrades(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TradeLog)));
        });
    }
  }, [currentSessionId]);

  const handleStart = async () => {
    try {
      await addDoc(collection(db, 'app_commands'), {
        command: 'start_backtesting',
        params: { ticker, startDate, configNote, minBuyPoints, minSellPoints },
        status: 'pending',
        timestamp: serverTimestamp()
      });
      toast(`Iniciando sesión para ${ticker}...`, 'info');
    } catch (e) {
      console.error('[Backtesting] Error starting:', e);
      toast('Error al iniciar', 'error');
    }
  };

  const handleStop = async () => {
    try {
      await addDoc(collection(db, 'app_commands'), {
        command: 'stop_backtesting',
        status: 'pending',
        timestamp: serverTimestamp()
      });
      toast('Sesión finalizada', 'success');
    } catch (e) {
      toast('Error al detener', 'error');
    }
  };

  const calculateMetrics = (logs: TradeLog[]) => {
    const closed = logs.filter(t => t.result && t.result !== 'SKIP');
    const wins = closed.filter(t => t.result === 'WIN').length;
    const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
    const totalPnl = closed.reduce((acc, t) => acc + (t.pnl || 0), 0).toFixed(2);
    return { wr, totalPnl, count: closed.length };
  };

  const metrics = calculateMetrics(trades);

  return (
    <div className="animate-fadeIn">
      <div className="panel-header">
        <span><Play size={14} style={{ marginRight: 8 }} /> MÓDULO DE BACKTESTING v2.0</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Configuración */}
            <div className="panel">
                <h3 style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Calendar size={18} color="var(--accent-gold)" /> NUEVA SESIÓN
                </h3>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                            <label style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '4px' }}>ACTIVO</label>
                            <input 
                                type="text" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
                                placeholder="BTCUSD..." className="mono"
                                style={{ width: '100%', padding: '10px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
                            />
                        </div>
                        <div>
                            <label style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '4px' }}>FECHA INICIO</label>
                            <input 
                                type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                                style={{ width: '100%', padding: '10px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                            />
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                            <label style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '4px' }}>MIN PTS COMPRA</label>
                            <input 
                                type="number" value={minBuyPoints} onChange={(e) => setMinBuyPoints(Number(e.target.value))}
                                className="mono"
                                style={{ width: '100%', padding: '10px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
                            />
                        </div>
                        <div>
                            <label style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '4px' }}>MIN PTS VENTA</label>
                            <input 
                                type="number" value={minSellPoints} onChange={(e) => setMinSellPoints(Number(e.target.value))}
                                className="mono"
                                style={{ width: '100%', padding: '10px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
                            />
                        </div>
                    </div>

                    <textarea 
                        placeholder="Nota de configuración (ej: SMC v5.1, Risk 1%, Filter On)"
                        value={configNote} onChange={(e) => setConfigNote(e.target.value)}
                        style={{ width: '100%', height: '80px', padding: '10px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                    />

                    {!isRunning ? (
                        <button type="button" onClick={handleStart} style={{ width: '100%', padding: '12px', backgroundColor: 'var(--accent-gold)', color: 'var(--bg-base)', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: 'pointer' }}>
                            🚀 INICIAR BACKTESTING
                        </button>
                    ) : (
                        <button type="button" onClick={handleStop} style={{ width: '100%', padding: '12px', backgroundColor: 'var(--accent-red)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: 'pointer' }}>
                            🛑 DETENER Y GUARDAR
                        </button>
                    )}
                </div>
            </div>

            {/* Métricas Rápidas */}
            <div className="panel">
                <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <BarChart2 size={18} color="var(--accent-gold)" /> MÉTRICAS SESIÓN
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div style={{ textAlign: 'center', padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>WIN RATE</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent-gold)' }}>{metrics.wr}%</div>
                    </div>
                    <div style={{ textAlign: 'center', padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>PNL ACUM.</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: metrics.totalPnl.startsWith('-') ? 'var(--accent-red)' : 'var(--accent-green)' }}>{metrics.totalPnl}%</div>
                    </div>
                </div>
                <div style={{ marginTop: '10px', fontSize: '0.75rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                    Basado en {metrics.count} trades cerrados
                </div>
            </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Tabla de Trades */}
            <div className="panel" style={{ flex: 1 }}>
                <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <TrendingUp size={18} color="var(--accent-gold)" /> TRADES DETECTADOS {isRunning && <span className="live-dot"></span>}
                </h3>
                <div style={{ maxHeight: '350px', overflowY: 'auto' }}>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>FECHA (SIM)</th>
                                <th>DIR</th>
                                <th>PTS</th>
                                <th>RESULTADO</th>
                                <th>PNL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {trades.map(t => (
                                <tr key={t.id}>
                                    <td className="mono">{new Date(t.timestamp).toLocaleString()}</td>
                                    <td className={t.direction === 'BUY' ? 'text-green' : 'text-red'}>{t.direction}</td>
                                    <td>{t.points}</td>
                                    <td>{t.result || 'OPEN'}</td>
                                    <td className={t.pnl && t.pnl > 0 ? 'text-green' : 'text-red'}>{t.pnl ? `${t.pnl}%` : '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Historial de Sesiones */}
            <div className="panel">
                <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <BookOpen size={18} color="var(--accent-gold)" /> HISTORIAL DE SESIONES
                </h3>
                <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '10px' }}>
                    {sessions.map(s => (
                        <div key={s.id} onClick={() => setCurrentSessionId(s.id)} style={{ 
                            minWidth: '200px', padding: '12px', backgroundColor: currentSessionId === s.id ? 'rgba(255,170,0,0.1)' : 'var(--bg-base)', 
                            border: `1px solid ${currentSessionId === s.id ? 'var(--accent-gold)' : 'var(--border-color)'}`, borderRadius: '4px', cursor: 'pointer' 
                        }}>
                            <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{s.ticker}</div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>{s.startDate}</div>
                            <div style={{ fontSize: '0.75rem', marginTop: '4px', fontStyle: 'italic', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {s.configNote || 'Sin notas'}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
      </div>
    </div>
  );
}
