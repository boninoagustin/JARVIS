import { useEffect, useState } from 'react';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Settings, Save, Shield, TrendingDown, TrendingUp } from 'lucide-react';
import { useToast } from './Toast';
import { type AssetConfig, type SessionConfig, type SessionKey, TICKERS, SESSIONS, DEFAULT_ASSET_CONFIG } from './admin/types';
import SessionCard from './admin/SessionCard';

export default function AdminPanel() {
  const { toast } = useToast();
  const [activeTicker, setActiveTicker] = useState<string>(TICKERS[0]);
  const [assetConfig, setAssetConfig] = useState<AssetConfig>(DEFAULT_ASSET_CONFIG);
  const [saving, setSaving] = useState(false);

  // Cargar config del activo seleccionado
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const docSnap = await getDoc(doc(db, 'asset_configs', activeTicker));
        if (docSnap.exists()) {
          const data = docSnap.data() as AssetConfig;
          // Asegurar estructura de sesiones
          const sessions = data.sessions || {};
          SESSIONS.forEach((s: SessionKey) => {
            if (!sessions[s]) sessions[s] = {
              choch5m: { enabled: true, minScore: 12 },
              choch15m: { enabled: true, minScore: 12 },
              bos5m: { enabled: true, minScore: 12 },
              bos15m: { enabled: true, minScore: 12 },
              oteChoch5m: { enabled: true, minScore: 8 },
              oteChoch15m: { enabled: true, minScore: 8 },
              oteBos5m: { enabled: true, minScore: 8 },
              oteBos15m: { enabled: true, minScore: 8 },
            };
          });
          setAssetConfig({ ...DEFAULT_ASSET_CONFIG, ...data, sessions });
        } else {
          // Inicializar si no existe
          const newConfig = { ...DEFAULT_ASSET_CONFIG, sessions: {} as Record<string, SessionConfig> };
          SESSIONS.forEach((s: SessionKey) => {
            newConfig.sessions[s] = {
              choch5m: { enabled: true, minScore: 12 },
              choch15m: { enabled: true, minScore: 12 },
              bos5m: { enabled: true, minScore: 12 },
              bos15m: { enabled: true, minScore: 12 },
              oteChoch5m: { enabled: true, minScore: 8 },
              oteChoch15m: { enabled: true, minScore: 8 },
              oteBos5m: { enabled: true, minScore: 8 },
              oteBos15m: { enabled: true, minScore: 8 },
            };
          });
          setAssetConfig(newConfig);
        }
      } catch (err) {
        console.error("Error fetching config:", err);
      }
    };

    fetchConfig();
    const intervalId = setInterval(fetchConfig, 60000); // 60s polling

    return () => clearInterval(intervalId);
  }, [activeTicker]);

  const handleChange = (field: keyof AssetConfig, value: any) => {
    setAssetConfig((prev: AssetConfig) => ({ ...prev, [field]: value }));
  };

  const handleSessionChange = (session: SessionKey, config: SessionConfig) => {
    setAssetConfig((prev: AssetConfig) => ({
      ...prev,
      sessions: { ...prev.sessions, [session]: config }
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setDoc(doc(db, 'asset_configs', activeTicker), {
        ...assetConfig,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      toast(`✅ Configuración de ${activeTicker} guardada`, 'success');
    } catch (e) {
      console.error(e);
      toast('❌ Error guardando configuración', 'error');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = {
    width: '100%', padding: '8px', backgroundColor: '#111', border: '1px solid #333',
    borderRadius: '4px', color: '#e6e6e6', fontFamily: "'JetBrains Mono', monospace",
    fontSize: '0.85rem', marginTop: '4px'
  };

  const cardClass = {
    padding: '16px', backgroundColor: '#0a0a0a', border: '1px solid #222', borderRadius: '6px'
  };

  return (
    <div className="animate-fadeIn" style={{ display: 'flex', gap: '24px', height: 'calc(100vh - 120px)' }}>
      {/* LEFT SIDEBAR - TICKER SELECTOR */}
      <div style={{ width: '200px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <h3 style={{ fontSize: '0.8rem', color: '#888', textTransform: 'uppercase', marginBottom: '8px' }}>Activos</h3>
        {TICKERS.map((ticker: string) => (
          <button
            key={ticker}
            onClick={() => setActiveTicker(ticker)}
            style={{
              padding: '12px 16px', textAlign: 'left', borderRadius: '6px', cursor: 'pointer',
              backgroundColor: activeTicker === ticker ? '#ffaa0020' : '#111',
              color: activeTicker === ticker ? '#ffaa00' : '#888',
              border: `1px solid ${activeTicker === ticker ? '#ffaa0050' : '#222'}`,
              fontWeight: activeTicker === ticker ? 700 : 500,
              transition: 'all 0.2s'
            }}
          >
            {ticker}
          </button>
        ))}
      </div>

      {/* MAIN CONTENT */}
      <div style={{ flex: 1, overflowY: 'auto', paddingRight: '12px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '16px', borderBottom: '1px solid #222' }}>
          <div>
            <h2 style={{ color: '#e6e6e6', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
              <Settings size={20} color="#ffaa00" />
              Configuración: {activeTicker}
            </h2>
            <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '4px' }}>Parámetros específicos por activo y sesión</p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '10px 20px', backgroundColor: saving ? '#333' : '#ffaa00', color: saving ? '#888' : '#000',
              border: 'none', borderRadius: '4px', fontWeight: 700, cursor: saving ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '8px', transition: 'all 0.2s'
            }}
          >
            <Save size={16} />
            {saving ? 'GUARDANDO...' : 'GUARDAR CAMBIOS'}
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          {/* RIESGO GLOBAL DEL ACTIVO */}
          <div style={cardClass}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#0088ff', marginBottom: '16px', fontSize: '0.9rem' }}>
              <Shield size={16} /> Parámetros de Riesgo Base
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>R:R Fijo (TP2)</label>
                <input type="number" step="0.1" value={assetConfig.fixedRR} onChange={e => handleChange('fixedRR', parseFloat(e.target.value))} style={inputClass} />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>SL Buffer %</label>
                <input type="number" step="0.01" value={assetConfig.slBufferPercent} onChange={e => handleChange('slBufferPercent', parseFloat(e.target.value))} style={inputClass} />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  Puntos Mín. BUY
                  <span style={{ fontSize: '0.6rem', backgroundColor: 'var(--accent-gold)', color: '#000', padding: '1px 4px', borderRadius: '3px', fontWeight: 'bold' }}>AUTO</span>
                </label>
                <input type="number" value={assetConfig.minPointsForBuy} onChange={e => handleChange('minPointsForBuy', parseInt(e.target.value))} style={inputClass} />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  Puntos Mín. SELL
                  <span style={{ fontSize: '0.6rem', backgroundColor: 'var(--accent-gold)', color: '#000', padding: '1px 4px', borderRadius: '3px', fontWeight: 'bold' }}>AUTO</span>
                </label>
                <input type="number" value={assetConfig.minPointsForSell} onChange={e => handleChange('minPointsForSell', parseInt(e.target.value))} style={inputClass} />
              </div>
            </div>
          </div>

        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginTop: '20px' }}>
          {/* FILTROS ANTI-SHORT */}
          <div style={{ ...cardClass, borderColor: '#ff333340', backgroundColor: '#ff333305' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ff3333', marginBottom: '16px', fontSize: '0.9rem' }}>
              <TrendingDown size={16} /> Filtros Anti-Short Bias (SELL)
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Max SELLs/Día</label>
                <input type="number" value={assetConfig.maxSellsPerDay} onChange={e => handleChange('maxSellsPerDay', parseInt(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>0 = Ilimitado</div>
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Penalidad Score SELL</label>
                <input type="number" value={assetConfig.sellScorePenalty} onChange={e => handleChange('sellScorePenalty', parseInt(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>Resta puntos a setups SELL</div>
              </div>
            </div>
          </div>

          {/* FILTROS ANTI-LONG (NUEVO) */}
          <div style={{ ...cardClass, borderColor: '#00e67640', backgroundColor: '#00e67605' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#00e676', marginBottom: '16px', fontSize: '0.9rem' }}>
              <TrendingUp size={16} /> Filtros Anti-Long Bias (BUY)
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Max BUYs/Día</label>
                <input type="number" value={assetConfig.maxBuysPerDay} onChange={e => handleChange('maxBuysPerDay', parseInt(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>0 = Ilimitado</div>
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Penalidad Score BUY</label>
                <input type="number" value={assetConfig.buyScorePenalty} onChange={e => handleChange('buyScorePenalty', parseInt(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>Resta puntos a setups BUY</div>
              </div>
            </div>
          </div>
        </div>

        {/* SESIONES */}
        <h3 style={{ fontSize: '0.9rem', color: '#e6e6e6', marginTop: '10px', borderBottom: '1px solid #222', paddingBottom: '8px' }}>
          Configuración por Sesión
        </h3>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
          {assetConfig.sessions && SESSIONS.map((session: SessionKey) => (
            <SessionCard
              key={session}
              session={session}
              config={assetConfig.sessions![session]}
              onChange={handleSessionChange}
            />
          ))}
        </div>

      </div>
    </div>
  );
}
