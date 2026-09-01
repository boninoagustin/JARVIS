import { useEffect, useState } from 'react';
import { Activity, Zap, Crosshair, AlertTriangle, Sparkles, TrendingUp, TrendingDown } from 'lucide-react';

// 🆕 Radar v2: estilo base de los badges de estado operativo
const estadoBadge: React.CSSProperties = {
  fontSize: '0.65rem', fontWeight: 700, padding: '2px 7px', borderRadius: '3px',
  border: '1px solid', whiteSpace: 'nowrap',
};

interface ImpulseLeg {
  dir: 'BUY' | 'SELL';
  origin: number;
  extreme: number;
  oteScored?: boolean;
  isValidated?: boolean;
}

interface RadarState {
  id: string;
  marketBias: { 'D'?: string, '240': string, '60': string, '15': string, '5': string };
  scoreBuy: { points: number };
  scoreSell: { points: number };
  zones: any[];
  nextZones?: any[];
  lastPrice?: number;
  activeImpulseBuy?: ImpulseLeg | null;
  activeImpulseSell?: ImpulseLeg | null;
  lastGatillo?: { dir: 'BUY' | 'SELL'; price: number; time: number; type: string; status: string; tf?: string; tfm?: { action: string; riskMult: number; degraded: boolean; dryRun: boolean } };
  // 🆕 Radar v2: estado operativo del bot (enriquecido en trading.ts)
  botStatus?: {
    ks: string[] | null;
    session: string;
    sessionOff: boolean;
    cooldown: boolean;
    enabled: boolean;
    position: { direction: string; pnlR: number | null; managementMode?: string } | null;
    tfm: { action: string; riskMult: number; degraded: boolean; dryRun: boolean } | null;
    spreadPips?: number | null;
    spreadUnit?: string;
  };
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
  if (/BTC|ETH|US30|NAS|US500|SPX|XAU/i.test(ticker)) return 2;
  if (/JPY/i.test(ticker)) return 3;
  return 5;
}

