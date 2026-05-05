import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Settings, Sliders, Save, CheckCircle, AlertTriangle } from 'lucide-react';
import { useToast } from './Toast';

interface BotConfig {
  sniperCooldownMs: number;
  minPointsForBuy: number;
  minPointsForSell: number;
  baseRiskPercentage: number;
}

const DEFAULT_CONFIG: BotConfig = {
  sniperCooldownMs: 180000,
  minPointsForBuy: 6,
  minPointsForSell: 6,
  baseRiskPercentage: 1.0,
};

export default function AdminPanel() {
  const [config, setConfig] = useState<BotConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<'idle' | 'success' | 'error'>('idle');
  const { toast } = useToast();

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, 'app_settings', 'bot_config'), (docSnap) => {
      if (docSnap.exists()) {
        setConfig({ ...DEFAULT_CONFIG, ...docSnap.data() } as BotConfig);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleChange = (key: keyof BotConfig, value: number) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setSaveFeedback('idle');
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveFeedback('idle');
    try {
      await setDoc(doc(db, 'app_settings', 'bot_config'), config, { merge: true });
      setSaveFeedback('success');
      toast('Parámetros guardados correctamente', 'success');
    } catch (e) {
      console.error("Error saving config", e);
      setSaveFeedback('error');
      toast('Error al guardar parámetros', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="panel-header">
        <span><Settings size={14} style={{ marginRight: 8 }} /> PANEL DE CONTROL DE PARÁMETROS</span>
      </div>

      <div className="panel" style={{ maxWidth: '800px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
            <Sliders size={18} /> SENSIBILIDAD DEL ALGORITMO
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {saveFeedback === 'success' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent-green)', fontSize: '0.8rem' }}>
                <CheckCircle size={14} /> Guardado
              </span>
            )}
            {saveFeedback === 'error' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent-red)', fontSize: '0.8rem' }}>
                <AlertTriangle size={14} /> Error
              </span>
            )}
            <button 
              onClick={handleSave}
              disabled={saving}
              style={{ 
                display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', 
                backgroundColor: saving ? 'var(--bg-panel-hover)' : 'var(--accent-gold)', 
                color: saving ? 'var(--text-secondary)' : 'var(--bg-base)',
                border: 'none', borderRadius: '4px', cursor: saving ? 'wait' : 'pointer',
                fontWeight: 600, fontFamily: 'var(--font-mono)', transition: 'all 0.2s'
              }}
            >
              <Save size={16} /> {saving ? 'GUARDANDO...' : 'APLICAR CAMBIOS'}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
              <label style={{ fontWeight: 600 }}>Puntos mínimos para BUY (Radar)</label>
              <span className="mono" style={{ color: 'var(--accent-gold)' }}>{config.minPointsForBuy} / 8</span>
            </div>
            <input 
              type="range" 
              min="1" 
              max="8" 
              step="1"
              value={config.minPointsForBuy}
              onChange={(e) => handleChange('minPointsForBuy', parseInt(e.target.value))}
            />
            <p className="text-muted" style={{ fontSize: '0.8rem', marginTop: '8px' }}>Puntuación mínima requerida en la Matriz de Alineación para aprobar una compra.</p>
          </div>

          <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
              <label style={{ fontWeight: 600 }}>Puntos mínimos para SELL (Radar)</label>
              <span className="mono" style={{ color: 'var(--accent-gold)' }}>{config.minPointsForSell} / 8</span>
            </div>
            <input 
              type="range" 
              min="1" 
              max="8" 
              step="1"
              value={config.minPointsForSell}
              onChange={(e) => handleChange('minPointsForSell', parseInt(e.target.value))}
            />
            <p className="text-muted" style={{ fontSize: '0.8rem', marginTop: '8px' }}>Puntuación mínima requerida en la Matriz de Alineación para aprobar una venta.</p>
          </div>

          <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
              <label style={{ fontWeight: 600 }}>Sniper Cooldown (Minutos)</label>
              <span className="mono" style={{ color: 'var(--accent-gold)' }}>{config.sniperCooldownMs / 60000} mins</span>
            </div>
            <input 
              type="range" 
              min="60000" 
              max="7200000" 
              step="60000"
              value={config.sniperCooldownMs}
              onChange={(e) => handleChange('sniperCooldownMs', parseInt(e.target.value))}
            />
            <p className="text-muted" style={{ fontSize: '0.8rem', marginTop: '8px' }}>Tiempo de enfriamiento obligatorio entre operaciones en un mismo activo para evitar overtrading.</p>
          </div>

          <div style={{ padding: '16px', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
              <label style={{ fontWeight: 600 }}>Riesgo Base por Operación (%)</label>
              <span className="mono" style={{ color: 'var(--accent-gold)' }}>{config.baseRiskPercentage}%</span>
            </div>
            <input 
              type="range" 
              min="0.1" 
              max="5.0" 
              step="0.1"
              value={config.baseRiskPercentage}
              onChange={(e) => handleChange('baseRiskPercentage', parseFloat(e.target.value))}
            />
            <p className="text-muted" style={{ fontSize: '0.8rem', marginTop: '8px' }}>Riesgo recomendado para el cálculo de tamaño de posición (Informativo por ahora).</p>
          </div>

        </div>
      </div>
    </div>
  );
}
