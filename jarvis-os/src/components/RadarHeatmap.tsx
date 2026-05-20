import { useEffect, useState } from 'react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { db } from '../firebase';
import { Activity, Zap, Crosshair, AlertTriangle, Sparkles, TrendingUp, TrendingDown } from 'lucide-react';

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
  lastGatillo?: { dir: 'BUY' | 'SELL'; price: number; time: number; type: string; status: string; };
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
  if (dir === 'BUY') return <span className="status-buy" style={{ fontWeight: 700 }}>BUY 🟢</span>;
  if (dir === 'SELL') return <span className="status-sell" style={{ fontWeight: 700 }}>SELL 🔴</span>;
  return <span className="status-neutral" style={{ opacity: 0.5 }}>NEUT ⚪</span>;
};

const SkeletonRow = () => (
  <tr>
    {Array.from({ length: 12 }, (_, i) => (
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
              <th>4H (MACRO)</th>
              <th>1H (TREND)</th>
              <th>15M (MICRO)</th>
              <th>GATILLO (3M)</th>
              <th>PUNTOS C</th>
              <th>PUNTOS V</th>
              <th>TERMÓMETRO</th>
              <th style={{ minWidth: '170px' }}>OTE 50%</th>
              <th style={{ minWidth: '160px' }}>ÚLT. GATILLO</th>
              <th style={{ minWidth: '165px', paddingRight: '16px' }}>PRÓX. ZONAS</th>
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
                  {/* ACTIVO + Rayo Confluencia */}
                  <td style={{ paddingLeft: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', height: '52px' }}>
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
                  <td>
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

                  {/* PRÓXIMAS ZONAS */}
                  <td style={{ paddingRight: '16px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '0.7rem' }}>
                      {(asset.nextZones && asset.nextZones.length > 0) 
                        ? asset.nextZones.slice(0, 3).map((z: any, zi: number) => {
                          const isGold = z.medal?.includes('Oro');
                          const isPlat = z.medal?.includes('Platino');
                          
                          return (
                            <div key={zi} style={{
                              display: 'flex', alignItems: 'center', gap: '4px',
                              color: z.dir === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)',
                              opacity: 0.85
                            }}>
                              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', fontWeight: 600 }}>
                                {z.tf ? (z.tf === '240' ? '4H' : z.tf === '60' ? '1H' : z.tf === '15' ? '15M' : '3M') : '?'}
                              </span>
                              <span className="mono">{z.btm?.toFixed(decimals)}→{z.top?.toFixed(decimals)}</span>
                              <span style={{
                                fontSize: '0.55rem', padding: '0px 3px', borderRadius: '2px',
                                backgroundColor: isPlat ? 'rgba(142,36,170,0.25)' : isGold ? 'rgba(245,127,23,0.25)' : 'rgba(100,100,100,0.1)',
                                color: isPlat ? '#ba68c8' : isGold ? 'var(--accent-gold)' : 'var(--text-secondary)',
                                fontWeight: 700
                              }}>
                                {z.medal?.substring(0, 4) || 'OB'}
                              </span>
                            </div>
                          );
                        }) : (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem' }}>—</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && states.length === 0 && (
              <tr>
                <td colSpan={12} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
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
    </div>
  );
}
