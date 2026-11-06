import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import {
  Newspaper,
  ShieldAlert,
  AlertTriangle,
  RefreshCw,
  Zap,
  Activity,
  Search,
  Sliders,
  TrendingUp,
  TrendingDown
} from 'lucide-react';
import { EmptyState, Badge } from './MicroStates';

interface AppSettings {
  killswitches: Record<string, boolean>;
}

interface NewsAnalysisEntry {
  asset: string;
  direction: 'bullish' | 'bearish';
  reason: string;
}

interface NewsItem {
  time: string;
  source: string;
  text: string;
  impact: 'high' | 'medium';
  analysis?: NewsAnalysisEntry[];
}

interface Fundamentals {
  last_updated: string;
  news: NewsItem[];
  macro?: { vix?: number; dxy?: number; us10y?: number };
}

interface MacroIndicator {
  label: string;
  value: string;
  status: string;
  interpretation: string;
  description: string;
}

const DEFAULT_ASSETS = ['BTCUSD', 'EURUSD', 'US100', 'XAUUSD'];

const ASSET_LABELS: Record<string, string> = {
  BTCUSD: 'Bitcoin',
  EURUSD: 'Euro/Dólar',
  US100: 'Nasdaq',
  XAUUSD: 'Oro'
};

export default function NewsAnalyzer() {
  const [settings, setSettings] = useState<AppSettings>({ killswitches: {} });
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null);
  const [loadingFundamentals, setLoadingFundamentals] = useState(true);
  const [errorFundamentals, setErrorFundamentals] = useState<string | null>(null);
  const [macroData, setMacroData] = useState<MacroIndicator[]>([]);
  const [loadingMacro, setLoadingMacro] = useState(true);
  const [macroError, setMacroError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [impactFilter, setImpactFilter] = useState<'all' | 'high' | 'medium'>('all');
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [tradedAssets, setTradedAssets] = useState<string[]>([]);

  useEffect(() => {
    const unsubGlobal = onSnapshot(doc(db, 'app_settings', 'global'), (globalSnap) => {
      try {
        if (globalSnap.exists()) {
          const data = globalSnap.data() as Partial<AppSettings>;
          setSettings({ killswitches: data.killswitches || {} });
        }
      } catch (err) {
        console.error('[NewsAnalyzer] Error processing global settings:', err);
      }
    });

    const unsubFundamentals = onSnapshot(doc(db, 'app_settings', 'fundamentals'), (fundamentalsSnap) => {
      try {
        if (fundamentalsSnap.exists()) {
          setFundamentals(fundamentalsSnap.data() as Fundamentals);
          setErrorFundamentals(null);
        }
        setLoadingFundamentals(false);
      } catch (err) {
        console.error('[NewsAnalyzer] Error processing fundamentals:', err);
        setErrorFundamentals('Error cargando las noticias');
        setLoadingFundamentals(false);
      }
    });

    fetchMacroData();

    const unsubRadar = (() => {
      const tickers = new Set<string>();
      let unsubWs: (() => void) | null = null;
      import('../services/wsClient').then(({ wsClient }) => {
        wsClient.connect(`ws://${window.location.hostname}:8081`);
        unsubWs = wsClient.subscribe((msg: any) => {
          if (msg.type !== 'RADAR_STATE') return;
          tickers.add(msg.ticker);
          setTradedAssets(Array.from(tickers).sort());
        });
      }).catch(() => {});
      return () => { unsubWs?.(); };
    })();

    return () => {
      unsubGlobal();
      unsubFundamentals();
      unsubRadar();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchMacroData = async () => {
    setLoadingMacro(true);
    setMacroError(null);

    const fetchYahooChart = async (symbol: string): Promise<number | null> => {
      try {
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`);
        if (!res.ok) return null;
        const data = await res.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        return typeof price === 'number' ? price : null;
      } catch (e) {
        console.error(`[NewsAnalyzer] Failed to fetch ${symbol}:`, e);
        return null;
      }
    };

    try {
      const [vixVal, dxyVal, us10yVal] = await Promise.all([
        fetchYahooChart('^VIX'),
        fetchYahooChart('DX-Y.NYB'),
        fetchYahooChart('^TNX')
      ]);

      const macro = fundamentals?.macro || {};
      const vix = vixVal ?? macro.vix ?? 16.5;
      const dxy = dxyVal ?? macro.dxy ?? 103.8;
      const us10y = us10yVal ?? macro.us10y ?? 4.25;

      setMacroData([
        {
          label: 'VIX (Volatilidad)',
          value: typeof vix === 'number' ? vix.toFixed(2) : '—',
          status: vix && vix > 30 ? 'status-sell' : vix && vix > 25 ? 'status-neutral' : 'status-buy',
          interpretation: vix ? (vix > 30 ? 'Riesgo Crítico 🚫' : vix > 25 ? 'Volatilidad Alta ⚠️' : 'Normal / Estable ✅') : 'Cargando...',
          description: vix ? (vix > 30 ? 'Pánico financiero.' : vix > 25 ? 'Mercado nervioso.' : 'Clima óptimo para operar.') : '—'
        },
        {
          label: 'DXY (Dólar Index)',
          value: typeof dxy === 'number' ? dxy.toFixed(2) : '—',
          status: 'status-neutral',
          interpretation: dxy ? (dxy > 105 ? 'USD Fuerte 💪' : 'USD Estable 📉') : 'Cargando...',
          description: dxy ? (dxy > 105 ? 'Presión en pares Forex y Crypto.' : 'Entorno favorable para activos de riesgo.') : '—'
        },
        {
          label: 'US10Y (Bono 10 Años)',
          value: typeof us10y === 'number' ? us10y.toFixed(3) + '%' : '—',
          status: 'status-neutral',
          interpretation: us10y ? (us10y > 4.5 ? 'Yields Altos 📈' : 'Yields Normales 📉') : 'Cargando...',
          description: us10y ? (us10y > 4.5 ? 'Presión sobre acciones tecnológicas.' : 'Costos de financiamiento estables.') : '—'
        }
      ]);
    } catch (err: any) {
      console.error('[NewsAnalyzer] Error fetching macro data:', err);
      setMacroError('Error conectando con los proveedores de datos');
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

  const getMarketClimate = () => {
    const vix = macroData[0]?.value;
    if (loadingMacro || !vix || vix === '—') {
      return {
        label: 'ANALIZANDO CLIMA...',
        color: 'var(--accent-gold)',
        bg: 'rgba(255, 170, 0, 0.08)',
        border: 'var(--accent-gold)',
        icon: <RefreshCw size={18} className="live-dot" style={{ color: 'var(--accent-gold)' }} />,
        text: 'Midiendo los niveles de estrés y volatilidad del mercado en tiempo real...'
      };
    }

    const vixNum = parseFloat(vix);
    if (vixNum > 30) {
      return {
        label: 'EVITAR OPERAR / ALTA VOLATILIDAD',
        color: 'var(--accent-red)',
        bg: 'rgba(255, 51, 51, 0.08)',
        border: 'var(--accent-red)',
        icon: <ShieldAlert size={18} style={{ color: 'var(--accent-red)' }} />,
        text: `Nivel de pánico crítico (VIX: ${vixNum.toFixed(2)}). Inestabilidad extrema. Se recomienda pausar los bots.`
      };
    } else if (vixNum > 25) {
      return {
        label: 'RIESGO MODERADO / ALERTA',
        color: 'var(--accent-gold)',
        bg: 'rgba(255, 170, 0, 0.08)',
        border: 'var(--accent-gold)',
        icon: <AlertTriangle size={18} style={{ color: 'var(--accent-gold)' }} />,
        text: `Volatilidad elevada (VIX: ${vixNum.toFixed(2)}). Entorno nervioso; se aconseja reducir el riesgo al 50%.`
      };
    } else {
      return {
        label: 'APTO PARA OPERAR / ENTORNO ESTABLE',
        color: 'var(--accent-green)',
        bg: 'rgba(0, 255, 0, 0.08)',
        border: 'var(--accent-green)',
        icon: <Zap size={18} className="live-dot" style={{ color: 'var(--accent-green)' }} />,
        text: `Volatilidad en rangos saludables (VIX: ${vixNum.toFixed(2)}). Condiciones macroeconómicas óptimas.`
      };
    }
  };

  const filteredNews = useMemo(() => {
    if (!fundamentals?.news) return [];
    return fundamentals.news.filter(n => {
      if (impactFilter !== 'all' && n.impact !== impactFilter) return false;
      if (assetFilter !== 'all' && !(n.analysis || []).some(a => a.asset === assetFilter)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${n.text} ${n.source}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [fundamentals, search, impactFilter, assetFilter]);

  const climate = getMarketClimate();
  const displayAssets = tradedAssets.length > 0 ? tradedAssets : DEFAULT_ASSETS;

  const inputStyle: CSSProperties = {
    backgroundColor: '#111',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    color: 'var(--text-primary)',
    padding: '8px 12px',
    fontSize: '0.85rem',
    outline: 'none'
  };

  return (
    <div className="animate-fadeIn">
      {/* PANEL HEADER */}
      <div className="panel-header" style={{ marginBottom: '16px' }}>
        <span><Newspaper size={14} style={{ marginRight: 8 }} /> ANALIZADOR DE NOTICIAS & MERCADO</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {fundamentals?.last_updated && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              ÚLT. ACTUALIZACIÓN: {new Date(fundamentals.last_updated).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => fetchMacroData()}
            disabled={loadingMacro}
            style={{ background: 'none', border: 'none', cursor: loadingMacro ? 'wait' : 'pointer', color: 'var(--text-secondary)', padding: '2px', display: 'flex', transition: 'color 0.2s' }}
            title="Sincronizar datos de mercado"
          >
            <RefreshCw size={14} className={loadingMacro ? 'live-dot' : ''} />
          </button>
        </div>
      </div>

      {/* ─── 1. SEMÁFORO DE CLIMA GLOBAL ─── */}
      <div style={{
        padding: '20px',
        backgroundColor: climate.bg,
        border: `1px solid ${climate.border}`,
        borderRadius: '6px',
        marginBottom: '24px',
        transition: 'all 0.3s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '20px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)'
      }}>
        <div style={{
          backgroundColor: 'rgba(0,0,0,0.3)',
          padding: '16px',
          borderRadius: '50%',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          border: `1px solid ${climate.border}`
        }}>
          {climate.icon}
        </div>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: climate.color, letterSpacing: '0.15em', fontFamily: 'var(--font-mono)' }}>
            CLIMA DE MERCADO GLOBAL
          </span>
          <h2 style={{ color: 'var(--text-primary)', margin: '4px 0 8px 0', fontSize: '1.4rem', fontWeight: 700 }}>
            {climate.label}
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.5', margin: 0 }}>
            {climate.text}
          </p>
        </div>
      </div>

      {/* ─── 2. CONCLUSIONES POR NOTICIA (CENTRO) ─── */}
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{
          fontSize: '0.85rem',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          letterSpacing: '0.05em',
          marginBottom: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <Newspaper size={14} color="var(--accent-gold)" /> CONCLUSIONES POR NOTICIA
          {fundamentals?.news && (
            <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
              · {filteredNews.length} de {fundamentals.news.length}
            </span>
          )}
        </h3>

        {/* Toolbar */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 260px', minWidth: '220px' }}>
            <Search size={16} color="var(--text-tertiary)" />
            <input
              type="text"
              placeholder="Buscar titular o activo..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            {(['all', 'high', 'medium'] as const).map(opt => {
              const label = opt === 'all' ? 'Todo' : opt === 'high' ? 'Alto impacto' : 'Medio';
              const active = impactFilter === opt;
              return (
                <button
                  key={opt}
                  onClick={() => setImpactFilter(opt)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    borderRadius: '4px',
                    border: `1px solid ${active ? 'var(--accent-gold)' : 'var(--border-color)'}`,
                    backgroundColor: active ? 'rgba(255,170,0,0.12)' : 'transparent',
                    color: active ? 'var(--accent-gold)' : 'var(--text-secondary)',
                    transition: 'all 0.2s'
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <select value={assetFilter} onChange={e => setAssetFilter(e.target.value)} style={{ ...inputStyle, appearance: 'auto' }}>
            <option value="all">Todos los activos</option>
            {displayAssets.map(a => (
              <option key={a} value={a}>{ASSET_LABELS[a] || a}</option>
            ))}
          </select>
        </div>

        {/* Lista de conclusiones */}
        {loadingFundamentals ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="skeleton" style={{ height: '72px' }} />
            <div className="skeleton" style={{ height: '72px' }} />
            <div className="skeleton" style={{ height: '72px' }} />
          </div>
        ) : errorFundamentals ? (
          <div className="panel" style={{ textAlign: 'center', padding: '24px', color: 'var(--accent-red)' }}>
            <AlertTriangle size={20} style={{ marginBottom: '8px' }} />
            <div>{errorFundamentals}</div>
          </div>
        ) : filteredNews.length === 0 ? (
          <EmptyState
            icon="📰"
            title={search || impactFilter !== 'all' || assetFilter !== 'all' ? 'Sin resultados' : 'Sin conclusiones recientes'}
            description={search || impactFilter !== 'all' || assetFilter !== 'all'
              ? 'Ninguna noticia coincide con los filtros actuales.'
              : 'El bot aún no ha analizado noticias. Se actualizan automáticamente cada 15 minutos.'}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {filteredNews.map((news, i) => {
              const analysis = news.analysis || [];
              return (
                <div
                  key={i}
                  className="panel"
                  style={{
                    marginBottom: 0,
                    padding: '14px 16px',
                    borderLeft: news.impact === 'high' ? '3px solid var(--accent-red)' : '3px solid var(--border-color)',
                    transition: 'all 0.2s ease'
                  }}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                      {news.time}
                    </span>
                    <span style={{ color: 'var(--text-tertiary)' }}>·</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      {news.source}
                    </span>
                    <Badge label={news.impact === 'high' ? 'ALTO IMPACTO' : 'MEDIO'} variant={news.impact === 'high' ? 'error' : 'default'} />
                  </div>

                  <div style={{ fontSize: '0.9rem', lineHeight: '1.45', color: 'var(--text-primary)', marginBottom: analysis.length > 0 ? '10px' : 0 }}>
                    {news.text}
                  </div>

                  {analysis.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '4px' }}>
                      {analysis.map((a, j) => {
                        const bullish = a.direction === 'bullish';
                        return (
                          <div
                            key={j}
                            style={{
                              display: 'flex', alignItems: 'flex-start', gap: '8px',
                              padding: '6px 10px', borderRadius: '4px',
                              backgroundColor: bullish ? 'rgba(0,255,0,0.05)' : 'rgba(255,51,51,0.05)',
                              border: `1px solid ${bullish ? 'rgba(0,255,0,0.18)' : 'rgba(255,51,51,0.18)'}`
                            }}
                          >
                            {bullish
                              ? <TrendingUp size={15} style={{ color: 'var(--accent-green)', marginTop: '1px', flexShrink: 0 }} />
                              : <TrendingDown size={15} style={{ color: 'var(--accent-red)', marginTop: '1px', flexShrink: 0 }} />}
                            <div style={{ fontSize: '0.82rem', lineHeight: '1.4' }}>
                              <span className="mono" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{a.asset}</span>
                              <span style={{ marginLeft: 8, fontWeight: 700, color: bullish ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                                {bullish ? 'ALCISTA' : 'BAJISTA'}
                              </span>
                              {a.reason && (
                                <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>— {a.reason}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── 3. CONTROL DE ACTIVOS (KILLSWITCH) + MACRO ─── */}
      <div className="grid-2">
        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-gold)' }}>
            <Sliders size={18} /> CONTROL DE ACTIVOS EN VIVO
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Pausar o reactivar cada activo que opera el bot.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' }}>
            {displayAssets.map(asset => {
              const isLocked = settings?.killswitches?.[asset] || false;
              return (
                <div
                  key={asset}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                    padding: '10px 12px', borderRadius: '4px',
                    border: `1px solid ${isLocked ? 'rgba(255,51,51,0.35)' : 'var(--border-color)'}`,
                    backgroundColor: isLocked ? 'rgba(255,51,51,0.04)' : 'rgba(255,255,255,0.01)'
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <span className="mono" style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)', display: 'block' }}>{asset}</span>
                    <span style={{ fontSize: '0.68rem', color: isLocked ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                      {isLocked ? 'PAUSADO' : 'ACTIVO'}
                    </span>
                  </div>
                  <label className="switch" style={{ flexShrink: 0 }}>
                    <input type="checkbox" checked={!isLocked} onChange={() => toggleKillswitch(asset)} />
                    <span className="slider"></span>
                  </label>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-blue)' }}>
            <Activity size={18} /> VARIABLES MACRO CLAVE
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Indicadores financieros globales medidos en tiempo real.
          </p>

          {loadingMacro && macroData.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="skeleton" style={{ height: '50px' }} />
              <div className="skeleton" style={{ height: '50px' }} />
              <div className="skeleton" style={{ height: '50px' }} />
            </div>
          ) : macroError ? (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={24} />
              <span>{macroError}</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {macroData.map((m, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 14px', border: '1px solid var(--border-color)', borderRadius: '4px',
                  backgroundColor: 'rgba(255,255,255,0.01)'
                }}>
                  <div>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', display: 'block' }}>
                      {m.label}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                      {m.description}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className="mono" style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', display: 'block' }}>
                      {m.value}
                    </span>
                    <span style={{ fontSize: '0.7rem', fontWeight: 600, color: m.status === 'status-buy' ? 'var(--accent-green)' : m.status === 'status-sell' ? 'var(--accent-red)' : 'var(--accent-gold)' }}>
                      {m.interpretation}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
