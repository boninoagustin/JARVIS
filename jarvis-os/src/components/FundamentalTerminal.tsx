import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Terminal, AlertTriangle, ShieldAlert } from 'lucide-react';

interface AppSettings {
  killswitches: Record<string, boolean>;
}

const DEFAULT_ASSETS = ['BTCUSD', 'EURUSD', 'US100', 'XAUUSD'];

export default function FundamentalTerminal() {
  const [settings, setSettings] = useState<AppSettings>({ killswitches: {} });
  
  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, 'app_settings', 'global'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as Partial<AppSettings>;
        setSettings({ killswitches: data.killswitches || {} });
      }
    });
    return () => unsubscribe();
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

  return (
    <div>
      <div className="panel-header">
        <span><Terminal size={14} style={{ marginRight: 8 }} /> FUNDAMENTAL TERMINAL & KILLSWITCHES</span>
      </div>
      
      <div className="grid-2">
        <div className="panel">
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

        <div className="panel">
          <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-gold)' }}>
            <AlertTriangle size={18} /> CALENDARIO ECONÓMICO (MOCK)
          </h3>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '16px' }}>
            Próximos eventos de alto impacto. La integración con Finnhub/AlphaVantage será programada aquí.
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>TIEMPO</th>
                <th>DIVISA</th>
                <th>EVENTO</th>
                <th>IMPACTO</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>En 15 min</td>
                <td>USD</td>
                <td>CPI (Mensual)</td>
                <td><span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>ALTO</span></td>
              </tr>
              <tr>
                <td>En 2 horas</td>
                <td>EUR</td>
                <td>Tasa de Interés ECB</td>
                <td><span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>ALTO</span></td>
              </tr>
              <tr>
                <td>Mañana 09:30</td>
                <td>USD</td>
                <td>NFP</td>
                <td><span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>ALTO</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
