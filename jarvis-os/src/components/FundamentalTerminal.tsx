import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc, collection, query } from 'firebase/firestore';
import { db } from '../firebase';
import { Terminal, ShieldAlert, Newspaper, TrendingUp, BrainCircuit, Bitcoin, Briefcase, AlertTriangle, RefreshCw } from 'lucide-react';

interface AppSettings {
  killswitches: Record<string, boolean>;
}

interface NewsItem {
  time: string;
  source: string;
  text: string;
  impact: 'high' | 'medium';
}

interface SentimentData {
  score: string;
  reason: string;
  status: string;
}

interface Fundamentals {
  last_updated: string;
  news: NewsItem[];
  sentiment: Record<string, SentimentData>;
}

const DEFAULT_ASSETS = ['BTCUSD', 'EURUSD', 'US100', 'XAUUSD'];

// ─── Skeleton Components ───
const SkeletonBlock = ({ height = '20px', width = '100%' }: { height?: string; width?: string }) => (
  <div className="skeleton" style={{ height, width, marginBottom: '8px' }} />
);

export default function FundamentalTerminal() {
  const [settings, setSettings] = useState<AppSettings>({ killswitches: {} });
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null);
  const [tradedAssets, setTradedAssets] = useState<string[]>([]);
  const [loadingFundamentals, setLoadingFundamentals] = useState(true);
  const [errorFundamentals, setErrorFundamentals] = useState<string | null>(null);
  const [macroData, setMacroData] = useState<any[]>([]);
  const [loadingMacro, setLoadingMacro] = useState(true);

  useEffect(() => {
    const unsubGlobal = onSnapshot(doc(db, 'app_settings', 'global'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as Partial<AppSettings>;
        setSettings({ killswitches: data.killswitches || {} });
      }
    });

    const unsubFundamentals = onSnapshot(doc(db, 'app_settings', 'fundamentals'), 
      (docSnap) => {
        if (docSnap.exists()) {
          setFundamentals(docSnap.data() as Fundamentals);
          setErrorFundamentals(null);
        }
        setLoadingFundamentals(false);
      },
      (err) => {
        console.error('[FundTerm] Error Firestore fundamentals:', err);
        setErrorFundamentals('Error cargando datos fundamentales');
        setLoadingFundamentals(false);
      }
    );

    const unsubRadar = onSnapshot(query(collection(db, 'radar_states')), (snapshot) => {
      const assets = snapshot.docs.map(doc => doc.id);
      setTradedAssets(assets.sort());
    });

    // Fetch macro data
    fetchMacroData();

    return () => {
      unsubGlobal();
      unsubFundamentals();
      unsubRadar();
    };
  }, []);

  const fetchMacroData = async () => {
    setLoadingMacro(true);
    try {
      const { fetchMacroIndicators } = await import('../services/macro_data');
      const data = await fetchMacroIndicators();
      setMacroData(data);
    } catch {
      // keep defaults
    } finally {
      setLoadingMacro(false);
    }
  };

  const toggleKillswitch = async (asset: string) => {
    const current = settings.killswitches[asset] || false;
    await setDoc(doc(db, 'app_settings', 'global'), {
      killswitches: {
        ...settings.killswitches,
        [asset]: !current
      }
    }, { merge: true });
  };

  const getSentimentStyle = (status: string) => {
    if (status === 'status-buy') return { bg: 'rgba(0, 255, 0, 0.05)', border: 'rgba(0, 255, 0, 0.2)' };
    if (status === 'status-sell') return { bg: 'rgba(255, 51, 51, 0.05)', border: 'rgba(255, 51, 51, 0.2)' };
    return { bg: 'rgba(255, 170, 0, 0.05)', border: 'rgba(255, 170, 0, 0.2)' };
  };

  const statusMap: Record<string, string> = {
    buy: 'status-buy', sell: 'status-sell', neutral: 'status-neutral', alert: 'status-alert'
  };

  const displayAssets = tradedAssets.length > 0 ? tradedAssets : DEFAULT_ASSETS;

  return (
    <div>
      <div className="panel-header">
        <span><Terminal size={14} style={{ marginRight: 8 }} /> FUNDAMENTAL TERMINAL & MACRO</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {fundamentals?.last_updated && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
              LAST SYNC: {new Date(fundamentals.last_updated).toLocaleTimeString()}
            </span>
          )}
          <button 
            onClick={fetchMacroData} 
            disabled={loadingMacro}
            style={{ background: 'none', border: 'none', cursor: loadingMacro ? 'wait' : 'pointer', color: 'var(--text-tertiary)', padding: '2px', display: 'flex' }}
            title="Refrescar datos macro"
          >
            <RefreshCw size={14} className={loadingMacro ? 'live-dot' : ''} />
          </button>
        </div>
      </div>
      
      {/* ROW 1: Killswitches & Macro Indicators */}
      <div className="grid-2" style={{ marginBottom: 'var(--spacing-lg)' }}>
        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-red)' }}>
            <ShieldAlert size={18} /> KILLSWITCHES POR ACTIVO
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Desactiva temporalmente el bot para activos específicos durante alta volatilidad o noticias.
          </p>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {displayAssets.map(asset => {
              const isLocked = settings.killswitches[asset] || false;
              return (
                <div key={asset} style={{ 
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
                  padding: '12px', border: '1px solid var(--border-color)', borderRadius: '4px', 
                  backgroundColor: isLocked ? 'rgba(255, 51, 51, 0.1)' : 'transparent',
                  transition: 'background-color 0.2s'
                }}>
                  <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{asset}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '0.8rem', color: isLocked ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                      {isLocked ? '🔴 STANDBY' : '🟢 ACTIVE'}
                    </span>
                    <label className="switch">
                      <input type="checkbox" checked={!isLocked} onChange={() => toggleKillswitch(asset)} />
                      <span className="slider"></span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-blue)' }}>
            <TrendingUp size={18} /> INDICADORES MACRO (TIEMPO REAL)
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Variables clave de mercado — datos en vivo de Finnhub y CoinGecko.
          </p>

          {loadingMacro && macroData.length === 0 ? (
            <div>
              <SkeletonBlock height="40px" />
              <SkeletonBlock height="40px" />
              <SkeletonBlock height="40px" />
              <SkeletonBlock height="40px" />
              <SkeletonBlock height="40px" />
            </div>
          ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>INDICADOR</th>
                <th>VALOR</th>
                <th>ESTADO</th>
              </tr>
            </thead>
            <tbody>
              {macroData.map((m, i) => (
                <tr key={i}>
                  <td>{m.label}</td>
                  <td className="mono">{m.value}</td>
                  <td>
                    <span className={`status ${statusMap[m.status] || 'status-neutral'}`} style={{ fontSize: '0.8rem' }}>
                      {m.interpretation}
                    </span>
                  </td>
                </tr>
              ))}
              {macroData.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'center', padding: '16px', color: 'var(--text-tertiary)' }}>
                    Conectando con APIs de mercado...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          )}
        </div>
      </div>

      {/* ROW 2: News Feed & Sentiment */}
      <div className="grid-2" style={{ marginBottom: 'var(--spacing-lg)' }}>
        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
            <Newspaper size={18} /> FEED DE NOTICIAS
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '280px', overflowY: 'auto', paddingRight: '4px' }}>
            {loadingFundamentals ? (
              <><SkeletonBlock height="50px" /><SkeletonBlock height="50px" /><SkeletonBlock height="50px" /></>
            ) : errorFundamentals ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={20} />
                <span>{errorFundamentals}</span>
              </div>
            ) : !fundamentals?.news ? (
              <div style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', textAlign: 'center', padding: '20px' }}>
                Cargando noticias desde Finnhub...
              </div>
            ) : fundamentals.news.map((news, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${news.impact === 'high' ? 'var(--accent-red)' : 'var(--accent-gold)'}`, paddingLeft: '12px', paddingBottom: '12px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', gap: '8px', fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '4px', fontFamily: 'var(--font-mono)' }}>
                  <span>{news.time}</span><span>|</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{news.source}</span>
                </div>
                <div style={{ fontSize: '0.9rem', lineHeight: '1.4' }}>{news.text}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: '#9d00ff' }}>
            <BrainCircuit size={18} /> ANÁLISIS DE SENTIMIENTO (IA)
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {loadingFundamentals ? (
              <><SkeletonBlock height="60px" /><SkeletonBlock height="60px" /><SkeletonBlock height="60px" /></>
            ) : !fundamentals?.sentiment ? (
              <div style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', textAlign: 'center', padding: '20px' }}>
                Esperando análisis del LLM...
              </div>
            ) : (
              ['BTCUSD', 'EURUSD', 'US100'].map(asset => {
                const data = fundamentals.sentiment[asset] || { score: 'N/A', reason: 'Sin datos', status: 'status-neutral' };
                const style = getSentimentStyle(data.status);
                return (
                  <div key={asset} style={{ padding: '12px', backgroundColor: style.bg, border: `1px solid ${style.border}`, borderRadius: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <strong className="mono">{asset}</strong>
                      <span className={`status ${data.status}`}>{data.score}</span>
                    </div>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
                      <strong>Motivo IA:</strong> {data.reason}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ROW 3: On-Chain & Earnings */}
      <div className="grid-2">
        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: '#f7931a' }}>
            <Bitcoin size={18} /> MÉTRICAS ON-CHAIN (CRYPTO)
          </h3>
          <table className="data-table">
            <thead>
              <tr><th>MÉTRICA</th><th>VALOR</th><th>INTERPRETACIÓN</th></tr>
            </thead>
            <tbody>
              <tr><td>Funding Rates</td><td className="mono" style={{ color: 'var(--accent-green)' }}>+0.015%</td><td>Ligeramente alcista</td></tr>
              <tr><td>Fear & Greed</td><td className="mono">72</td><td><span className="status status-buy">CODICIA</span></td></tr>
              <tr><td>Dominancia BTC</td><td className="mono">52.4%</td><td>Subiendo</td></tr>
              <tr><td>Netflow Exchanges</td><td className="mono text-red">-12,500 BTC</td><td>Salida neta (Bullish)</td></tr>
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-gold)' }}>
            <Briefcase size={18} /> EARNINGS Y CALENDARIO
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px', marginBottom: '8px' }}>
                Próximos Earnings
              </h4>
              <table className="data-table" style={{ fontSize: '0.8rem' }}>
                <tbody>
                  <tr><td>Hoy Post-Market</td><td className="mono" style={{ fontWeight: 'bold' }}>NVDA</td><td><span style={{ color: 'var(--accent-red)' }}>ALTO IMPACTO</span></td></tr>
                  <tr><td>Mañana Pre-Market</td><td className="mono">AAPL</td><td>Impacto Moderado</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px', marginBottom: '8px' }}>
                Calendario Económico
              </h4>
              <table className="data-table" style={{ fontSize: '0.8rem' }}>
                <tbody>
                  <tr><td>Jueves 14:00</td><td>USD</td><td>FOMC</td><td><span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>EXTREMO</span></td></tr>
                  <tr><td>Viernes 08:30</td><td>USD</td><td>NFP</td><td><span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>ALTO</span></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ROW 4: Síntesis */}
      <div className="panel" style={{ marginTop: 'var(--spacing-lg)' }}>
        <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
          <BrainCircuit size={18} color="var(--accent-blue)" /> SÍNTESIS DIRECCIONAL POR ACTIVO
        </h3>
        <div className="grid-2">
          {displayAssets.map(asset => {
            let action = 'NEUTRAL', color = 'var(--text-tertiary)';
            let bgColor = 'rgba(255, 255, 255, 0.02)', border = '1px solid var(--border-color)';
            let reasoning = 'Esperando confluencia de datos...';

            if (asset === 'BTCUSD') {
              action = 'LONG PENDIENTE'; color = 'var(--accent-green)';
              bgColor = 'rgba(0, 255, 0, 0.05)'; border = '1px solid rgba(0, 255, 0, 0.2)';
              reasoning = 'Macro: Risk On. On-Chain: Salida neta de exchanges alcista. Sentimiento IA: Fuerte.';
            } else if (asset === 'US100') {
              action = 'PRECAUCIÓN'; color = 'var(--accent-gold)';
              bgColor = 'rgba(255, 170, 0, 0.05)'; border = '1px solid rgba(255, 170, 0, 0.2)';
              reasoning = 'Macro: Yields altos presionan. Calendario: Earnings próximos (NVDA). Sentimiento: Mixto.';
            } else if (asset === 'EURUSD') {
              action = 'SHORT FAVORECIDO'; color = 'var(--accent-red)';
              bgColor = 'rgba(255, 51, 51, 0.05)'; border = '1px solid rgba(255, 51, 51, 0.2)';
              reasoning = 'Macro: DXY fuerte presiona. Calendario: NFP viernes. Sentimiento: Débil.';
            } else if (asset === 'XAUUSD') {
              action = 'RANGO VOLÁTIL'; color = 'var(--accent-gold)';
              bgColor = 'rgba(255, 170, 0, 0.05)'; border = '1px solid rgba(255, 170, 0, 0.2)';
              reasoning = 'Yields altos vs Riesgo geopolítico. Neutralizados. Operar extremos.';
            }

            return (
              <div key={asset} style={{ padding: '16px', backgroundColor: bgColor, border, borderRadius: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <strong className="mono" style={{ fontSize: '1.1rem' }}>{asset}</strong>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color, padding: '4px 8px', border: `1px solid ${color}`, borderRadius: '4px' }}>
                    {action}
                  </span>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>{reasoning}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
