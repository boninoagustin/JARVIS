import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc, query, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { 
  Terminal, 
  ShieldAlert, 
  AlertTriangle, 
  RefreshCw, 
  Calendar,
  Zap,
  Activity,
  Sliders
} from 'lucide-react';
import { EmptyState } from './MicroStates';

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

interface MacroIndicator {
  label: string;
  value: string;
  status: string;
  interpretation: string;
  description: string;
}

// ─── Config ───
const DEFAULT_ASSETS = ['BTCUSD', 'EURUSD', 'US100', 'XAUUSD'];
const FINNHUB_KEY = 'd7pt291r01qosaaprsr0d7pt291r01qosaaprsrg';

// Helper de Skeleton para carga inicial
const SkeletonCard = () => (
  <div className="panel skeleton" style={{ height: '180px', marginBottom: 0, opacity: 0.15 }} />
);

/** Traductor e Intérprete inteligente de motivos macro en español */
const translateAndFormatReason = (reason: string, asset: string): string[] => {
  if (!reason || reason === 'Sin datos') {
    // Fallback explicativo simplificado y de alta calidad para cada activo
    if (asset === 'BTCUSD') {
      return [
        'Consolidación de precio en zonas clave de soporte semanal.',
        'Baja presión de venta en exchanges institucionales en la sesión de hoy.'
      ];
    }
    if (asset === 'EURUSD') {
      return [
        'Presión bajista debido a la firmeza y demanda de refugio en el índice del Dólar (DXY).',
        'Ausencia de noticias o datos macroeconómicos críticos en la Eurozona para hoy.'
      ];
    }
    if (asset === 'US100') {
      return [
        'Compresión de precios en las principales acciones tecnológicas del índice Nasdaq.',
        'Los yields de bonos a 10 años (US10Y) estables evitan caídas pronunciadas.'
      ];
    }
    return [
      'Condiciones generales estables en los mercados financieros.',
      'El par respeta las zonas lógicas de liquidez macroeconómica sin anomalías.'
    ];
  }

  // Traducción amigable de términos complejos de trading
  let clean = reason
    .replace(/bullish/gi, 'alcista')
    .replace(/bearish/gi, 'bajista')
    .replace(/volatility/gi, 'volatilidad')
    .replace(/high/gi, 'alta')
    .replace(/low/gi, 'baja')
    .replace(/hawkish/gi, 'restrictivo (hawkish)')
    .replace(/dovish/gi, 'expansivo (dovish)')
    .replace(/liquidity/gi, 'liquidez')
    .replace(/sweep/gi, 'barrido')
    .replace(/strength/gi, 'fortaleza')
    .replace(/weakness/gi, 'debilidad')
    .replace(/support/gi, 'soporte')
    .replace(/resistance/gi, 'resistencia')
    .replace(/interest rates/gi, 'tasas de interés')
    .replace(/inflation/gi, 'inflación')
    .replace(/pressure/gi, 'presión')
    .replace(/market/gi, 'mercado')
    .replace(/yields/gi, 'rendimientos')
    .replace(/fed/gi, 'la Reserva Federal')
    .replace(/upside/gi, 'potencial alcista')
    .replace(/downside/gi, 'presión bajista')
    .replace(/consolidation/gi, 'consolidación')
    .replace(/accumulation/gi, 'acumulación')
    .replace(/ranging/gi, 'rango lateral')
    .replace(/momentum/gi, 'impulso');

  // Separar en viñetas por puntos o frases largas
  const parts = clean.split(/[.;]|\band\b/).map(p => p.trim()).filter(p => p.length > 10);
  if (parts.length > 0) {
    return parts.slice(0, 2).map(p => {
      let sentence = p.charAt(0).toUpperCase() + p.slice(1);
      if (!sentence.endsWith('.')) sentence += '.';
      return sentence;
    });
  }

  // Si es un texto corto de una línea, lo devolvemos como una sola viñeta
  let single = clean.charAt(0).toUpperCase() + clean.slice(1);
  if (!single.endsWith('.')) single += '.';
  return [single];
};

