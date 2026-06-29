import { useEffect, useState } from 'react';
import { collection, query, getDocs, orderBy, limit, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Activity, Zap, Crosshair, AlertTriangle, Sparkles, TrendingUp, TrendingDown, CheckCircle, XCircle, MinusCircle } from 'lucide-react';
import { useToast } from './Toast';

interface ImpulseLeg {
  dir: 'BUY' | 'SELL';
  origin: number;
  extreme: number;
  oteScored?: boolean;
  isValidated?: boolean;
}

interface RadarState {
  id: string;
  marketBias: { '240': string, '60': string, '15': string, '3': string };
  scoreBuy: { points: number };
  scoreSell: { points: number };
  zones: any[];
  nextZones?: any[];
  lastPrice?: number;
  activeImpulseBuy?: ImpulseLeg | null;
  activeImpulseSell?: ImpulseLeg | null;
  lastGatillo?: { dir: 'BUY' | 'SELL'; price: number; time: number; type: string; status: string; tf?: string; };
}

/** Calcula el precio del 50% OTE (Fibonacci) del impulse leg */
function getOte50(leg: ImpulseLeg): number {
  const range = Math.abs(leg.extreme - leg.origin);
  return leg.dir === 'BUY'
    ? leg.extreme - range * 0.50
    : leg.extreme + range * 0.50;
}

/** Cantidad de decimales según activo */
function getDecimals(ticker: string): number {
  if (/BTC|ETH|US30|NAS/i.test(ticker)) return 2;
  if (/JPY/i.test(ticker)) return 3;
  return 5;
}

const getIcon = (dir: string) => {
  if (dir === 'BUY') return <span className="status-buy">🟢</span>;
  if (dir === 'SELL') return <span className="status-sell">🔴</span>;
  return <span className="status-neutral" style={{ opacity: 0.5 }}>⚪</span>;
};

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

const getTradeRR = (t: TradeLog): number => {
  if (t.result === 'LOSS') {
    return t.rMultiple !== undefined && t.rMultiple !== null && t.rMultiple < 0 ? t.rMultiple : -1;
  }
  if (t.result === 'BREAKEVEN') {
    return t.rMultiple !== undefined && t.rMultiple !== null ? t.rMultiple : 0;
  }
  if (t.result === 'WIN') {
    if (t.rMultiple !== undefined && t.rMultiple !== null && t.rMultiple > 0) {
      return t.rMultiple;
    }
    if (t.entryPrice && t.slPrice) {
      const risk = Math.abs(t.entryPrice - t.slPrice);
      if (risk > 0) {
        let targetPrice: number | undefined;
        if (t.tp2Hit && t.tp2Price) targetPrice = t.tp2Price;
        else if (t.tp1Hit && t.tp1Price) targetPrice = t.tp1Price;
        else if (t.tp1Price) targetPrice = t.tp1Price;
        else if (t.tp2Price) targetPrice = t.tp2Price;
        
        if (targetPrice) {
          const reward = Math.abs(targetPrice - t.entryPrice);
          return Number((reward / risk).toFixed(2));
        }
      }
    }
    return 1;
  }
  return 0;
};

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

const resultButtonStyle = (color: string, isActive: boolean) => ({
  display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px',
  fontSize: '0.75rem', fontWeight: 600, fontFamily: 'var(--font-mono)',
  border: `1px solid ${color}`, borderRadius: '4px', cursor: 'pointer', transition: 'all 0.2s ease',
  backgroundColor: isActive ? color : 'transparent', color: isActive ? 'var(--bg-base)' : color, opacity: isActive ? 1 : 0.7,
});

