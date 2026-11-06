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
  Sliders
} from 'lucide-react';
import { EmptyState, Badge } from './MicroStates';

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
  macro?: { vix?: number; dxy?: number; us10y?: number };
}

interface MacroIndicator {
  label: string;
  value: string;
  status: string;
  interpretation: string;
  description: string;
}

// ─── Config ───
const DEFAULT_ASSETS = ['BTCUSD', 'EURUSD', 'US100', 'XAUUSD'];

const ASSET_LABELS: Record<string, string> = {
  BTCUSD: 'Bitcoin',
  EURUSD: 'Euro/Dólar',
  US100: 'Nasdaq',
  XAUUSD: 'Oro'
};

// Palabras clave (ES + EN) para etiquetar noticias por activo y filtrar.
const ASSET_KEYWORDS: Record<string, string[]> = {
  BTCUSD: ['btc', 'bitcoin', 'crypto', 'cripto', 'halving', 'blockchain'],
  EURUSD: ['eur', 'euro', 'eurozona', 'europa', 'europe', 'ecb', 'dxy', 'dollar', 'dólar', 'dolar', 'fed', 'reserva federal', 'banco central europeo'],
  US100: ['nasdaq', 'tech', 'tecnología', 'nvidia', 'apple', 'amazon', 'microsoft', 'meta', 'tesla', 'stocks', 'acciones', 'wall street', 's&p', 'mercado de valores'],
  XAUUSD: ['gold', 'oro', 'xau', 'silver', 'plata', 'metals', 'metales', 'refugio', 'safe haven']
};

function detectAssets(text: string): string[] {
  const t = text.toLowerCase();
  return Object.entries(ASSET_KEYWORDS)
    .filter(([, kws]) => kws.some(k => t.includes(k)))
    .map(([asset]) => asset);
}

/** Divide el motivo del LLM (ya en español) en viñetas legibles. */
function formatReason(reason: string, asset: string): string[] {
  const fallback: Record<string, string> = {
    BTCUSD: 'Sin análisis de noticias disponible para este activo en la última ronda.',
    EURUSD: 'Sin análisis de noticias disponible para este activo en la última ronda.',
    US100: 'Sin análisis de noticias disponible para este activo en la última ronda.',
    XAUUSD: 'Sin análisis de noticias disponible para este activo en la última ronda.'
  };

  if (!reason || reason === 'Sin datos') {
    return [fallback[asset] || 'Sin análisis de noticias disponible.'];
  }

  const parts = reason
    .split(/[.;]\s*/)
    .map(p => p.trim())
    .filter(p => p.length > 8);

  if (parts.length === 0) {
    return [reason.charAt(0).toUpperCase() + reason.slice(1)];
  }

  return parts.slice(0, 3).map(p => {
    let s = p.charAt(0).toUpperCase() + p.slice(1);
    if (!/[.!?]$/.test(s)) s += '.';
    return s;
  });
}

