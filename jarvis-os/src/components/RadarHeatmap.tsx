import { useEffect, useState } from 'react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { db } from '../firebase';
import { Activity, Zap, Navigation, AlertTriangle } from 'lucide-react';

interface RadarState {
  id: string;
  marketBias: { '240': string, '60': string, '15': string, '3': string };
  scoreBuy: { points: number };
  scoreSell: { points: number };
  zones: any[];
  lastPrice?: number;
  nextZones?: { dir: string, top: number, btm: number, medal: string, tf: string, score: number }[];
}

const getIcon = (dir: string) => {
  if (dir === 'BUY') return <span className="status-buy">BUY 🟢</span>;
  if (dir === 'SELL') return <span className="status-sell">SELL 🔴</span>;
  return <span className="status-neutral">NEUT ⚪</span>;
};

const SkeletonRow = () => (
  <tr>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
    <td><div className="skeleton skeleton-row" /></td>
  </tr>
);

export default function RadarHeatmap() {
  const [states, setStates] = useState<RadarState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, 'radar_states'));
    const unsubscribe = onSnapshot(q, 
      (snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as RadarState));
        setStates(data);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('[Radar] Error Firestore:', err);
        setError('Error de conexión con Firebase. Verificá tu conexión.');
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  return (
    <div>
      <div className="panel-header">
        <span><Activity size={14} style={{ marginRight: 8 }} /> MATRIZ DE ALINEACIÓN CUANTITATIVA</span>
        <span className="live-dot"></span>
      </div>
      
      <div className="panel" style={{ overflowX: 'auto' }}>
        {error ? (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            <AlertTriangle size={32} />
            <span>{error}</span>
          </div>
        ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>ACTIVO</th>
              <th>PRECIO</th>
              <th>4H (MACRO)</th>
              <th>1H (TREND)</th>
              <th>15M (MICRO)</th>
              <th>GATILLO (3M)</th>
              <th>PUNTOS COMPRA</th>
              <th>PUNTOS VENTA</th>
              <th>TERMÓMETRO</th>
              <th style={{ minWidth: '180px' }}>PRÓXIMAS ZONAS</th>
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
              const nextZones = asset.nextZones || [];
              
              return (
                <tr key={asset.id}>
                  <td style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{asset.id}</td>
                  <td className="mono">{asset.lastPrice?.toFixed(5) || 'N/A'}</td>
                  <td>{getIcon(asset.marketBias?.['240'])}</td>
                  <td>{getIcon(asset.marketBias?.['60'])}</td>
                  <td>{getIcon(asset.marketBias?.['15'])}</td>
                  <td>{getIcon(asset.marketBias?.['3'])}</td>
                  <td className="text-green">{buyPoints} / 8</td>
                  <td className="text-red">{sellPoints} / 8</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ 
                        width: '100%', height: '6px', backgroundColor: 'var(--border-color)',
                        borderRadius: '3px', overflow: 'hidden'
                      }}>
                        <div style={{ 
                          width: `${Math.min(100, (maxPoints / 8) * 100)}%`, height: '100%', 
                          backgroundColor: isCritical ? 'var(--accent-red)' : isHot ? 'var(--accent-gold)' : 'var(--status-neutral)',
                          transition: 'width 0.3s ease, background-color 0.3s ease'
                        }}></div>
                      </div>
                      {isCritical && <Zap size={14} color="var(--accent-red)" className="live-dot" />}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {nextZones.length > 0 ? nextZones.slice(0, 2).map((z, i) => {
                        const tfMap: Record<string, string> = { '3': '3M', '15': '15M', '60': '1H', '240': '4H' };
                        return (
                          <div key={i} style={{ 
                            display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem',
                            color: z.dir === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)', opacity: 0.85
                          }}>
                            <Navigation size={10} style={{ transform: z.dir === 'BUY' ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
                            <span className="mono">{z.btm?.toFixed(5)}-{z.top?.toFixed(5)}</span>
                            <span style={{ padding: '1px 4px', borderRadius: '3px', fontSize: '0.65rem',
                              backgroundColor: 'rgba(255,170,0,0.1)', color: 'var(--accent-gold)' }}>{z.medal} {tfMap[z.tf] || z.tf}</span>
                          </div>
                        );
                      }) : (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && states.length === 0 && (
              <tr>
                <td colSpan={10} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-tertiary)' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    <Activity size={24} opacity={0.3} />
                    <span>Esperando datos del Radar...</span>
                    <span style={{ fontSize: '0.75rem' }}>Asegurate de tener TradingView abierto con SMC Master activo.</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>
    </div>
  );
}
