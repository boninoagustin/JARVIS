import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Settings, Sliders, Save, CheckCircle, AlertTriangle, RefreshCw, Shield, Zap, Target } from 'lucide-react';
import { useToast } from './Toast';

interface BotConfig {
  sniperCooldownMs: number;
  minPointsForBuy: number;
  minPointsForSell: number;
  baseRiskPercentage: number;
  slBufferPercent: number;
  fixedRR: number;
  oteEntryPercent: number;
  entryTrigger: 'CHOCH' | 'OTE' | 'BOTH';
}

const DEFAULT_CONFIG: BotConfig = {
  sniperCooldownMs: 180000,
  minPointsForBuy: 6,
  minPointsForSell: 6,
  baseRiskPercentage: 1.0,
  slBufferPercent: 0.1,
  fixedRR: 2.0,
  oteEntryPercent: 50,
  entryTrigger: 'OTE',
};

export default function AdminPanel() {
  const [config, setConfig] = useState<BotConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<'idle' | 'success' | 'error'>('idle');
  const [activeTab, setActiveTab] = useState<'triggers' | 'risk' | 'safety'>('triggers');
  const { toast } = useToast();

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, 'app_settings', 'bot_config'), (docSnap) => {
      if (docSnap.exists()) {
        setConfig({ ...DEFAULT_CONFIG, ...docSnap.data() } as BotConfig);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleChange = (key: keyof BotConfig, value: number | string) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setSaveFeedback('idle');
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveFeedback('idle');
    try {
      await setDoc(doc(db, 'app_settings', 'bot_config'), config, { merge: true });
      setSaveFeedback('success');
      toast('✅ Parámetros aplicados y guardados correctamente en la red de JARVIS', 'success');
    } catch (e) {
      console.error("Error saving config", e);
      setSaveFeedback('error');
      toast('❌ Error al guardar parámetros en Firestore', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRestoreDefaults = () => {
    setConfig(DEFAULT_CONFIG);
    setSaveFeedback('idle');
    toast('⚙️ Parámetros restaurados a valores por defecto. Recordá hacer click en APLICAR CAMBIOS para guardarlos.', 'info');
  };

  return (
    <div className="animate-fadeIn">
      <div className="panel-header" style={{ marginBottom: '16px' }}>
        <span><Settings size={14} style={{ marginRight: 8 }} /> PANEL DE CONTROL DE PARÁMETROS</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Configuración Centralizada de Algoritmo</span>
      </div>

      <div className="panel" style={{ maxWidth: '800px', margin: '0 auto', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.05)' }}>
        {/* HEADER PANEL */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)', margin: 0 }}>
            <Sliders size={18} color="var(--accent-gold)" /> SENSIBILIDAD DEL ALGORITMO
          </h3>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {saveFeedback === 'success' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent-green)', fontSize: '0.75rem', fontWeight: 600 }}>
                <CheckCircle size={14} /> GUARDADO CON ÉXITO
              </span>
            )}
            {saveFeedback === 'error' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent-red)', fontSize: '0.75rem', fontWeight: 600 }}>
                <AlertTriangle size={14} /> ERROR EN FIRESTORE
              </span>
            )}
            
            <button 
              onClick={handleRestoreDefaults}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px',
                backgroundColor: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)',
                border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer',
                fontSize: '0.75rem', fontWeight: 600, transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent-red)'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border-color)'}
            >
              <RefreshCw size={12} /> RESTAURAR
            </button>

            <button 
              onClick={handleSave}
              disabled={saving}
              style={{ 
                display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', 
                backgroundColor: saving ? 'var(--bg-panel-hover)' : 'var(--accent-gold)', 
                color: saving ? 'var(--text-secondary)' : 'var(--bg-base)',
                border: 'none', borderRadius: '4px', cursor: saving ? 'wait' : 'pointer',
                fontWeight: 700, fontSize: '0.75rem', transition: 'all 0.2s',
                boxShadow: '0 4px 10px rgba(255, 170, 0, 0.2)'
              }}
            >
              <Save size={14} /> {saving ? 'GUARDANDO...' : 'APLICAR CAMBIOS'}
            </button>
          </div>
        </div>

        {/* TABS DE NAVEGACIÓN TEMÁTICA */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
          <button
            onClick={() => setActiveTab('triggers')}
            style={{
              flex: 1, padding: '10px 14px', border: 'none', borderRadius: '6px',
              backgroundColor: activeTab === 'triggers' ? 'rgba(255,170,0,0.1)' : 'transparent',
              color: activeTab === 'triggers' ? 'var(--accent-gold)' : 'var(--text-secondary)',
              fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              borderBottom: activeTab === 'triggers' ? '2px solid var(--accent-gold)' : '2px solid transparent',
              transition: 'all 0.2s ease', fontSize: '0.75rem'
            }}
          >
            <Target size={14} /> 🎯 GATILLOS & BIAS
          </button>
          
          <button
            onClick={() => setActiveTab('risk')}
            style={{
              flex: 1, padding: '10px 14px', border: 'none', borderRadius: '6px',
              backgroundColor: activeTab === 'risk' ? 'rgba(0,136,255,0.1)' : 'transparent',
              color: activeTab === 'risk' ? '#0088ff' : 'var(--text-secondary)',
              fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              borderBottom: activeTab === 'risk' ? '2px solid #0088ff' : '2px solid transparent',
              transition: 'all 0.2s ease', fontSize: '0.75rem'
            }}
          >
            <Shield size={14} /> 🛡️ RIESGO & TAMAÑO
          </button>
          
          <button
            onClick={() => setActiveTab('safety')}
            style={{
              flex: 1, padding: '10px 14px', border: 'none', borderRadius: '6px',
              backgroundColor: activeTab === 'safety' ? 'rgba(124,77,255,0.1)' : 'transparent',
              color: activeTab === 'safety' ? '#7c4dff' : 'var(--text-secondary)',
              fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              borderBottom: activeTab === 'safety' ? '2px solid #7c4dff' : '2px solid transparent',
              transition: 'all 0.2s ease', fontSize: '0.75rem'
            }}
          >
            <Zap size={14} /> ⚡ COOLDOWN & LÍMITES
          </button>
        </div>

        {/* CONTENIDOS DE LAS PESTAÑAS */}
        <div style={{ minHeight: '320px' }}>
          
          {/* TAB 1: GATILLOS Y BIAS */}
          {activeTab === 'triggers' && (
            <div className="animate-fadeIn" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <label style={{ fontWeight: 700, fontSize: '0.85rem' }}>Puntos mínimos para BUY (Radar)</label>
                  <span className="mono" style={{ color: 'var(--accent-gold)', fontWeight: 700 }}>{config.minPointsForBuy} / 100</span>
                </div>
                <input 
                  type="range" 
                  min="1" 
                  max="100" 
                  step="1"
                  value={config.minPointsForBuy}
                  onChange={(e) => handleChange('minPointsForBuy', parseInt(e.target.value))}
                />
                <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: '8px', color: 'var(--text-tertiary)' }}>Puntuación mínima requerida en la Matriz de Alineación para aprobar una compra.</p>
              </div>

              <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <label style={{ fontWeight: 700, fontSize: '0.85rem' }}>Puntos mínimos para SELL (Radar)</label>
                  <span className="mono" style={{ color: 'var(--accent-gold)', fontWeight: 700 }}>{config.minPointsForSell} / 100</span>
                </div>
                <input 
                  type="range" 
                  min="1" 
                  max="100" 
                  step="1"
                  value={config.minPointsForSell}
                  onChange={(e) => handleChange('minPointsForSell', parseInt(e.target.value))}
                />
                <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: '8px', color: 'var(--text-tertiary)' }}>Puntuación mínima requerida en la Matriz de Alineación para aprobar una venta.</p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <label style={{ fontWeight: 700, fontSize: '0.85rem' }}>🚀 Tipo de Gatillo</label>
                  </div>
                  <select 
                    value={config.entryTrigger}
                    onChange={(e) => handleChange('entryTrigger', e.target.value)}
                    style={{ width: '100%', padding: '10px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none', fontWeight: 600, fontSize: '0.8rem' }}
                  >
                    <option value="OTE">Fibonacci (OTE)</option>
                    <option value="CHOCH">Ruptura Inicial (CHOCH)</option>
                    <option value="BOTH">Ambos Gatillos</option>
                  </select>
                  <p className="text-muted" style={{ fontSize: '0.7rem', marginTop: '8px', color: 'var(--text-tertiary)' }}>
                    OTE = Espera retroceso, CHOCH = Entra al confirmar la ruptura.
                  </p>
                </div>

                <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <label style={{ fontWeight: 700, fontSize: '0.85rem' }}>📉 Nivel Entrada OTE (%)</label>
                    <span className="mono" style={{ color: 'var(--accent-gold)', fontWeight: 700 }}>{config.oteEntryPercent}%</span>
                  </div>
                  <input 
                    type="range" 
                    min="10" 
                    max="90" 
                    step="1"
                    value={config.oteEntryPercent}
                    onChange={(e) => handleChange('oteEntryPercent', parseFloat(e.target.value))}
                  />
                  <p className="text-muted" style={{ fontSize: '0.7rem', marginTop: '8px', color: 'var(--text-tertiary)' }}>
                    Nivel Fibonacci para el gatillo OTE. Ej: 50 = 50%, 62 = 61.8%, 79 = 78.6%.
                  </p>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: RIESGO Y TAMAÑO */}
          {activeTab === 'risk' && (
            <div className="animate-fadeIn" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              <div style={{ padding: '16px', border: '1px solid #0088ff', borderRadius: '6px', backgroundColor: 'rgba(0,136,255,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <label style={{ fontWeight: 700, fontSize: '0.85rem', color: '#0088ff' }}>🎯 TP2 Fijo — Risk:Reward Ratio</label>
                  <span className="mono" style={{ color: '#0088ff', fontWeight: 700 }}>{config.fixedRR}x</span>
                </div>
                <input 
                  type="range" 
                  min="1" 
                  max="5" 
                  step="0.1"
                  value={config.fixedRR}
                  onChange={(e) => handleChange('fixedRR', parseFloat(e.target.value))}
                />
                <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: '8px', color: 'var(--text-tertiary)' }}>
                  Multiplicador del riesgo (distancia entrada→SL) para colocar el TP2.
                  <br/><span style={{ color: 'var(--accent-gold)', fontWeight: 600 }}>Ejemplo: Riesgo $100. TP2 a 2.0x = $200 de ganancia.</span>
                </p>
              </div>

              <div style={{ padding: '16px', border: '1px solid var(--accent-red)', borderRadius: '6px', backgroundColor: 'rgba(255,51,51,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <label style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--accent-red)' }}>🛡️ SL Buffer — Filtro Anti-Sweeps</label>
                  <span className="mono" style={{ color: 'var(--accent-red)', fontWeight: 700 }}>{config.slBufferPercent}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="0.5" 
                  step="0.01"
                  value={config.slBufferPercent}
                  onChange={(e) => handleChange('slBufferPercent', parseFloat(e.target.value))}
                />
                <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: '8px', color: 'var(--text-tertiary)' }}>
                  Distancia porcentual extra del Stop Loss respecto al origin para absorber spikes y falsas rupturas de liquidez.
                  <br/><span style={{ color: 'var(--accent-gold)', fontWeight: 600 }}>Ejemplo BTCUSD a $78,000: 0.1% = ~$78 de margen extra.</span>
                </p>
              </div>

              <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <label style={{ fontWeight: 700, fontSize: '0.85rem' }}>Riesgo Base por Operación (%)</label>
                  <span className="mono" style={{ color: 'var(--accent-gold)', fontWeight: 700 }}>{config.baseRiskPercentage}%</span>
                </div>
                <input 
                  type="range" 
                  min="0.1" 
                  max="5.0" 
                  step="0.1"
                  value={config.baseRiskPercentage}
                  onChange={(e) => handleChange('baseRiskPercentage', parseFloat(e.target.value))}
                />
                <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: '8px', color: 'var(--text-tertiary)' }}>Porcentaje sugerido de riesgo del balance total de la cuenta asignado a cada trade.</p>
              </div>

            </div>
          )}

          {/* TAB 3: COOLDOWN Y LÍMITES */}
          {activeTab === 'safety' && (
            <div className="animate-fadeIn" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              <div style={{ padding: '16px', border: '1px solid #7c4dff', borderRadius: '6px', backgroundColor: 'rgba(124,77,255,0.02)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <label style={{ fontWeight: 700, fontSize: '0.85rem', color: '#7c4dff' }}>⏳ Sniper Cooldown (Minutos)</label>
                  <span className="mono" style={{ color: '#7c4dff', fontWeight: 700 }}>{config.sniperCooldownMs / 60000} minutos</span>
                </div>
                <input 
                  type="range" 
                  min="60000" 
                  max="7200000" 
                  step="60000"
                  value={config.sniperCooldownMs}
                  onChange={(e) => handleChange('sniperCooldownMs', parseInt(e.target.value))}
                />
                <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: '8px', color: 'var(--text-tertiary)' }}>
                  Tiempo de espera obligatorio tras disparar una operación para un activo. Previene el overtrading y el FOMO tras un trade.
                </p>
              </div>

              {/* Tarjeta de Advertencia Premium de Firestore */}
              <div style={{ padding: '16px', backgroundColor: 'rgba(255,193,7,0.05)', border: '1px solid rgba(255,193,7,0.15)', borderRadius: '6px', display: 'flex', gap: '12px', alignItems: 'center' }}>
                <AlertTriangle size={24} color="var(--accent-gold)" style={{ flexShrink: 0 }} />
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                  <strong style={{ color: 'var(--accent-gold)' }}>Nota de Continuidad:</strong> Estos parámetros modifican el motor de confluencias de la red en tiempo real. Cualquier cambio se sincronizará con el Bot de Telegram y las alertas de mercado activas.
                </div>
              </div>

            </div>
          )}

        </div>
      </div>
    </div>
  );
}