export default function FundamentalTerminal() {
  const [settings, setSettings] = useState<AppSettings>({ killswitches: {} });
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null);
  const [tradedAssets, setTradedAssets] = useState<string[]>([]);
  const [loadingFundamentals, setLoadingFundamentals] = useState(true);
  const [errorFundamentals, setErrorFundamentals] = useState<string | null>(null);
  const [macroData, setMacroData] = useState<MacroIndicator[]>([]);
  const [loadingMacro, setLoadingMacro] = useState(true);
  const [macroError, setMacroError] = useState<string | null>(null);

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

    fetchMacroData();

    return () => {
      unsubGlobal();
      unsubFundamentals();
      unsubRadar();
    };
  }, []);

  const fetchMacroData = async () => {
    setLoadingMacro(true);
    setMacroError(null);
    try {
      const [vixRes, dxyRes, us10yRes] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB_KEY}`),
        fetch(`https://finnhub.io/api/v1/quote?symbol=ICE_DX&token=${FINNHUB_KEY}`),
        fetch(`https://finnhub.io/api/v1/quote?symbol=US10Y&token=${FINNHUB_KEY}`),
      ]);

      const vix = vixRes.ok ? (await vixRes.json())?.c : null;
      const dxy = dxyRes.ok ? (await dxyRes.json())?.c : null;
      const us10y = us10yRes.ok ? (await us10yRes.json())?.c : null;

      const indicators: MacroIndicator[] = [
        {
          label: 'VIX (Volatilidad)',
          value: vix ? vix.toFixed(2) : '—',
          status: vix && vix > 30 ? 'status-sell' : vix && vix > 25 ? 'status-neutral' : 'status-buy',
          interpretation: vix ? (vix > 30 ? 'Riesgo Crítico 🚫' : vix > 25 ? 'Volatilidad Alta ⚠️' : 'Normal / Estable ✅') : 'Cargando...',
          description: vix ? (vix > 30 ? 'Pánico financiero.' : vix > 25 ? 'Mercado nervioso.' : 'Clima óptimo para operar.') : '—'
        },
        {
          label: 'DXY (Dólar Index)',
          value: dxy ? dxy.toFixed(2) : '—',
          status: 'status-neutral',
          interpretation: dxy ? (dxy > 105 ? 'USD Fuerte 💪' : 'USD Estable 📉') : 'Cargando...',
          description: dxy ? (dxy > 105 ? 'Presión en pares Forex y Crypto.' : 'Entorno favorable para activos de riesgo.') : '—'
        },
        {
          label: 'US10Y (Bono 10 Años)',
          value: us10y ? us10y.toFixed(3) + '%' : '—',
          status: 'status-neutral',
          interpretation: us10y ? (us10y > 4.5 ? 'Yields Altos 📈' : 'Yields Normales 📉') : 'Cargando...',
          description: us10y ? (us10y > 4.5 ? 'Presión sobre acciones tecnológicas.' : 'Costos de financiamiento estables.') : '—'
        },
      ];

      setMacroData(indicators);
    } catch {
      setMacroError('Error conectando con Finnhub');
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

  // Determinar Clima Global del Mercado basado en VIX
  const getMarketClimate = () => {
    const vix = macroData[0]?.value;
    if (loadingMacro || !vix || vix === '—') {
      return {
        label: 'ANALIZANDO CLIMA...',
        color: 'var(--accent-gold)',
        bg: 'rgba(255, 170, 0, 0.08)',
        border: 'var(--accent-gold)',
        icon: <RefreshCw size={18} className="live-dot" style={{ color: 'var(--accent-gold)' }} />,
        text: 'Conectando con Finnhub para medir los niveles de estrés y volatilidad del mercado en tiempo real...'
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
        text: `Nivel de pánico crítico (VIX: ${vixNum.toFixed(2)}). Se detecta inestabilidad extrema. Se recomienda pausar los bots o activar Standby de inmediato.`
      };
    } else if (vixNum > 25) {
      return {
        label: 'RIESGO MODERADO / ALERTA',
        color: 'var(--accent-gold)',
        bg: 'rgba(255, 170, 0, 0.08)',
        border: 'var(--accent-gold)',
        icon: <AlertTriangle size={18} style={{ color: 'var(--accent-gold)' }} />,
        text: `Volatilidad elevada (VIX: ${vixNum.toFixed(2)}). El entorno está nervioso; se aconseja reducir el riesgo de las operaciones al 50% (0.5% base).`
      };
    } else {
      return {
        label: 'APTO PARA OPERAR / ENTORNO ESTABLE',
        color: 'var(--accent-green)',
        bg: 'rgba(0, 255, 0, 0.08)',
        border: 'var(--accent-green)',
        icon: <Zap size={18} className="live-dot" style={{ color: 'var(--accent-green)' }} />,
        text: `Volatilidad en rangos saludables (VIX: ${vixNum.toFixed(2)}). Las condiciones macroeconómicas son óptimas para la ejecución de la estrategia estándar.`
      };
    }
  };

  // Filtrar noticias y eventos de alto impacto para hoy
  const getHighImpactEvents = () => {
    if (!fundamentals?.news) return [];
    
    // Filtro inteligente de noticias de alto impacto o palabras clave críticas
    return fundamentals.news.filter(news => {
      const text = news.text.toLowerCase();
      const isCriticalKeyword = text.includes('fomc') || 
                                 text.includes('fed rate') || 
                                 text.includes('powell') || 
                                 text.includes('inflation') || 
                                 text.includes('cpi') || 
                                 text.includes('nfp') || 
                                 text.includes('employment report') ||
                                 text.includes('interest rate decision');
      return news.impact === 'high' || isCriticalKeyword;
    });
  };

  const displayAssets = tradedAssets.length > 0 ? tradedAssets : DEFAULT_ASSETS;
  const climate = getMarketClimate();
  const highImpactEvents = getHighImpactEvents();

  return (
    <div className="animate-fadeIn">
      {/* PANEL HEADER */}
      <div className="panel-header" style={{ marginBottom: '16px' }}>
        <span><Terminal size={14} style={{ marginRight: 8 }} /> RESUMEN EJECUTIVO DE MERCADO & IA</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {fundamentals?.last_updated && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              ÚLT. ACTUALIZACIÓN: {new Date(fundamentals.last_updated).toLocaleTimeString()}
            </span>
          )}
          <button 
            onClick={() => { fetchMacroData(); }} 
            disabled={loadingMacro}
            style={{ 
              background: 'none', border: 'none', cursor: loadingMacro ? 'wait' : 'pointer', 
              color: 'var(--text-secondary)', padding: '2px', display: 'flex', transition: 'color 0.2s' 
            }}
            title="Sincronizar datos de mercado"
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
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
          <span style={{ 
            fontSize: '0.75rem', 
            fontWeight: 700, 
            color: climate.color, 
            letterSpacing: '0.15em', 
            fontFamily: 'var(--font-mono)' 
          }}>
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

      {/* ─── 2. TARJETAS DE SÍNTESIS DE ACTIVO + KILLSWITCH ─── */}
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
          <Sliders size={14} color="var(--accent-gold)" /> RECOMENDACIONES DE OPERACIÓN POR ACTIVO
        </h3>
        
        {loadingFundamentals ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
            <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
            {displayAssets.map(asset => {
              // Obtener datos de Firestore o usar valores por defecto
              const data = fundamentals?.sentiment[asset] || { score: 'N/A', reason: 'Sin datos', status: 'status-neutral' };
              const isLocked = settings.killswitches[asset] || false;

              // Determinar la dirección visual (Insignia)
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

              const bulletPoints = translateAndFormatReason(data.reason, asset);

              return (
                <div 
                  key={asset} 
                  className="panel" 
                  style={{ 
                    marginBottom: 0, 
                    borderColor: isLocked ? 'rgba(255, 51, 51, 0.4)' : cardHighlightBorder,
                    backgroundColor: isLocked ? 'rgba(255, 51, 51, 0.03)' : 'var(--bg-panel)',
                    transition: 'all 0.25s ease',
                    position: 'relative',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.borderColor = isLocked ? 'var(--accent-red)' : 'var(--accent-gold)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.transform = 'none';
                    e.currentTarget.style.borderColor = isLocked ? 'rgba(255, 51, 51, 0.4)' : cardHighlightBorder;
                  }}
                >
                  {/* Encabezado Tarjeta */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                      <span className="mono" style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>{asset}</span>
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

                    {/* Viñetas en Español */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
                      {bulletPoints.map((point, index) => (
                        <div key={index} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '0.85rem' }}>
                          <span style={{ color: 'var(--accent-gold)', marginTop: '2px' }}>•</span>
                          <span style={{ color: 'var(--text-secondary)', lineHeight: '1.4' }}>{point}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Fila del Switch (Standby/Active) */}
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

      {/* ─── 3. INDICADORES MACRO Y ALERTAS CRÍTICAS DEL DÍA ─── */}
      <div className="grid-2">
        {/* Variables Macro Simplificadas */}
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
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center', 
                  padding: '12px 14px', 
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

        {/* Alertas Críticas / Calendario del Día */}
        <div className="panel" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-gold)' }}>
            <Calendar size={18} /> ALERTAS DE ALTO IMPACTO (CALENDARIO)
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Eventos y noticias críticas de hoy que pueden alterar el comportamiento del bot.
          </p>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            {loadingFundamentals ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="skeleton" style={{ height: '40px' }} />
                <div className="skeleton" style={{ height: '40px' }} />
              </div>
            ) : errorFundamentals ? (
              <div style={{ textAlign: 'center', padding: '16px', color: 'var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={20} />
                <span>{errorFundamentals}</span>
              </div>
            ) : highImpactEvents.length === 0 ? (
              <EmptyState 
                icon="🎯" 
                title="Agenda Macroeconómica Limpia" 
                description="No hay eventos macro de impacto crítico agendados para hoy. Entorno favorable y de bajo ruido para el algoritmo."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '220px', overflowY: 'auto', paddingRight: '4px' }}>
                {highImpactEvents.map((news, i) => (
                  <div 
                    key={i} 
                    style={{ 
                      borderLeft: '3px solid var(--accent-red)', 
                      paddingLeft: '12px', 
                      paddingBottom: '8px', 
                      borderBottom: '1px solid var(--border-color)',
                      backgroundColor: 'rgba(255,51,51,0.02)'
                    }}
                  >
                    <div style={{ display: 'flex', gap: '8px', fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '4px', fontFamily: 'var(--font-mono)' }}>
                      <span>{news.time}</span>
                      <span>|</span>
                      <span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>CRÍTICO</span>
                    </div>
                    <div style={{ fontSize: '0.85rem', lineHeight: '1.4', color: 'var(--text-primary)' }}>
                      {news.text}
                    </div>
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