const getIcon = (dir: string) => {
  if (dir === 'BUY') return <span className="status-buy">🟢</span>;
  if (dir === 'SELL') return <span className="status-sell">🔴</span>;
  return <span className="status-neutral" style={{ opacity: 0.5 }}>⚪</span>;
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
  // 🆕 Radar v2: orden por calor + ocultar apagados
  const [sortByHeat, setSortByHeat] = useState(false);
  const [hideIdle, setHideIdle] = useState(false);

  // 🆕 POSICIONES REALES (cTrader): llegan por WS desde el bot (snapshot de activeTrades
  // verificado por RECONCILE contra el broker). Reemplaza a la vieja bitácora de journal.
  const [positions, setPositions] = useState<any[]>([]);

  useEffect(() => {
    setLoading(true);

    // 🔧 WebSocket en vez de Firestore (cuota agotada). El backend emite
    // { type: 'RADAR_STATE', ticker, state } por cada ticker vía ws://169.58.163.132:8081.
    const stateMap = new Map<string, RadarState>();

    import('../services/wsClient').then(({ wsClient }) => {
      wsClient.connect(`ws://${window.location.hostname}:8081`);

      const unsub = wsClient.subscribe((msg: any) => {
        if (msg.type === 'RADAR_STATE') {
          const { ticker, state } = msg;
          stateMap.set(ticker, { id: ticker, ...state } as RadarState);
          setStates(Array.from(stateMap.values()));
          setLoading(false);
          setError(null);
        } else if (msg.type === 'POSITIONS') {
          setPositions(Array.isArray(msg.positions) ? msg.positions : []);
        }
      });

      // Si después de 15s no llegó ningún RADAR_STATE, mostrar advertencia
      setTimeout(() => {
        if (stateMap.size === 0) {
          setLoading(false);
          setError('Esperando datos del backend... ¿JARVIS está corriendo?');
        }
      }, 15000);

      return () => unsub();
    }).catch((err) => {
      console.error('[Radar] Error conectando WebSocket:', err);
      setError(`Error conectando al backend (ws://${window.location.hostname}:8081).`);
      setLoading(false);
    });
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* 🆕 Radar v2: orden/filtro */}
          <button
            onClick={() => setSortByHeat(v => !v)}
            title="Ordenar por calor (termómetro, de mayor a menor puntos)"
            style={{ padding: '4px 10px', fontSize: '0.7rem', fontWeight: 700, borderRadius: '4px', cursor: 'pointer',
              backgroundColor: sortByHeat ? 'rgba(255,170,0,0.2)' : 'transparent', color: sortByHeat ? 'var(--accent-gold)' : 'var(--text-secondary)',
              border: `1px solid ${sortByHeat ? 'var(--accent-gold)' : 'var(--border-color)'}` }}
          >
            🔥 Caliente primero
          </button>
          <button
            onClick={() => setHideIdle(v => !v)}
            title="Ocultar activos apagados / sin actividad"
            style={{ padding: '4px 10px', fontSize: '0.7rem', fontWeight: 700, borderRadius: '4px', cursor: 'pointer',
              backgroundColor: hideIdle ? 'rgba(0,136,255,0.2)' : 'transparent', color: hideIdle ? '#0088ff' : 'var(--text-secondary)',
              border: `1px solid ${hideIdle ? '#0088ff' : 'var(--border-color)'}` }}
          >
            👁️ Solo activos operando
          </button>
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
              <th style={{ paddingLeft: '16px' }}>ESTADO</th>
              <th>ACTIVO</th>
              <th>PRECIO</th>
              <th>D</th>
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
            ) : (() => {
              // 🆕 Radar v2: orden por calor + ocultar apagados
              const rows = [...states];
              if (sortByHeat) {
                rows.sort((a, b) =>
                  Math.max(b.scoreSell?.points || 0, b.scoreBuy?.points || 0) -
                  Math.max(a.scoreSell?.points || 0, a.scoreBuy?.points || 0));
              }
              const visible = hideIdle
                ? rows.filter(a => a.botStatus?.enabled && !a.botStatus?.sessionOff)
                : rows;
              return visible.map(asset => {
              const buyPoints = asset.scoreBuy?.points || 0;
              const sellPoints = asset.scoreSell?.points || 0;
              const maxPoints = Math.max(buyPoints, sellPoints);
              const isHot = maxPoints >= 5;
              const isCritical = maxPoints >= 8;
              const decimals = getDecimals(asset.id);

              // ─── ALINEACIÓN TEMPORAL PERFECTA ───
              const biasD = asset.marketBias?.['D'];
              const bias4H = asset.marketBias?.['240'];
              const bias1H = asset.marketBias?.['60'];
              const bias15M = asset.marketBias?.['15'];
              const bias5M = asset.marketBias?.['5'];

              const isAlignedBuy = biasD === 'BUY' && bias4H === 'BUY' && bias1H === 'BUY' && bias15M === 'BUY' && bias5M === 'BUY';
              const isAlignedSell = biasD === 'SELL' && bias4H === 'SELL' && bias1H === 'SELL' && bias15M === 'SELL' && bias5M === 'SELL';
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
                  {/* 🆕 Radar v2: ESTADO OPERATIVO DEL BOT */}
                  <td style={{ paddingLeft: '16px', minWidth: '130px' }}>
                    {(() => {
                      const bs = asset.botStatus;
                      if (!bs) return <span style={{ color: 'var(--text-tertiary)', fontSize: '0.7rem' }}>—</span>;
                      const badges: React.ReactNode[] = [];
                      if (bs.ks && bs.ks.length > 0) {
                        badges.push(
                          <span key="ks" title={`Killswitch activo: ${bs.ks.join(', ')}`}
                            style={{ ...estadoBadge, background: 'rgba(255,51,51,0.15)', color: '#ff6b6b', borderColor: 'rgba(255,51,51,0.4)' }}>
                            🛡️ KS
                          </span>);
                      }
                      if (!bs.enabled) {
                        badges.push(
                          <span key="off" title="Activo desactivado en asset_configs" style={{ ...estadoBadge, background: 'rgba(255,51,51,0.2)', color: '#ff3333', borderColor: 'rgba(255,51,51,0.5)' }}>
                            ⛔ APAGADO
                          </span>);
                      } else if (bs.sessionOff) {
                        badges.push(
                          <span key="sess" title={`Sesión ${bs.session}: gatillos apagados`} style={{ ...estadoBadge, background: 'rgba(120,120,120,0.15)', color: '#999', borderColor: 'rgba(120,120,120,0.35)' }}>
                            🚫 {bs.session === 'OFF' ? 'Nocturna' : bs.session}
                          </span>);
                      } else if (bs.cooldown) {
                        badges.push(
                          <span key="cd" title="Cooldown del sniper activo" style={{ ...estadoBadge, background: 'rgba(255,170,0,0.15)', color: '#ffaa00', borderColor: 'rgba(255,170,0,0.4)' }}>
                            💤 Cooldown
                          </span>);
                      } else {
                        badges.push(
                          <span key="ok" title="Operando normal" style={{ ...estadoBadge, background: 'rgba(0,230,118,0.1)', color: '#00e676', borderColor: 'rgba(0,230,118,0.35)' }}>
                            ✅
                          </span>);
                      }
                      if (bs.position) {
                        const pnlColor = bs.position.pnlR == null ? '#aaa' : bs.position.pnlR >= 0 ? '#00e676' : '#ff3333';
                        badges.push(
                          <span key="pos" title={`Posición abierta (${bs.position.direction}${bs.position.managementMode ? ' · ' + bs.position.managementMode : ''})`}
                            style={{ ...estadoBadge, background: 'rgba(0,136,255,0.12)', color: pnlColor, borderColor: 'rgba(0,136,255,0.35)' }}>
                            📈 {bs.position.direction === 'BUY' ? 'L' : 'S'} {bs.position.pnlR == null ? '' : (bs.position.pnlR >= 0 ? '+' : '') + bs.position.pnlR + 'R'}
                          </span>);
                      }
                      if (bs.spreadPips != null) {
                        badges.push(
                          <span key="spread" title={`Spread actual (ask − bid)`}
                            style={{ ...estadoBadge, background: 'rgba(100,200,255,0.08)', color: '#8fd4ff', borderColor: 'rgba(100,200,255,0.3)' }}>
                            ↔ {bs.spreadPips} {bs.spreadUnit || 'pips'}
                          </span>);
                      }
                      if (bs.tfm) {
                        const tfm = bs.tfm;
                        const icon = tfm.degraded ? '⚠️' : tfm.action === 'REJECT' ? '✗' : tfm.action === 'APPROVE' ? '✓' : '↓';
                        badges.push(
                          <span key="tfm" title={`TimesFM ${tfm.dryRun ? '(shadow) ' : ''}${tfm.action} · riesgo ×${tfm.riskMult}${tfm.degraded ? ' · degradado' : ''}`}
                            style={{ ...estadoBadge, background: 'rgba(124,77,255,0.12)', color: '#b39dff', borderColor: 'rgba(124,77,255,0.35)' }}>
                            🧊 {icon}
                          </span>);
                      }
                      return <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-start' }}>{badges}</div>;
                    })()}
                  </td>
                  <td style={{ fontWeight: 700 }}>
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
                  <td>{getIcon(biasD || '')}</td>
                  <td>{getIcon(bias4H)}</td>
                  <td>{getIcon(bias1H)}</td>
                  <td>{getIcon(bias15M)}</td>
                  <td>{getIcon(bias5M)}</td>

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
            })})()}
            {!loading && states.length === 0 && (
              <tr>
                <td colSpan={13} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
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

      {/* POSICIONES REALES — snapshot de activeTrades vía WS (verificado por RECONCILE contra cTrader) */}
      <div className="panel" style={{ marginTop: '24px' }}>
         <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <TrendingUp size={18} color="var(--accent-gold)" /> POSICIONES REALES — cTrader
         </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Posiciones abiertas en el broker según el estado reconciliado del bot (se actualiza cada 5s).
            El historial de resultados y la corrección manual viven en el Diario Analítico.
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>ACTIVO</th>
                <th>DIRECCIÓN</th>
                <th>NIVELES</th>
                <th>ESTADO</th>
                <th>PnL (R)</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p: any) => {
                const st = states.find(s => s.id === p.ticker);
                const last = st?.lastPrice;
                // 🛡️ PnL (R): lo calcula el backend contra el SL ESTRUCTURAL original y con
                // el precio del broker del lado correcto. Fallback local solo si no llega.
                let pnlR: number | null;
                if (typeof p.pnlR === 'number' && Number.isFinite(p.pnlR)) {
                  pnlR = p.pnlR;
                } else {
                  const riskSl = p.initialSlPrice ?? p.originalSlPrice ?? p.slPrice;
                  const risk = p.entryPrice != null && riskSl != null ? Math.abs(p.entryPrice - riskSl) : 0;
                  pnlR = risk > 0 && last != null
                    ? (p.direction === 'BUY' ? (last - p.entryPrice) / risk : (p.entryPrice - last) / risk)
                    : null;
                }
                return (
                <tr key={p.tradeId ?? p.ctraderPositionId ?? `${p.ticker}-${p.openTs}`}>
                  <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>{p.tradeId ?? '—'}</td>
                  <td style={{ fontWeight: 700 }}>{p.ticker}{p.adopted && <span title="Adoptada por RECONCILE" style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginLeft: '6px' }}>♻️</span>}</td>
                  <td style={{ fontWeight: 700, color: p.direction === 'BUY' ? '#00e676' : '#ff3333' }}>{p.direction}</td>
                  <td style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <span title="Stop Loss" style={{ color: 'var(--accent-red)', opacity: 0.7 }}>🛑{p.slPrice}</span>
                      <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                      <span title="Entry" style={{ color: 'var(--text-primary)' }}>📥{p.entryPrice}</span>
                      <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                      <span title="Take Profit 1" style={{ color: 'var(--accent-gold)', opacity: p.tp1Hit ? 0.4 : 0.7 }}>🎯{p.tp1Price}</span>
                      {p.tp2Price && p.tp2Price > 0 && (
                        <>
                          <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                          <span title="Take Profit 2" style={{ color: 'var(--accent-green)', opacity: 0.7 }}>🚀{p.tp2Price}</span>
                        </>
                      )}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                      {p.tp1Hit && <span style={{ ...estadoBadge, background: 'rgba(255,170,0,0.1)', color: 'var(--accent-gold)', borderColor: 'rgba(255,170,0,0.4)' }}>TP1 ✓</span>}
                      {p.managementMode === 'RIDER' && <span style={{ ...estadoBadge, background: 'rgba(0,204,255,0.1)', color: '#00ccff', borderColor: 'rgba(0,204,255,0.4)' }}>🏇 RIDER</span>}
                      {!p.tp1Hit && p.managementMode !== 'RIDER' && <span style={{ ...estadoBadge, background: 'rgba(100,100,100,0.15)', color: 'var(--text-secondary)', borderColor: 'rgba(100,100,100,0.4)' }}>ACTIVA</span>}
                    </div>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: pnlR == null ? 'var(--text-secondary)' : pnlR >= 0 ? '#00e676' : '#ff3333' }}>
                    {pnlR == null ? '—' : `${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R`}
                  </td>
                </tr>
                );
              })}
              {positions.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-tertiary)' }}>
                    Sin posiciones abiertas en cTrader.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
      </div>

    </div>
  );
}
