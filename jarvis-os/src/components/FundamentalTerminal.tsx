import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Terminal, ShieldAlert, Newspaper, TrendingUp, BrainCircuit, Bitcoin, Briefcase } from 'lucide-react';

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

export default function FundamentalTerminal() {
  const [settings, setSettings] = useState<AppSettings>({ killswitches: {} });
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null);
  
  useEffect(() => {
    // Escuchar Killswitches
    const unsubGlobal = onSnapshot(doc(db, 'app_settings', 'global'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as Partial<AppSettings>;
        setSettings({ killswitches: data.killswitches || {} });
      }
    });

    // Escuchar Datos Fundamentales (Noticias y Sentimiento)
    const unsubFundamentals = onSnapshot(doc(db, 'app_settings', 'fundamentals'), (docSnap) => {
      if (docSnap.exists()) {
        setFundamentals(docSnap.data() as Fundamentals);
      }
    });

    return () => {
      unsubGlobal();
      unsubFundamentals();
    };
  }, []);

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

  return (
    <div>
      <div className="panel-header">
        <span><Terminal size={14} style={{ marginRight: 8 }} /> FUNDAMENTAL TERMINAL & MACRO</span>
        {fundamentals?.last_updated && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                LAST SYNC: {new Date(fundamentals.last_updated).toLocaleTimeString()}
            </span>
        )}
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
            {DEFAULT_ASSETS.map(asset => {
              const isLocked = settings.killswitches[asset] || false;
              return (
                <div key={asset} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: isLocked ? 'rgba(255, 51, 51, 0.1)' : 'transparent' }}>
                  <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{asset}</span>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '0.8rem', color: isLocked ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                      {isLocked ? '🔴 STANDBY (LOCKED)' : '🟢 ACTIVE'}
                    </span>
                    <label className="switch">
                      <input 
                        type="checkbox" 
                        checked={!isLocked} 
                        onChange={() => toggleKillswitch(asset)} 
                      />
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
            <TrendingUp size={18} /> INDICADORES MACRO (RISK ON/OFF)
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Variables clave de mercado para entender el contexto global y el apetito por el riesgo.
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>INDICADOR</th>
                <th>VALOR ACTUAL</th>
                <th>ESTADO</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>DXY (Índice Dólar)</td>
                <td className="mono">104.25</td>
                <td><span className="status status-buy">ALCISTA</span></td>
              </tr>
              <tr>
                <td>VIX (Volatilidad)</td>
                <td className="mono">14.50</td>
                <td><span className="status status-neutral">NORMAL</span> (Risk On)</td>
              </tr>
              <tr>
                <td>US 10Y Yield</td>
                <td className="mono">4.15%</td>
                <td><span className="status status-sell">ALTO</span> (Presión Oro/Crypto)</td>
              </tr>
              <tr>
                <td>Sentimiento Global</td>
                <td className="mono">--</td>
                <td>
                  <span className="status status-buy" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <div className="live-dot"></div> RISK ON
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ROW 2: News Feed & Sentiment Analysis */}
      <div className="grid-2" style={{ marginBottom: 'var(--spacing-lg)' }}>
        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
            <Newspaper size={18} /> REAL-TIME NEWS FEED
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Titulares financieros extraídos vía Finnhub API.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '280px', overflowY: 'auto', paddingRight: '4px' }}>
            {!fundamentals?.news ? (
                <div style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', textAlign: 'center', padding: '20px' }}>
                    Cargando noticias desde Finnhub...
                </div>
            ) : fundamentals.news.map((news, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${news.impact === 'high' ? 'var(--accent-red)' : 'var(--accent-gold)'}`, paddingLeft: '12px', paddingBottom: '12px', borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', gap: '8px', fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '4px', fontFamily: 'var(--font-mono)' }}>
                  <span>{news.time}</span>
                  <span>|</span>
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
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Evaluación del sentimiento en tiempo real basada en noticias y procesada por Gemini.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {!fundamentals?.sentiment ? (
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

      {/* ROW 3: On-Chain Metrics & Earnings */}
      <div className="grid-2">
        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: '#f7931a' }}>
            <Bitcoin size={18} /> MÉTRICAS ON-CHAIN (CRYPTO)
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Datos de red y liquidez de derivados para Bitcoin.
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>MÉTRICA</th>
                <th>VALOR</th>
                <th>INTERPRETACIÓN</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Funding Rates</td>
                <td className="mono" style={{ color: 'var(--accent-green)' }}>+0.015%</td>
                <td>Ligeramente alcista (Longs pagan Shorts)</td>
              </tr>
              <tr>
                <td>Fear & Greed Index</td>
                <td className="mono">72</td>
                <td><span className="status status-buy">CODICIA</span></td>
              </tr>
              <tr>
                <td>Dominancia BTC</td>
                <td className="mono">52.4%</td>
                <td>Subiendo (Absorbiendo liquidez)</td>
              </tr>
              <tr>
                <td>Netflow Exchanges</td>
                <td className="mono text-red">-12,500 BTC</td>
                <td>Salida neta (Acumulación en frío)</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-gold)' }}>
            <Briefcase size={18} /> EARNINGS Y CALENDARIO
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Reportes corporativos clave y eventos macro próximos.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px', marginBottom: '8px' }}>
                Próximos Earnings (Impacto US100)
              </h4>
              <table className="data-table" style={{ fontSize: '0.8rem' }}>
                <tbody>
                  <tr>
                    <td>Hoy Post-Market</td>
                    <td className="mono" style={{ fontWeight: 'bold' }}>NVDA</td>
                    <td><span style={{ color: 'var(--accent-red)' }}>ALTO IMPACTO</span></td>
                  </tr>
                  <tr>
                    <td>Mañana Pre-Market</td>
                    <td className="mono">AAPL</td>
                    <td>Impacto Moderado</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div>
              <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px', marginBottom: '8px' }}>
                Calendario Económico
              </h4>
              <table className="data-table" style={{ fontSize: '0.8rem' }}>
                <tbody>
                  <tr>
                    <td>Jueves 14:00</td>
                    <td>USD</td>
                    <td>FOMC Press Conference</td>
                    <td><span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>EXTREMO</span></td>
                  </tr>
                  <tr>
                    <td>Viernes 08:30</td>
                    <td>USD</td>
                    <td>NFP (Nóminas No Agrícolas)</td>
                    <td><span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>ALTO</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
