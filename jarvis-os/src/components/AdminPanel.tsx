import { useEffect, useState } from 'react';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
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
  const [editedFields, setEditedFields] = useState<Set<string>>(new Set());
  const [minimalRoiText, setMinimalRoiText] = useState<string>('{}');
  const [minimalRoiError, setMinimalRoiError] = useState(false);

  // Cargar config del activo seleccionado
  useEffect(() => {
    const docRef = doc(db, 'asset_configs', activeTicker);
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      try {
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
          // 🌙 OFF nace apagada SIEMPRE (por diseño: no se opera fuera de sesión)
          if (!data.sessions?.OFF) sessions.OFF = {
            choch5m: { enabled: false, minScore: 12 },
            choch15m: { enabled: false, minScore: 12 },
            bos5m: { enabled: false, minScore: 12 },
            bos15m: { enabled: false, minScore: 12 },
            oteChoch5m: { enabled: false, minScore: 8 },
            oteChoch15m: { enabled: false, minScore: 8 },
            oteBos5m: { enabled: false, minScore: 8 },
            oteBos15m: { enabled: false, minScore: 8 },
          };
          setAssetConfig({ ...DEFAULT_ASSET_CONFIG, ...data, sessions });
          setMinimalRoiText(JSON.stringify(data.minimal_roi ?? {}, null, 1));
          setMinimalRoiError(false);
          setEditedFields(new Set());
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
          // 🌙 OFF nace apagada SIEMPRE (por diseño: no se opera fuera de sesión)
          newConfig.sessions.OFF = {
            choch5m: { enabled: false, minScore: 12 },
            choch15m: { enabled: false, minScore: 12 },
            bos5m: { enabled: false, minScore: 12 },
            bos15m: { enabled: false, minScore: 12 },
            oteChoch5m: { enabled: false, minScore: 8 },
            oteChoch15m: { enabled: false, minScore: 8 },
            oteBos5m: { enabled: false, minScore: 8 },
            oteBos15m: { enabled: false, minScore: 8 },
          };
          setAssetConfig(newConfig);
          setMinimalRoiText('{}');
          setMinimalRoiError(false);
          setEditedFields(new Set());
        }
      } catch (err) {
        console.error("Error processing config:", err);
      }
    }, (err) => {
      console.error("Error listening to config:", err);
    });

    return () => unsubscribe();
  }, [activeTicker]);

  const handleChange = (field: keyof AssetConfig, value: any) => {
    setAssetConfig((prev: AssetConfig) => ({ ...prev, [field]: value }));
    setEditedFields((prev: Set<string>) => new Set(prev).add(field as string));
  };

  const handleSessionChange = (session: SessionKey, config: SessionConfig) => {
    setAssetConfig((prev: AssetConfig) => ({
      ...prev,
      sessions: { ...prev.sessions, [session]: config }
    }));
    setEditedFields((prev: Set<string>) => new Set(prev).add('sessions'));
  };

  // Campos que el panel puede escribir. Guardado por diff: SOLO se persiste lo que
  // el usuario tocó (evita pisar con defaults campos que el doc no tenía, ej. timesfm).
  const MANAGED_FIELDS = new Set([
    'fixedRR', 'slBufferPercent', 'minPointsForBuy', 'minPointsForSell',
    'maxSellsPerDay', 'sellScorePenalty', 'maxBuysPerDay', 'buyScorePenalty',
    'maxDailyLossR', 'maxConsecutiveLosses', 'maxTradesPerDay', 'trailingDrawdownR', 'dailyProfitTargetR',
    'enabled', 'entryTrigger', 'oteEntryPercent', 'autoTrading',
    'partialClosePct', 'slAfterTp1', 'tp15BeEnabled', 'atrTrailEnabled',
    'structuralTrailEnabled', 'tp1StructuralMinRR', 'minimal_roi',
  ]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: Record<string, any> = {};
      for (const f of editedFields) {
        if (MANAGED_FIELDS.has(f)) payload[f] = (assetConfig as any)[f];
      }
      if (editedFields.has('sessions')) payload.sessions = assetConfig.sessions;
      payload.updatedAt = new Date().toISOString();
      if (Object.keys(payload).length === 1) {
        toast('Sin cambios que guardar', 'success');
        setSaving(false);
        return;
      }
      await setDoc(doc(db, 'asset_configs', activeTicker), payload, { merge: true });
      toast(`✅ Configuración de ${activeTicker} guardada`, 'success');
      setEditedFields(new Set());
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
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
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

        {/* 🛡️ KILLSWITCHES Y EJECUCIÓN */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginTop: '20px' }}>
          <div style={{ ...cardClass, borderColor: '#ffaa0040', backgroundColor: '#ffaa0005' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ffaa00', marginBottom: '16px', fontSize: '0.9rem' }}>
              🛡️ Killswitches / Límites Diarios
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Max Pérdida Diaria (R)</label>
                <input type="number" step="0.1" value={assetConfig.maxDailyLossR ?? 0} onChange={e => handleChange('maxDailyLossR', parseFloat(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>0 = sin límite</div>
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Max Pérdidas Consecutivas</label>
                <input type="number" value={assetConfig.maxConsecutiveLosses ?? 0} onChange={e => handleChange('maxConsecutiveLosses', parseInt(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>0 = sin límite</div>
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Max Trades / Día</label>
                <input type="number" value={assetConfig.maxTradesPerDay ?? 0} onChange={e => handleChange('maxTradesPerDay', parseInt(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>0 = sin límite</div>
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Trailing Drawdown (R)</label>
                <input type="number" step="0.1" value={assetConfig.trailingDrawdownR ?? 0} onChange={e => handleChange('trailingDrawdownR', parseFloat(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>0 = sin límite</div>
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Objetivo Diario (R)</label>
                <input type="number" step="0.1" value={assetConfig.dailyProfitTargetR ?? 0} onChange={e => handleChange('dailyProfitTargetR', parseFloat(e.target.value) || 0)} style={inputClass} />
                <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>0 = sin objetivo</div>
              </div>
            </div>
          </div>

          <div style={cardClass}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#00e676', marginBottom: '16px', fontSize: '0.9rem' }}>
              ⚙️ Ejecución
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>Modo de Entrada</label>
                <select value={assetConfig.entryTrigger} onChange={e => handleChange('entryTrigger', e.target.value)} style={{ ...inputClass, appearance: 'auto' }}>
                  <option value="SMART">SMART</option>
                  <option value="OTE">OTE</option>
                  <option value="CHOCH">CHOCH</option>
                  <option value="BOTH">BOTH</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: '#888' }}>OTE Entry %</label>
                <input type="number" value={assetConfig.oteEntryPercent} onChange={e => handleChange('oteEntryPercent', parseFloat(e.target.value))} style={inputClass} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: '#e6e6e6' }}>
                <input type="checkbox" checked={assetConfig.enabled} onChange={e => handleChange('enabled', e.target.checked)} style={{ accentColor: '#00e676', width: '16px', height: '16px' }} />
                Activo operando
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: '#e6e6e6' }}>
                <input type="checkbox" checked={assetConfig.autoTrading ?? true} onChange={e => handleChange('autoTrading', e.target.checked)} style={{ accentColor: '#00e676', width: '16px', height: '16px' }} />
                Auto-trading
              </label>
            </div>
          </div>
        </div>

        {/* 🎯 GESTIÓN DE TRADES */}
        <div style={{ ...cardClass, marginTop: '20px', borderColor: '#0088ff30' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#0088ff', marginBottom: '16px', fontSize: '0.9rem' }}>
            🎯 Gestión de Trades (TP1 parcial / SL post-TP1 / trailing)
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#888' }}>Cierre Parcial TP1 (%)</label>
              <input type="number" step="5" min="0" max="100" value={assetConfig.partialClosePct ?? 0} onChange={e => handleChange('partialClosePct', parseFloat(e.target.value) || 0)} style={inputClass} />
              <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '4px' }}>0 = sin toma parcial</div>
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#888' }}>SL tras TP1</label>
              <select value={assetConfig.slAfterTp1 ?? 'midpoint'} onChange={e => handleChange('slAfterTp1', e.target.value)} style={{ ...inputClass, appearance: 'auto' }}>
                <option value="midpoint">Midpoint</option>
                <option value="breakeven">Breakeven</option>
                <option value="none">Sin mover</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: '#888' }}>TP1 Min RR (estructural)</label>
              <input type="number" step="0.1" value={assetConfig.tp1StructuralMinRR ?? 0} onChange={e => handleChange('tp1StructuralMinRR', parseFloat(e.target.value) || 0)} style={inputClass} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: '#e6e6e6' }}>
              <input type="checkbox" checked={assetConfig.tp15BeEnabled ?? false} onChange={e => handleChange('tp15BeEnabled', e.target.checked)} style={{ accentColor: '#0088ff', width: '16px', height: '16px' }} />
              BE en TP1 (15m)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: '#e6e6e6' }}>
              <input type="checkbox" checked={assetConfig.atrTrailEnabled ?? false} onChange={e => handleChange('atrTrailEnabled', e.target.checked)} style={{ accentColor: '#0088ff', width: '16px', height: '16px' }} />
              Trailing ATR
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: '#e6e6e6' }}>
              <input type="checkbox" checked={assetConfig.structuralTrailEnabled ?? false} onChange={e => handleChange('structuralTrailEnabled', e.target.checked)} style={{ accentColor: '#0088ff', width: '16px', height: '16px' }} />
              Trailing estructural
            </label>
          </div>
          <div style={{ marginTop: '12px' }}>
            <label style={{ fontSize: '0.75rem', color: '#888' }}>{'ROI time-decay (JSON: {"0": 0.015, "30": 0.005})'}</label>
            <textarea
              rows={2}
              value={minimalRoiText}
              onChange={e => {
                const v = e.target.value;
                setMinimalRoiText(v);
                try {
                  handleChange('minimal_roi', JSON.parse(v));
                  setMinimalRoiError(false);
                } catch {
                  setMinimalRoiError(true);
                }
              }}
              style={{ ...inputClass, fontFamily: "'JetBrains Mono', monospace", resize: 'vertical', borderColor: minimalRoiError ? '#ff3333' : '#333' }}
            />
            {minimalRoiError && <div style={{ fontSize: '0.65rem', color: '#ff3333', marginTop: '4px' }}>JSON inválido — no se guardará hasta corregirlo</div>}
          </div>
        </div>

        {/* 🤖 TIMESFM (solo lectura — se gestiona con el tooling del shadow) */}
        <div style={{ ...cardClass, marginTop: '20px', borderColor: '#7c4dff30' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#7c4dff', marginBottom: '8px', fontSize: '0.9rem' }}>
            🤖 TimesFM (solo lectura)
          </h3>
          <pre style={{ fontSize: '0.75rem', color: '#aaa', background: '#000', padding: '12px', borderRadius: '6px', overflowX: 'auto', margin: 0 }}>
            {assetConfig.timesfm ? JSON.stringify(assetConfig.timesfm, null, 2) : '(sin config TimesFM)'}
          </pre>
          <div style={{ fontSize: '0.65rem', color: '#666', marginTop: '6px' }}>
            Este bloque se gestiona desde el tooling del shadow (enable_shadow.js / run_ab.py) — no se edita acá.
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