const getEntryTypeBadge = (t: TradeLog) => {
  const events = t.events || [];
  const hasBos = events.some(e => e.includes('BOS🔨'));
  const hasChoch = events.some(e => e.includes('CHoCH🚀'));
  const hasOte = events.includes('🎯_OTE_Retracement_3M');

  if (t.isChochEntry) {
    if (hasBos) return { label: 'BOS Directo', color: '#7c4dff', bg: 'rgba(124,77,255,0.1)' };
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

const SkeletonRow = () => (
  <tr>
    {Array.from({ length: 11 }, (_, i) => (
      <td key={i}><div className="skeleton skeleton-row" /></td>
    ))}
  </tr>
);

export default function RadarHeatmap() {
  const [states, setStates] = useState<RadarState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [updating, setUpdating] = useState<string | null>(null);
  const [selectedTradeForModal, setSelectedTradeForModal] = useState<TradeLog | null>(null);
  const [modalResult, setModalResult] = useState<'WIN' | 'LOSS' | 'BREAKEVEN' | 'SKIP' | ''>('');
  const [modalRMultiple, setModalRMultiple] = useState<string>('');
  const { toast } = useToast();

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval>;
    
    const fetchRadarStates = async () => {
      try {
        const q = query(collection(db, 'radar_states'));
        const snapshot = await getDocs(q);
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as RadarState));
        setStates(data);
        setLoading(false);
        setError(null);
      } catch (err) {
        console.error('[Radar] Error fetching Firestore data:', err);
        setError('Error de conexión con Firebase. Verificá tu conexión.');
        setLoading(false);
      }
    };

    setLoading(true);
    fetchRadarStates();
    
    // Polling cada 30 segundos (Estrategia de Caché de Lectura)
    intervalId = setInterval(fetchRadarStates, 30000);

    return () => clearInterval(intervalId);
  }, []);

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

  return (
    <div className="animate-fadeIn">
      {/* Estilos CSS embebidos para animaciones premium del radar */}
      <style>{`
        @keyframes alignBuyPulse {
          0% { background-color: rgba(0, 255, 0, 0.01); }
          50% { background-color: rgba(0, 255, 0, 0.05); }
          100% { background-color: rgba(0, 255, 0, 0.01); }
        }
        @keyframes alignSellPulse {
          0% { background-color: rgba(255, 51, 51, 0.01); }
          50% { background-color: rgba(255, 51, 51, 0.05); }
          100% { background-color: rgba(255, 51, 51, 0.01); }
        }
        @keyframes thunderPulse {
          0% { transform: scale(1); opacity: 0.8; filter: drop-shadow(0 0 2px rgba(255,170,0,0.5)); }
          50% { transform: scale(1.15); opacity: 1; filter: drop-shadow(0 0 6px rgba(255,170,0,0.9)); }
          100% { transform: scale(1); opacity: 0.8; filter: drop-shadow(0 0 2px rgba(255,170,0,0.5)); }
        }
        .row-aligned-buy {
          animation: alignBuyPulse 3s infinite ease-in-out;
        }
        .row-aligned-sell {
          animation: alignSellPulse 3s infinite ease-in-out;
        }
        .thunder-animate {
          animation: thunderPulse 1.5s infinite ease-in-out;
        }
        .confluence-pill {
          padding: 2px 6px;
          border-radius: 4px;
          font-family: var(--font-mono);
          font-weight: 700;
          font-size: 0.75rem;
          display: inline-block;
        }
      `}</style>

      <div className="panel-header">
        <span><Activity size={14} style={{ marginRight: 8 }} /> MATRIZ DE ALINEACIÓN CUANTITATIVA (VIVO)</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Filtro de Confluencia Inteligente</span>
          <span className="live-dot"></span>
        </div>
      </div>
      
      <div className="panel" style={{ overflowX: 'auto', padding: 0 }}>
        {error ? (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            <AlertTriangle size={32} />
            <span>{error}</span>
          </div>
        ) : (
        <table className="data-table" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: '16px' }}>ACTIVO</th>
              <th>PRECIO</th>
              <th>4H</th>
              <th>1H</th>
              <th>15M</th>
              <th>GATILLO</th>
              <th>PUNTOS B</th>
              <th>PUNTOS S</th>
              <th>TERMÓMETRO</th>
              <th style={{ minWidth: '170px' }}>OTE</th>
              <th style={{ minWidth: '160px', paddingRight: '16px' }}>ÚLT. GATILLO</th>
            </tr>
          </thead>
          <tbody>
            {loading && states.length === 0 ? (
              <><SkeletonRow /><SkeletonRow /><SkeletonRow /><SkeletonRow /></>
            ) : states.map(asset => {
              const buyPoints = asset.scoreBuy?.points || 0;
              const sellPoints = asset.scoreSell?.points || 0;
              const maxPoints = Math.max(buyPoints, sellPoints);
              const isHot = maxPoints >= 5;
              const isCritical = maxPoints >= 8;
              const decimals = getDecimals(asset.id);

              // ─── ALINEACIÓN TEMPORAL PERFECTA ───
              const bias4H = asset.marketBias?.['240'];
              const bias1H = asset.marketBias?.['60'];
              const bias15M = asset.marketBias?.['15'];
              const bias3M = asset.marketBias?.['3'];
              
              const isAlignedBuy = bias4H === 'BUY' && bias1H === 'BUY' && bias15M === 'BUY' && bias3M === 'BUY';
              const isAlignedSell = bias4H === 'SELL' && bias1H === 'SELL' && bias15M === 'SELL' && bias3M === 'SELL';
              const isPerfectlyAligned = isAlignedBuy || isAlignedSell;

              const rowClass = isAlignedBuy ? 'row-aligned-buy' : isAlignedSell ? 'row-aligned-sell' : '';

              // Recopilar OTE 50% de los impulse legs activos
              const oteLevels: { dir: 'BUY' | 'SELL'; price: number; scored: boolean }[] = [];
              if (asset.activeImpulseBuy) {
                oteLevels.push({
                  dir: 'BUY',
                  price: getOte50(asset.activeImpulseBuy),
                  scored: !!asset.activeImpulseBuy.oteScored,
                });
              }
              if (asset.activeImpulseSell) {
                oteLevels.push({
                  dir: 'SELL',
                  price: getOte50(asset.activeImpulseSell),
                  scored: !!asset.activeImpulseSell.oteScored,
                });
              }
              
              return (
                <tr key={asset.id} className={rowClass} style={{ transition: 'all 0.3s ease' }}>
                  <td style={{ paddingLeft: '16px', fontWeight: 700 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '100%' }}>
                      <span style={{ color: isPerfectlyAligned ? 'var(--accent-gold)' : 'var(--text-primary)' }}>
                        {asset.id}
                      </span>
                      {isPerfectlyAligned && (
                        <span 
                          title={`¡CONFLUENCIA PERFECTA 100% ${isAlignedBuy ? 'ALCISTA' : 'BAJISTA'}!`}
                          className="thunder-animate"
                          style={{ display: 'flex', alignItems: 'center' }}
                        >
                          <Zap size={13} fill="var(--accent-gold)" color="var(--accent-gold)" />
                        </span>
                      )}
                    </div>
                  </td>

                  {/* PRECIO (Con sutil color si está alineado) */}
                  <td className="mono" style={{ 
                    fontWeight: 600, 
                    color: isAlignedBuy ? 'var(--accent-green)' : isAlignedSell ? 'var(--accent-red)' : 'var(--text-primary)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {asset.lastPrice?.toFixed(decimals) || 'N/A'}
                      {isAlignedBuy && <TrendingUp size={12} color="var(--accent-green)" />}
                      {isAlignedSell && <TrendingDown size={12} color="var(--accent-red)" />}
                    </div>
                  </td>

                  {/* TEMPORALIDADES */}
                  <td>{getIcon(bias4H)}</td>
                  <td>{getIcon(bias1H)}</td>
                  <td>{getIcon(bias15M)}</td>
                  <td>{getIcon(bias3M)}</td>

                  {/* PUNTOS */}
                  <td>
                    <span className="confluence-pill" style={{ 
                      backgroundColor: buyPoints >= 5 ? 'rgba(0, 255, 0, 0.15)' : 'transparent',
                      color: buyPoints >= 5 ? 'var(--accent-green)' : 'var(--text-secondary)'
                    }}>
                      {buyPoints}
                    </span>
                  </td>
                  <td>
                    <span className="confluence-pill" style={{ 
                      backgroundColor: sellPoints >= 5 ? 'rgba(255, 51, 51, 0.15)' : 'transparent',
                      color: sellPoints >= 5 ? 'var(--accent-red)' : 'var(--text-secondary)'
                    }}>
                      {sellPoints}
                    </span>
                  </td>

                  {/* TERMÓMETRO */}
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ 
                        width: '70px', height: '6px', backgroundColor: 'var(--border-color)',
                        borderRadius: '3px', overflow: 'hidden'
                      }}>
                        <div style={{ 
                          width: `${Math.min(100, (maxPoints / 8) * 100)}%`, height: '100%', 
                          backgroundColor: isCritical ? 'var(--accent-red)' : isHot ? 'var(--accent-gold)' : 'var(--status-neutral)',
                          transition: 'width 0.3s ease, background-color 0.3s ease'
                        }}></div>
                      </div>
                      {isPerfectlyAligned ? (
                        <Sparkles size={12} color="var(--accent-gold)" className="live-dot" />
                      ) : isCritical ? (
                        <Zap size={12} color="var(--accent-red)" className="live-dot" />
                      ) : null}
                    </div>
                  </td>

                  {/* RETROCESO OTE 50% */}
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {oteLevels.length > 0 ? oteLevels.map((ote, i) => (
                        <div key={i} style={{ 
                          display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem',
                          color: ote.dir === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)',
                          opacity: ote.scored ? 0.45 : 0.9
                        }}>
                          <Crosshair size={10} />
                          <span className="mono">{ote.price.toFixed(decimals)}</span>
                          <span style={{ 
                            padding: '1px 4px', borderRadius: '3px', fontSize: '0.65rem',
                            backgroundColor: ote.scored 
                              ? 'rgba(100,100,100,0.15)' 
                              : ote.dir === 'BUY' ? 'rgba(0,200,100,0.1)' : 'rgba(255,60,60,0.1)',
                            color: ote.scored ? 'var(--text-tertiary)' : 'var(--accent-gold)',
                            fontWeight: 700
                          }}>
                            {ote.dir === 'BUY' ? '🟢' : '🔴'} {ote.scored ? 'TOCADO' : 'OTE'}
                          </span>
                        </div>
                      )) : (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </div>
                  </td>

                  {/* ÚLTIMO GATILLO (Con caja estilizada institucional) */}
                  <td style={{ paddingRight: '16px' }}>
                    {asset.lastGatillo ? (
                      <div style={{ 
                        display: 'flex', 
                        flexDirection: 'column', 
                        gap: '3px', 
                        fontSize: '0.7rem',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        border: `1px solid ${asset.lastGatillo.dir === 'BUY' ? 'rgba(0,255,0,0.15)' : 'rgba(255,51,51,0.15)'}`,
                        backgroundColor: asset.lastGatillo.dir === 'BUY' ? 'rgba(0,255,0,0.03)' : 'rgba(255,51,51,0.03)',
                        width: 'fit-content'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span style={{ 
                            fontWeight: 700,
                            color: asset.lastGatillo.dir === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)' 
                          }}>
                            {asset.lastGatillo.dir === 'BUY' ? '🟢 BUY' : '🔴 SELL'}
                            {asset.lastGatillo.tf ? ` (${asset.lastGatillo.tf})` : ''}
                          </span>
                          <span className="mono" style={{ color: 'var(--text-tertiary)', fontSize: '0.65rem' }}>
                            {Math.round((Date.now() - asset.lastGatillo.time) / 60000)}m ago
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span className="mono" style={{ color: 'var(--text-secondary)', fontSize: '0.65rem' }}>
                            {asset.lastGatillo.price.toFixed(decimals)}
                          </span>
                          <span style={{ 
                            fontSize: '0.6rem', padding: '0px 3px', borderRadius: '2px',
                            backgroundColor: asset.lastGatillo.status === 'ENVIADO' ? 'rgba(0,200,100,0.2)' : 'rgba(255,51,51,0.2)',
                            color: asset.lastGatillo.status === 'ENVIADO' ? 'var(--accent-green)' : 'var(--accent-red)',
                            fontWeight: 600
                          }}>
                            {asset.lastGatillo.status}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && states.length === 0 && (
              <tr>
                <td colSpan={11} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    <Activity size={24} opacity={0.3} />
                    <span style={{ fontWeight: 600 }}>Esperando datos del Radar Cuantitativo...</span>
                    <span style={{ fontSize: '0.75rem' }}>Asegúrate de tener TradingView abierto con el bot activo transmitiendo señales a Firebase.</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      {/* HISTORIAL RECIENTE */}
      <div className="panel" style={{ marginTop: '24px' }}>
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
                  <td>{new Date(t.timestamp).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</td>
                  <td style={{ fontWeight: 700 }}>{t.ticker}</td>
                  <td className={t.direction === 'BUY' ? 'text-green' : 'text-red'} style={{ fontWeight: 700 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {t.direction}
                      {t.tf && (
                        <span style={{ fontSize: '0.65rem', padding: '2px 6px', backgroundColor: 'rgba(255,255,255,0.1)', color: '#ccc', borderRadius: '3px', fontWeight: 600 }}>
                          {t.tf}
                        </span>
                      )}
                    </div>
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
                        {t.entryPrice !== undefined && (
                          <>
                            <span title="Entry" style={{ color: 'var(--text-primary)', opacity: 0.9 }}>📥{t.entryPrice}</span>
                            <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                          </>
                        )}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className={selectedTradeForModal.direction === 'BUY' ? 'text-green' : 'text-red'} style={{ fontWeight: 700 }}>
                      {selectedTradeForModal.direction}
                    </span>
                    {selectedTradeForModal.tf && (
                      <span style={{ fontSize: '0.65rem', padding: '2px 6px', backgroundColor: 'rgba(255,255,255,0.1)', color: '#ccc', borderRadius: '3px', fontWeight: 600 }}>
                        {selectedTradeForModal.tf}
                      </span>
                    )}
                  </div>
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