export default function NewsAnalyzer() {
  const [settings, setSettings] = useState<AppSettings>({ killswitches: {} });
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null);
  const [loadingFundamentals, setLoadingFundamentals] = useState(true);
  const [errorFundamentals, setErrorFundamentals] = useState<string | null>(null);
  const [macroData, setMacroData] = useState<MacroIndicator[]>([]);
  const [loadingMacro, setLoadingMacro] = useState(true);
  const [macroError, setMacroError] = useState<string | null>(null);

  // Filtros del feed de noticias
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

  // Clima global de mercado basado en VIX
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
        text: `Nivel de pánico crítico (VIX: ${vixNum.toFixed(2)}). Inestabilidad extrema. Se recomienda pausar los bots o activar Standby.`
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

  // Feed filtrado
  const filteredNews = useMemo(() => {
    if (!fundamentals?.news) return [];
    return fundamentals.news.filter(n => {
      if (impactFilter !== 'all' && n.impact !== impactFilter) return false;
      if (assetFilter !== 'all' && !detectAssets(n.text).includes(assetFilter)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = `${n.text} ${n.source}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [fundamentals, search, impactFilter, assetFilter]);

  const climate = getMarketClimate();
  const newsList = filteredNews;
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

      {/* ─── 1. SEMÁFORO DE CLIMA GLOBAL DE MERCADO ─── */}
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

      {/* ─── 2. FEED DE NOTICIAS (CENTRO) ─── */}
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
          <Newspaper size={14} color="var(--accent-gold)" /> NOTICIAS DEL MERCADO
          {fundamentals?.news && (
            <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
              · {filteredNews.length} de {fundamentals.news.length}
            </span>
          )}
        </h3>

        {/* Toolbar de búsqueda y filtros */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center',
          marginBottom: '16px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 260px', minWidth: '220px' }}>
            <Search size={16} color="var(--text-tertiary)" />
            <input
              type="text"
              placeholder="Buscar titular o fuente..."
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

          <select
            value={assetFilter}
            onChange={e => setAssetFilter(e.target.value)}
            style={{ ...inputStyle, appearance: 'auto' }}
          >
            <option value="all">Todos los activos</option>
            {DEFAULT_ASSETS.map(a => (
              <option key={a} value={a}>{ASSET_LABELS[a]}</option>
            ))}
          </select>
        </div>

        {/* Lista de noticias */}
        {loadingFundamentals ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="skeleton" style={{ height: '56px' }} />
            <div className="skeleton" style={{ height: '56px' }} />
            <div className="skeleton" style={{ height: '56px' }} />
          </div>
        ) : errorFundamentals ? (
          <div className="panel" style={{ textAlign: 'center', padding: '24px', color: 'var(--accent-red)' }}>
            <AlertTriangle size={20} style={{ marginBottom: '8px' }} />
            <div>{errorFundamentals}</div>
          </div>
        ) : newsList.length === 0 ? (
          <EmptyState
            icon="📰"
            title={search || impactFilter !== 'all' || assetFilter !== 'all' ? 'Sin resultados' : 'Sin noticias recientes'}
            description={search || impactFilter !== 'all' || assetFilter !== 'all'
              ? 'Ninguna noticia coincide con los filtros actuales. Ajustá la búsqueda o los filtros.'
              : 'El bot aún no ha publicado noticias. Se actualizan automáticamente desde Finnhub.'}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {newsList.map((news, i) => {
              const assets = detectAssets(news.text);
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
                    {assets.map(a => (
                      <Badge key={a} label={a} variant="info" />
                    ))}
                  </div>
                  <div style={{ fontSize: '0.9rem', lineHeight: '1.45', color: 'var(--text-primary)' }}>
                    {news.text}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── 3. SENTIMIENTO POR ACTIVO + KILLSWITCH ─── */}
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{
          fontSize: '0.85rem',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          letterSpacing: '0.05em',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <Sliders size={14} color="var(--accent-gold)" /> SENTIMIENTO POR ACTIVO (ANÁLISIS IA DE NOTICIAS)
        </h3>

        {loadingFundamentals ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
            <div className="panel skeleton" style={{ height: '150px', opacity: 0.15 }} />
            <div className="panel skeleton" style={{ height: '150px', opacity: 0.15 }} />
            <div className="panel skeleton" style={{ height: '150px', opacity: 0.15 }} />
            <div className="panel skeleton" style={{ height: '150px', opacity: 0.15 }} />
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
            {displayAssets.map(asset => {
              const data = fundamentals?.sentiment?.[asset] || { score: 'N/A', reason: 'Sin datos', status: 'status-neutral' };
              const isLocked = settings?.killswitches?.[asset] || false;

              let badgeText = 'LATERAL ⚖️';
              let badgeColor = 'var(--text-secondary)';
              let cardHighlightBorder = 'var(--border-color)';

              if (data.status === 'status-buy') {
                badgeText = 'ALCISTA 📈';
                badgeColor = 'var(--accent-green)';
                cardHighlightBorder = 'rgba(0, 255, 0, 0.2)';
              } else if (data.status === 'status-sell') {
                badgeText = 'BAJISTA 📉';
                badgeColor = 'var(--accent-red)';
                cardHighlightBorder = 'rgba(255, 51, 51, 0.2)';
              } else if (data.status === 'status-alert') {
                badgeText = 'PRECAUCIÓN ⚠️';
                badgeColor = 'var(--accent-gold)';
                cardHighlightBorder = 'rgba(255, 170, 0, 0.2)';
              }

              const bulletPoints = formatReason(data.reason, asset);

              return (
                <div
                  key={asset}
                  className="panel"
                  style={{
                    marginBottom: 0,
                    borderColor: isLocked ? 'rgba(255, 51, 51, 0.4)' : cardHighlightBorder,
                    backgroundColor: isLocked ? 'rgba(255, 51, 51, 0.03)' : 'var(--bg-panel)',
                    transition: 'all 0.25s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)'
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <div>
                        <span className="mono" style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{asset}</span>
                        {ASSET_LABELS[asset] && <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>{ASSET_LABELS[asset]}</div>}
                      </div>
                      <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        color: badgeColor,
                        backgroundColor: 'rgba(0,0,0,0.3)',
                        padding: '3px 8px',
                        borderRadius: '4px',
                        border: `1px solid ${badgeColor}`
                      }}>
                        {badgeText}
                      </span>
                    </div>

                    <div style={{ fontSize: '0.85rem', color: 'var(--accent-gold)', fontWeight: 600, marginBottom: '10px', fontFamily: 'var(--font-mono)' }}>
                      {data.score}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                      {bulletPoints.map((point, index) => (
                        <div key={index} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '0.85rem' }}>
                          <span style={{ color: 'var(--accent-gold)', marginTop: '2px' }}>•</span>
                          <span style={{ color: 'var(--text-secondary)', lineHeight: '1.4' }}>{point}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingTop: '12px',
                    borderTop: '1px solid var(--border-color)',
                    fontSize: '0.85rem'
                  }}>
                    <span style={{
                      fontWeight: 600,
                      color: isLocked ? 'var(--accent-red)' : 'var(--accent-green)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}>
                      <div className={isLocked ? '' : 'live-dot'} style={{ width: '6px', height: '6px', backgroundColor: isLocked ? 'var(--accent-red)' : 'var(--accent-green)', borderRadius: '50%' }}></div>
                      {isLocked ? 'BOT PAUSADO' : 'BOT ACTIVO'}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {isLocked ? 'Reactivar' : 'Pausar'}
                      </span>
                      <label className="switch">
                        <input type="checkbox" checked={!isLocked} onChange={() => toggleKillswitch(asset)} />
                        <span className="slider"></span>
                      </label>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── 4. VARIABLES MACRO ─── */}
      <div className="panel" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-blue)' }}>
          <Activity size={18} /> VARIABLES MACRO CLAVE
        </h3>
        <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
          Indicadores financieros globales medidos en tiempo real.
        </p>

        {loadingMacro && macroData.length === 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
            <div className="skeleton" style={{ height: '70px' }} />
            <div className="skeleton" style={{ height: '70px' }} />
            <div className="skeleton" style={{ height: '70px' }} />
          </div>
        ) : macroError ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={24} />
            <span>{macroError}</span>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
            {macroData.map((m, i) => (
              <div key={i} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 16px',
                border: '1px solid var(--border-color)',
                borderRadius: '4px',
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
  );
}
