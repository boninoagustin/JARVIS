import { useState, useEffect, useRef } from 'react';
import { collection, onSnapshot, query, where, orderBy, limit, addDoc, serverTimestamp, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { TrendingUp, BarChart2, BookOpen, Upload } from 'lucide-react';
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
    endDate?: string;
    timestamp: number;
    status: string;
    configNote?: string;
    mode?: string;
    totalEvents?: number;
    processedEvents?: number;
    tfCount?: number;
}

const TF_LABELS = ['3', '15', '60', '240'] as const;

export default function BacktestingPanel() {
  const [ticker, setTicker] = useState('EURUSD');
  const [configNote, setConfigNote] = useState('');
  const [minBuyPoints, setMinBuyPoints] = useState(5);
  const [minSellPoints, setMinSellPoints] = useState(5);
  const [isReplaying, setIsReplaying] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [uploadedLogs, setUploadedLogs] = useState<Map<string, string[]>>(new Map());
  const [uploading, setUploading] = useState(false);
  const fileInputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const { toast } = useToast();

  // Escuchar estado de replay
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'app_settings', 'backtesting_status'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setIsReplaying(data.replaying || false);
        if (data.sessionId) setCurrentSessionId(data.sessionId);
        if (data.replaying) {
          setMinBuyPoints(data.minBuyPoints || 5);
          setMinSellPoints(data.minSellPoints || 5);
        }
      }
    });
    return unsub;
  }, []);

  // Escuchar sesiones históricas
  useEffect(() => {
    const q = query(collection(db, 'backtesting_sessions'), orderBy('timestamp', 'desc'), limit(10));
    const unsub = onSnapshot(q, (snapshot) => {
      setSessions(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Session)));
    });
    return unsub;
  }, []);

  // Escuchar trades
  useEffect(() => {
    if (!currentSessionId) {
      const q = query(collection(db, 'trade_journal'), where('mode', '==', 'backtesting'), orderBy('timestamp', 'desc'), limit(50));
      return onSnapshot(q, (snap) => setTrades(snap.docs.map(d => ({ id: d.id, ...d.data() } as TradeLog))));
    }
    const q = query(collection(db, 'trade_journal'), where('sessionId', '==', currentSessionId), orderBy('timestamp', 'desc'));
    return onSnapshot(q, (snap) => setTrades(snap.docs.map(d => ({ id: d.id, ...d.data() } as TradeLog))));
  }, [currentSessionId]);

  const parseLogFile = (content: string, _tf: string): string[] => {
    return content.split('\n').filter(l => l.trim().length > 0 && l.includes(' | TS: '));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, tf: string) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseLogFile(ev.target?.result as string, tf);
      setUploadedLogs(prev => {
        const next = new Map(prev);
        next.set(tf, parsed);
        return next;
      });
      const tfName = tf === '3' ? '3M' : tf === '15' ? '15M' : tf === '60' ? '1H' : '4H';
      toast(`✅ ${tfName}: ${parsed.length} líneas`, 'success');
    };
    reader.onerror = () => toast(`❌ Error leyendo ${file.name}`, 'error');
    reader.readAsText(file);
  };

  const handleStartReplay = async () => {
    if (uploadedLogs.size === 0) {
      toast('Subí al menos 1 log antes de reproducir', 'error');
      return;
    }
    setUploading(true);
    try {
      const sessionId = `BT_${Date.now()}`;
      const promises = Array.from(uploadedLogs.entries()).map(([tf, lines]) =>
        setDoc(doc(db, 'backtesting_logs', `${sessionId}_${tf}`), {
          sessionId, tf, lines, lineCount: lines.length, createdAt: serverTimestamp()
        })
      );
      await Promise.all(promises);

      await addDoc(collection(db, 'app_commands'), {
        command: 'replay_backtesting',
        params: { sessionId, ticker: ticker || 'EURUSD', configNote, minBuyPoints, minSellPoints, tfs: Array.from(uploadedLogs.keys()) },
        status: 'pending', timestamp: serverTimestamp()
      });

      setCurrentSessionId(sessionId);
      toast(`🚀 Replay lanzado: ${uploadedLogs.size} TFs`, 'success');
      setUploadedLogs(new Map());
    } catch (e: any) {
      toast(`Error: ${e.message}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleStopReplay = async () => {
    try {
      await addDoc(collection(db, 'app_commands'), { command: 'stop_replay', status: 'pending', timestamp: serverTimestamp() });
      toast('Replay detenido', 'success');
    } catch (e) {
      toast('Error al detener', 'error');
    }
  };

  const metrics = (() => {
    const closed = trades.filter(t => t.result && t.result !== 'SKIP');
    const wins = closed.filter(t => t.result === 'WIN').length;
    return {
      wr: closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0',
      pnl: closed.reduce((acc, t) => acc + (t.pnl || 0), 0).toFixed(2),
      count: closed.length
    };
  })();

  return (
    <div className="animate-fadeIn">
      <div className="panel-header">
        <span><Upload size={14} style={{ marginRight: 8 }} /> BACKTESTING POR LOGS v2.0 {isReplaying && <span className="live-dot"></span>}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px', marginBottom: '24px' }}>
        {/* COLUMNA IZQUIERDA */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* SUBIR LOGS */}
          <div className="panel">
            <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Upload size={18} color="var(--accent-gold)" /> SUBIR LOGS PINE EDITOR
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>ACTIVO</label>
                  <input type="text" value={ticker}
                    onChange={(e) => setTicker(e.target.value.toUpperCase())}
                    className="mono" placeholder="EURUSD"
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>NOTA</label>
                  <input type="text" value={configNote}
                    onChange={(e) => setConfigNote(e.target.value)}
                    placeholder="SMC v5.1..."
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MIN PTS COMPRA</label>
                  <input type="number" value={minBuyPoints} onChange={(e) => setMinBuyPoints(Number(e.target.value))}
                    className="mono"
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MIN PTS VENTA</label>
                  <input type="number" value={minSellPoints} onChange={(e) => setMinSellPoints(Number(e.target.value))}
                    className="mono"
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>

              {TF_LABELS.map(tf => (
                <div key={tf} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    minWidth: '36px', fontWeight: 700, fontSize: '0.8rem',
                    color: tf === '3' ? 'var(--accent-red)' : tf === '240' ? '#7c4dff' : 'var(--accent-gold)'
                  }}>
                    {tf === '3' ? '3M' : tf === '15' ? '15M' : tf === '60' ? '1H' : '4H'}
                  </span>
                  <input type="file" accept=".txt,.log,.csv"
                    onChange={(e) => handleFileUpload(e, tf)}
                    disabled={isReplaying || uploading}
                    ref={(el) => { fileInputRefs.current.set(tf, el); }}
                    style={{ flex: 1, padding: '6px', fontSize: '0.7rem', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
                  />
                  {uploadedLogs.has(tf) && (
                    <span style={{ color: 'var(--accent-green)', fontSize: '0.7rem', fontWeight: 600, minWidth: '50px', textAlign: 'right' }}>
                      ✓ {uploadedLogs.get(tf)!.length}
                    </span>
                  )}
                </div>
              ))}

              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                {!isReplaying ? (
                  <button type="button" onClick={handleStartReplay}
                    disabled={uploadedLogs.size === 0 || uploading}
                    style={{ flex: 1, padding: '10px', backgroundColor: uploadedLogs.size > 0 ? '#7c4dff' : 'var(--bg-secondary)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: uploadedLogs.size > 0 ? 'pointer' : 'not-allowed', opacity: uploadedLogs.size > 0 ? 1 : 0.5 }}>
                    ▶ REPRODUCIR {uploadedLogs.size > 0 ? `(${uploadedLogs.size} TFs)` : ''}
                  </button>
                ) : (
                  <button type="button" onClick={handleStopReplay}
                    style={{ flex: 1, padding: '10px', backgroundColor: 'var(--accent-red)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: 'pointer' }}>
                    ⏹ DETENER REPLAY
                  </button>
                )}
                {uploadedLogs.size > 0 && !isReplaying && (
                  <button type="button" onClick={() => setUploadedLogs(new Map())}
                    style={{ padding: '10px 14px', backgroundColor: 'transparent', color: 'var(--text-tertiary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem' }}>
                    Limpiar
                  </button>
                )}
              </div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                📥 Subí logs de 4H, 1H, 15M y 3M. El replay intercala <b>en paralelo</b> por timestamp. Las zonas de TFs altos sincronizan antes que los PINGs de 3M.
              </div>
            </div>
          </div>

          {/* MÉTRICAS */}
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
                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: metrics.pnl.startsWith('-') ? 'var(--accent-red)' : 'var(--accent-green)' }}>{metrics.pnl}%</div>
              </div>
            </div>
            <div style={{ marginTop: '10px', fontSize: '0.75rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>
              {metrics.count} trades cerrados
            </div>
          </div>
        </div>

        {/* COLUMNA DERECHA */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="panel" style={{ flex: 1 }}>
            <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <TrendingUp size={18} color="var(--accent-gold)" /> TRADES DETECTADOS {isReplaying && <span className="live-dot"></span>}
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

          <div className="panel">
            <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <BookOpen size={18} color="var(--accent-gold)" /> HISTORIAL DE SESIONES
            </h3>
            <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '10px' }}>
              {sessions.map(s => (
                <div key={s.id} onClick={() => setCurrentSessionId(s.id)} style={{
                  minWidth: '200px', padding: '12px', cursor: 'pointer',
                  backgroundColor: currentSessionId === s.id ? 'rgba(255,170,0,0.1)' : 'var(--bg-base)',
                  border: `1px solid ${currentSessionId === s.id ? 'var(--accent-gold)' : 'var(--border-color)'}`,
                  borderRadius: '4px'
                }}>
                  <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{s.ticker}</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
                    {s.startDate}{s.endDate && ` → ${s.endDate}`}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: s.status === 'completed' ? 'var(--accent-green)' : s.status === 'running' ? 'var(--accent-gold)' : 'var(--text-tertiary)' }}>
                    {s.status} {s.mode === 'replay' ? '(replay)' : ''}
                  </div>
                  {s.processedEvents !== undefined && (
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{s.processedEvents}/{s.totalEvents || '?'} eventos</div>
                  )}
                  {s.tfCount && <div style={{ fontSize: '0.6rem', color: '#7c4dff' }}>{s.tfCount} TFs</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
