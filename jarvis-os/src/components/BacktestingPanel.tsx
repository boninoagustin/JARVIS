import { useState, useRef, useCallback } from 'react';
import { Upload, BarChart2, TrendingUp, BookOpen, Play, Trash2, FileText, Wand2 } from 'lucide-react';
import { useToast } from './Toast';
import { parseCSV, runBacktest } from '../services/backtestEngine';
import type { BacktestTrade, BacktestResult } from '../services/backtestEngine';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface UploadedFile {
  name: string;
  tf: string;
  lines: string[];
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
    entryTrigger: 'CHOCH' | 'OTE' | 'BOTH';
  };
}

export default function BacktestingPanel() {
  const [ticker, setTicker] = useState('BTCUSD');
  const [minBuyPoints, setMinBuyPoints] = useState(5);
  const [minSellPoints, setMinSellPoints] = useState(5);
  const [slBufferPercent, setSlBufferPercent] = useState(0.1);
  const [fixedRR, setFixedRR] = useState(2.0);
  const [oteEntryPercent, setOteEntryPercent] = useState(50);
  const [entryTrigger, setEntryTrigger] = useState<'CHOCH' | 'OTE' | 'BOTH'>('OTE');
  const [riskUsd, setRiskUsd] = useState(50);
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

  const TF_ORDER: Record<string, number> = { '240': 0, '60': 1, '15': 2, '3': 3 };
  const TF_LABEL: Record<string, string> = { '240': '4H', '60': '1H', '15': '15M', '3': '3M' };
  const TF_COLOR: Record<string, string> = { '240': '#7c4dff', '60': '#0088ff', '15': 'var(--accent-gold)', '3': 'var(--accent-red)' };

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
          return [...filtered, { name: file.name, tf: detectedTF, lines, lineCount: lines.length }]
            .sort((a, b) => (TF_ORDER[a.tf] ?? 99) - (TF_ORDER[b.tf] ?? 99));
        });
        toast(`✅ ${TF_LABEL[detectedTF] || detectedTF}: ${lines.length} eventos cargados`, 'success');
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  }, [toast]);

  const handleRun = useCallback(() => {
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    setIsRunning(true); setProgress(0); setTrades([]); setResult(null);

    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));

    // Run in next tick to allow UI update
    setTimeout(() => {
      const res = runBacktest(logs, { ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger }, (pct, currentTrades) => {
        setProgress(pct);
        setTrades([...currentTrades]);
      });
      setResult(res);
      setTrades(res.trades);
      setProgress(100);
      setIsRunning(false);

      // Save to history
      const closed = res.trades.filter(t => t.result && t.result !== 'TIMEOUT');
      const wins = closed.filter(t => t.result === 'WIN').length;
      const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
      const pnl = closed.reduce((acc, t) => acc + (t.pnl || 0), 0).toFixed(2);
      const session: SessionHistory = {
        id: `BT_${Date.now()}`, ticker, date: res.startDate + ' → ' + res.endDate,
        trades: res.trades.length, winRate: wr, pnl, status: 'completed',
        tradeData: res.trades,
        config: { minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger }
      };
      setSessions(prev => {
        const next = [session, ...prev].slice(0, 20);
        localStorage.setItem('bt_sessions', JSON.stringify(next));
        return next;
      });
      setSelectedSession(session.id);
      toast(`✅ Backtest completado: ${res.trades.length} trades detectados`, 'success');
    }, 50);
  }, [uploadedFiles, ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger, toast]);

  const handleOptimize = useCallback(() => {
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    setIsRunning(true); setProgress(0); setTrades([]); setResult(null);

    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));

    const slOptions = [0, 0.05, 0.1, 0.2];
    const rrOptions = [1.5, 2.0, 2.5, 3.0, 4.0];
    const oteOptions = [50, 62, 79];
    const scoreOptions = [5, 8, 12, 15, 20]; // Puntos mínimos simétricos

    const combinations: {sl:number, rr:number, ote:number, score:number, trigger: 'CHOCH' | 'OTE' | 'BOTH'}[] = [];
    for (const sl of slOptions) {
      for (const rr of rrOptions) {
        for (const ote of oteOptions) {
          for (const score of scoreOptions) {
            combinations.push({ sl, rr, ote, score, trigger: entryTrigger });
          }
        }
      }
    }

    let bestResult: BacktestResult | null = null;
    let bestPnl = -Infinity;
    let bestConfig: any = null;

    const processChunk = (startIndex: number) => {
        const chunkSize = 10;
        const endIndex = Math.min(startIndex + chunkSize, combinations.length);
        
        for (let i = startIndex; i < endIndex; i++) {
            const c = combinations[i];
            const config = { ticker, minBuyPoints: c.score, minSellPoints: c.score, slBufferPercent: c.sl, fixedRR: c.rr, oteEntryPercent: c.ote, entryTrigger: c.trigger };
            const res = runBacktest(logs, config);
            
            const closed = res.trades.filter(t => t.result && t.result !== 'TIMEOUT');
            const pnl = closed.reduce((acc, t) => acc + (t.pnl || 0), 0);
            
            if (pnl > bestPnl) {
                bestPnl = pnl;
                bestResult = res;
                bestConfig = config;
            }
        }
        
        setProgress(Math.floor((endIndex / combinations.length) * 100));
        
        if (endIndex < combinations.length) {
            setTimeout(() => processChunk(endIndex), 20);
        } else if (bestResult && bestConfig) {
            setResult(bestResult);
            setTrades(bestResult.trades);
            setSlBufferPercent(bestConfig.slBufferPercent);
            setFixedRR(bestConfig.fixedRR);
            setOteEntryPercent(bestConfig.oteEntryPercent);
            setEntryTrigger(bestConfig.entryTrigger);
            setMinBuyPoints(bestConfig.minBuyPoints);
            setMinSellPoints(bestConfig.minSellPoints);
            
            const closed = bestResult.trades.filter(t => t.result && t.result !== 'TIMEOUT');
            const wins = closed.filter(t => t.result === 'WIN').length;
            const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
            const pnl = closed.reduce((acc, t) => acc + (t.rMultiple || 0) * riskUsd, 0).toFixed(2);
            const session: SessionHistory = {
              id: `BT_OPT_${Date.now()}`, ticker, date: bestResult.startDate + ' → ' + bestResult.endDate,
              trades: bestResult.trades.length, winRate: wr, pnl, status: 'completed',
              tradeData: bestResult.trades,
              config: bestConfig
            };
            setSessions(prev => {
              const next = [session, ...prev].slice(0, 20);
              localStorage.setItem('bt_sessions', JSON.stringify(next));
              return next;
            });
            setSelectedSession(session.id);
            setIsRunning(false);
            toast(`✅ Optimización finalizada. PnL Máximo: $${bestPnl.toFixed(2)}`, 'success');
        }
    };
    
    setTimeout(() => processChunk(0), 100);
  }, [uploadedFiles, ticker, minBuyPoints, minSellPoints, entryTrigger, toast]);

  // Metrics
  const metrics = (() => {
    const closed = trades.filter(t => t.result && t.result !== 'TIMEOUT');
    const wins = closed.filter(t => t.result === 'WIN').length;
    const losses = closed.filter(t => t.result === 'LOSS').length;
    const be = closed.filter(t => t.result === 'BE').length;
    const open = trades.filter(t => !t.result).length;
    const pnlTotal = closed.reduce((acc, t) => acc + (t.rMultiple || 0) * riskUsd, 0);
    const pnlTp1Total = closed.reduce((acc, t) => acc + (t.rMultipleTp1 || 0) * riskUsd, 0);
    const pnlTp2Total = closed.reduce((acc, t) => acc + (t.rMultipleTp2 || 0) * riskUsd, 0);
    const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '—';
    let maxDD = 0, peak = 0;
    closed.forEach(t => {
      peak += (t.rMultiple || 0) * riskUsd;
      if (peak < maxDD) maxDD = peak;
    });
    return { wins, losses, be, open, wr, pnl: pnlTotal.toFixed(2), pnlTp1: pnlTp1Total.toFixed(2), pnlTp2: pnlTp2Total.toFixed(2), count: closed.length, total: trades.length, maxDD: maxDD.toFixed(2), closed };
  })();

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

  return (
    <div className="animate-fadeIn">
      <div className="panel-header">
        <span><Upload size={14} style={{ marginRight: 8 }} /> BACKTESTING STANDALONE v3.0 {isRunning && <span className="live-dot"></span>}</span>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Motor local — sin servidor requerido</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px', marginBottom: '24px' }}>
        {/* LEFT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* UPLOAD */}
          <div className="panel">
            <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Upload size={18} color="var(--accent-gold)" /> SUBIR LOGS CSV
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>ACTIVO</label>
                <input type="text" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} className="mono" placeholder="BTCUSD"
                  style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>TIPO GATILLO</label>
                <select value={entryTrigger} onChange={e => setEntryTrigger(e.target.value as 'CHOCH' | 'OTE' | 'BOTH')}
                  style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}>
                  <option value="OTE">Fibonacci (OTE)</option>
                  <option value="CHOCH">Ruptura (CHOCH)</option>
                  <option value="BOTH">Ambos</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MIN BUY</label>
                <input type="number" value={minBuyPoints} onChange={e => setMinBuyPoints(Number(e.target.value))} className="mono"
                  style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MIN SELL</label>
                <input type="number" value={minSellPoints} onChange={e => setMinSellPoints(Number(e.target.value))} className="mono"
                  style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', padding: '8px 10px', backgroundColor: 'rgba(255,51,51,0.05)', borderRadius: '4px', border: '1px solid rgba(255,51,51,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-red)', whiteSpace: 'nowrap', fontWeight: 600 }}>🛡️ SL BUF (Rel)</label>
              <input type="range" min="0" max="0.5" step="0.01" value={slBufferPercent} onChange={e => setSlBufferPercent(parseFloat(e.target.value))}
                style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--accent-red)', fontWeight: 700, minWidth: '42px', textAlign: 'right' }}>{slBufferPercent}</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(0,136,255,0.05)', borderRadius: '4px', border: '1px solid rgba(0,136,255,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: '#0088ff', whiteSpace: 'nowrap', fontWeight: 600 }}>🎯 TP2 R:R</label>
              <input type="range" min="1" max="5" step="0.1" value={fixedRR} onChange={e => setFixedRR(parseFloat(e.target.value))}
                style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: '0.75rem', color: '#0088ff', fontWeight: 700, minWidth: '42px', textAlign: 'right' }}>{fixedRR}x</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(255,170,0,0.05)', borderRadius: '4px', border: '1px solid rgba(255,170,0,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-gold)', whiteSpace: 'nowrap', fontWeight: 600 }}>📉 OTE ENTRY</label>
              <input type="range" min="10" max="90" step="1" value={oteEntryPercent} onChange={e => setOteEntryPercent(parseFloat(e.target.value))}
                style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--accent-gold)', fontWeight: 700, minWidth: '42px', textAlign: 'right' }}>{oteEntryPercent}%</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(32,191,107,0.05)', borderRadius: '4px', border: '1px solid rgba(32,191,107,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-green)', whiteSpace: 'nowrap', fontWeight: 600 }}>💵 RIESGO (USD)</label>
              <input type="number" min="1" step="1" value={riskUsd} onChange={e => setRiskUsd(parseFloat(e.target.value) || 0)}
                style={{ flex: 1, padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', textAlign: 'right' }} />
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
                Auto-detecta TF por contenido (3M, 15M, 1H, 4H)
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
              <button type="button" onClick={handleRun} disabled={uploadedFiles.length === 0 || isRunning}
                style={{ flex: 1, padding: '10px', backgroundColor: uploadedFiles.length > 0 && !isRunning ? '#7c4dff' : 'var(--bg-secondary)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: uploadedFiles.length > 0 && !isRunning ? 'pointer' : 'not-allowed', opacity: uploadedFiles.length > 0 ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <Play size={14} /> SIMULAR
              </button>
              <button type="button" onClick={handleOptimize} disabled={uploadedFiles.length === 0 || isRunning}
                style={{ flex: 1, padding: '10px', backgroundColor: uploadedFiles.length > 0 && !isRunning ? 'var(--accent-gold)' : 'var(--bg-secondary)', color: 'black', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: uploadedFiles.length > 0 && !isRunning ? 'pointer' : 'not-allowed', opacity: uploadedFiles.length > 0 ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <Wand2 size={14} /> OPTIMIZAR
              </button>
              {uploadedFiles.length > 0 && !isRunning && (
                <button type="button" onClick={() => { setUploadedFiles([]); setTrades([]); setResult(null); setProgress(0); }}
                  style={{ padding: '10px 14px', backgroundColor: 'transparent', color: 'var(--text-tertiary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer' }}>
                  <Trash2 size={14} />
                </button>
              )}
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

          {/* METRICS */}
          <div className="panel">
            <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <BarChart2 size={18} color="var(--accent-gold)" /> MÉTRICAS
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px' }}>
              {[
                { label: 'WIN RATE', value: `${metrics.wr}%`, color: 'var(--accent-gold)' },
                { label: 'PNL (TP1)', value: `${metrics.pnlTp1}%`, color: parseFloat(metrics.pnlTp1) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' },
                { label: 'PNL (TP2)', value: `${metrics.pnlTp2}%`, color: parseFloat(metrics.pnlTp2) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' },
                { label: 'TRADES', value: `${metrics.total}`, color: 'var(--text-primary)' },
              ].map(m => (
                <div key={m.label} style={{ textAlign: 'center', padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{m.label}</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 700, color: m.color }}>{m.value}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '6px', marginTop: '8px' }}>
              {[
                { label: 'WINS', value: metrics.wins, color: 'var(--accent-green)' },
                { label: 'LOSSES', value: metrics.losses, color: 'var(--accent-red)' },
                { label: 'BE', value: metrics.be, color: 'var(--accent-gold)' },
                { label: 'OPEN', value: metrics.open, color: 'var(--text-tertiary)' },
              ].map(m => (
                <div key={m.label} style={{ textAlign: 'center', padding: '6px', fontSize: '0.7rem' }}>
                  <span style={{ color: m.color, fontWeight: 700 }}>{m.value}</span> <span style={{ color: 'var(--text-tertiary)' }}>{m.label}</span>
                </div>
              ))}
            </div>
            {result && (
              <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '8px', textAlign: 'center' }}>
                {result.processedEvents.toLocaleString()} eventos procesados | {result.startDate} → {result.endDate}
              </div>
            )}
            
            {/* EQUITY CURVE */}
            {metrics.closed.length > 0 && (
              <div style={{ marginTop: '24px', height: '200px', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '16px 16px 16px 0' }}>
                <h4 style={{ marginLeft: '16px', marginBottom: '12px', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>CURVA DE CAPITAL (EQUITY CURVE)</h4>
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
            )}
            
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* TRADES TABLE */}
          <div className="panel" style={{ flex: 1 }}>
            <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <TrendingUp size={18} color="var(--accent-gold)" /> TRADES DETECTADOS {isRunning && <span className="live-dot"></span>}
              </span>
              {trades.length > 0 && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', fontWeight: 400 }}>
                  {trades.length} total
                </span>
              )}
            </h3>
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {trades.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>
                  {isRunning ? 'Procesando logs...' : 'Subí logs y hacé click en REPRODUCIR'}
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>FECHA</th><th>DIR</th><th>PTS</th><th>ENTRADA</th><th>TP1</th><th>SL</th><th>RESULTADO</th><th>PNL (TP1)</th><th>PNL (TP2)</th><th>DUR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map(t => (
                      <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setShowLog(!showLog)}>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{new Date(t.timestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                        <td style={{ color: t.direction === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 700 }}>{t.direction}</td>
                        <td style={{ color: t.points >= 8 ? 'var(--accent-gold)' : 'var(--text-secondary)' }}>{t.points}</td>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{t.entryPrice.toFixed(2)}</td>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{t.tp1Price.toFixed(2)}</td>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{t.slPrice.toFixed(2)}</td>
                        <td style={{ color: resultColor(t.result), fontWeight: 700 }}>{t.result || 'OPEN'}</td>
                        <td className="mono" style={{ color: (t.rMultipleTp1 || 0) > 0 ? 'var(--accent-green)' : (t.rMultipleTp1 || 0) < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)', fontSize: '0.7rem' }}>
                          {t.rMultipleTp1 !== undefined ? `${(t.rMultipleTp1 * riskUsd) >= 0 ? '+$' : '-$'}${Math.abs(t.rMultipleTp1 * riskUsd).toFixed(2)}` : '—'}
                        </td>
                        <td className="mono" style={{ color: (t.rMultipleTp2 || 0) > 0 ? 'var(--accent-green)' : (t.rMultipleTp2 || 0) < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)', fontSize: '0.7rem' }}>
                          {t.rMultipleTp2 !== undefined ? `${(t.rMultipleTp2 * riskUsd) >= 0 ? '+$' : '-$'}${Math.abs(t.rMultipleTp2 * riskUsd).toFixed(2)}` : '—'}
                        </td>
                        <td className="mono" style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
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
              <BookOpen size={18} color="var(--accent-gold)" /> HISTORIAL DE SESIONES
            </h3>
            {sessions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                Sin sesiones previas
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '10px' }}>
                {sessions.map(s => (
                  <div key={s.id}
                    style={{ minWidth: '180px', padding: '12px', cursor: 'pointer', backgroundColor: selectedSession === s.id ? 'rgba(255,170,0,0.1)' : 'var(--bg-base)', border: `1px solid ${selectedSession === s.id ? 'var(--accent-gold)' : 'var(--border-color)'}`, borderRadius: '4px', flexShrink: 0, position: 'relative' }}>
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
                        }
                      }
                    }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{s.ticker}</div>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{s.date}</div>
                      <div style={{ fontSize: '0.7rem', marginTop: '4px' }}>
                        <span style={{ color: 'var(--accent-gold)' }}>{s.winRate}% WR</span>
                        <span style={{ color: 'var(--text-tertiary)', margin: '0 4px' }}>|</span>
                        <span style={{ color: parseFloat(s.pnl) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{s.pnl}%</span>
                      </div>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{s.trades} trades</div>
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
                    }} style={{ position: 'absolute', top: '6px', right: '6px', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.7rem', padding: '2px 4px', borderRadius: '2px', lineHeight: 1 }}
                    title="Eliminar sesión">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
