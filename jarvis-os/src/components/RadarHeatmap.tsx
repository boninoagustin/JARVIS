import { useEffect, useState } from 'react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { db } from '../firebase';
import { Activity, Zap, Crosshair, AlertTriangle } from 'lucide-react';

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
  nextZones?: any[];      // 🆕 Zonas ordenadas por puntaje para el día
  lastPrice?: number;
  activeImpulseBuy?: ImpulseLeg | null;
  activeImpulseSell?: ImpulseLeg | null;
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
  if (dir === 'BUY') return <span className="status-buy">BUY 🟢</span>;
  if (dir === 'SELL') return <span className="status-sell">SELL 🔴</span>;
  return <span className="status-neutral">NEUT ⚪</span>;
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
              <th>PUNTOS C</th>
              <th>PUNTOS V</th>
              <th>TERMÓMETRO</th>
              <th style={{ minWidth: '180px' }}>OTE 50%</th>
              <th style={{ minWidth: '150px' }}>PRÓX. ZONAS</th>
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
                <tr key={asset.id}>
                  <td style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{asset.id}</td>
                  <td className="mono">{asset.lastPrice?.toFixed(decimals) || 'N/A'}</td>
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
                            color: ote.scored ? 'var(--text-tertiary)' : 'var(--accent-gold)'
                          }}>
                            {ote.dir === 'BUY' ? '🟢' : '🔴'} {ote.scored ? 'TOCADO' : 'PENDIENTE'}
                          </span>
                        </div>
                      )) : (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '0.7rem' }}>
                      {(asset.nextZones && asset.nextZones.length > 0) 
                        ? asset.nextZones.slice(0, 3).map((z: any, zi: number) => (
                        <div key={zi} style={{
                          display: 'flex', alignItems: 'center', gap: '4px',
                          color: z.dir === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)',
                          opacity: 0.85
                        }}>
                          <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>
                            {z.tf ? (z.tf === '240' ? '4H' : z.tf === '60' ? '1H' : z.tf === '15' ? '15M' : '3M') : '?'}
                          </span>
                          <span className="mono">{z.btm?.toFixed(decimals)}→{z.top?.toFixed(decimals)}</span>
                          <span style={{
                            fontSize: '0.55rem', padding: '0px 3px', borderRadius: '2px',
                            backgroundColor: z.medal?.includes('Platino') ? 'rgba(142,36,170,0.2)' : 
                                           z.medal?.includes('Oro') ? 'rgba(245,127,23,0.2)' : 'rgba(100,100,100,0.1)',
                            color: 'var(--text-tertiary)'
                          }}>
                            {z.medal?.substring(0, 4) || 'OB'}
                          </span>
                        </div>
                      )) : (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem' }}>—</span>
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
