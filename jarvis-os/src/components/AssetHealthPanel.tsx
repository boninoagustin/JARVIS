import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useToast } from './Toast';

// Salud de detección SMC por activo (roster completo de 30):
// - detection_health/{ticker} lo escribe el health/tune del VPS.
// - Estados: OK | REVISAR | OPTIMIZABLE | CANDIDATO_APAGAR
// - Botón Optimizar (REVISAR) → lanza el optimizador del activo (Kronos, background).
// - Botón Activar (si tras optimizar da ganancia y el activo está OFF) → enabled=true.

interface HealthDoc {
  ticker: string;
  baselineR: number | null;
  trades: number | null;
  status: string;
  bestR: number | null;
  bestParams: Record<string, any> | null;
  bestOosTrades?: number;
  evaluatedAt?: string;
}

interface AssetCfg {
  enabled?: boolean;
  disabledReason?: string;
}

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  OK: { label: '✅ OPERAR', color: '#22c55e' },
  REVISAR: { label: '🔧 REVISAR', color: '#eab308' },
  OPTIMIZABLE: { label: '🟢 OPTIMIZABLE', color: '#22c55e' },
  CANDIDATO_APAGAR: { label: '🚫 APAGAR', color: '#ef4444' },
};

export default function AssetHealthPanel() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Record<string, HealthDoc>>({});
  const [cfgs, setCfgs] = useState<Record<string, AssetCfg>>({});
  const [optimizing, setOptimizing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'detection_health'), (snap) => {
      const m: Record<string, HealthDoc> = {};
      snap.forEach((d) => { m[d.id] = d.data() as HealthDoc; });
      setHealth(m);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'asset_configs'), (snap) => {
      const m: Record<string, AssetCfg> = {};
      snap.forEach((d) => { m[d.id] = d.data() as AssetCfg; });
      setCfgs(m);
    });
    return unsub;
  }, []);

  const rows = useMemo(() => {
    const tickers = new Set<string>([...Object.keys(health), ...Object.keys(cfgs).filter(t => t !== 'GLOBAL')]);
    return [...tickers].sort().map((t) => ({ ticker: t, h: health[t], c: cfgs[t] }));
  }, [health, cfgs]);

  const isOn = (c?: AssetCfg) => c?.enabled === true && !(c.disabledReason && c.disabledReason.trim() !== '');

  const launchOptimize = async (ticker: string) => {
    setOptimizing((p) => ({ ...p, [ticker]: true }));
    try {
      const res = await fetch(`http://${window.location.hostname}:8000/api/detection/optimize?ticker=${ticker}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any).detail || res.statusText);
      toast(`⚙️ Optimización de ${ticker} lanzada (~10-15 min). La tabla se actualiza sola al terminar.`, 'success');
    } catch (e: any) {
      toast(`Error lanzando optimización: ${e.message}`, 'error');
    } finally {
      setOptimizing((p) => ({ ...p, [ticker]: false }));
    }
  };

  const launchHealthAll = async () => {
    try {
      const res = await fetch(`http://${window.location.hostname}:8000/api/detection/health-all`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any).detail || res.statusText);
      toast('📊 Evaluación de salud del pool lanzada (30-60s por activo).', 'success');
    } catch (e: any) {
      toast(`Error: ${e.message}`, 'error');
    }
  };

  const activate = async (ticker: string) => {
    if (!confirm(`¿Activar ${ticker} en vivo? El bot empezará a operarlo con su configuración actual (preset de detección tuneado + config Firestore).`)) return;
    try {
      await updateDoc(doc(db, 'asset_configs', ticker), { enabled: true, disabledReason: '' });
      toast(`✅ ${ticker} activado. El bot lo toma en caliente (listener de Firestore).`, 'success');
    } catch (e: any) {
      toast(`Error activando: ${e.message}`, 'error');
    }
  };

  const statusOf = (h?: HealthDoc) => h?.status ?? 'SIN_DATOS';

  return (
    <div style={{ padding: '20px', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>Salud de Activos (detección SMC)</h2>
        <button onClick={launchHealthAll} className="btn btn-primary">📊 Evaluar todo el pool</button>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        Estado medido con el motor real: baseline del preset actual sobre la historia completa. 🔧 REVISAR = pierde y
        vale la pena optimizar · 🚫 APAGAR = pierde y ninguna configuración lo arregla (problema de scoring/gestión).
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
            <th style={{ padding: '8px' }}>Activo</th>
            <th style={{ padding: '8px' }}>Operando</th>
            <th style={{ padding: '8px' }}>Salud</th>
            <th style={{ padding: '8px' }}>Baseline (R)</th>
            <th style={{ padding: '8px' }}>Mejor tras optimizar (R)</th>
            <th style={{ padding: '8px' }}>Trades</th>
            <th style={{ padding: '8px' }}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ ticker, h, c }) => {
            const st = STATUS_STYLE[statusOf(h)];
            const on = isOn(c);
            const reason = on ? '' : (c?.disabledReason || '—');
            const showActivate = !on && h && (h.status === 'OPTIMIZABLE' || (h.status === 'OK' && (h.baselineR ?? 0) > 0));
            return (
              <tr key={ticker} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '8px', fontWeight: 600 }}>{ticker}</td>
                <td style={{ padding: '8px' }}>
                  {on ? <span style={{ color: '#22c55e' }}>✅ ON</span> : <span style={{ color: '#ef4444' }} title={reason}>❌ OFF</span>}
                </td>
                <td style={{ padding: '8px', color: st?.color ?? '#888' }}>{st?.label ?? '… sin datos'}</td>
                <td style={{ padding: '8px', fontFamily: 'var(--font-mono)' }}>{h?.baselineR ?? '—'}</td>
                <td style={{ padding: '8px', fontFamily: 'var(--font-mono)' }}>{h?.bestR ?? '—'}</td>
                <td style={{ padding: '8px' }}>{h?.trades ?? '—'}</td>
                <td style={{ padding: '8px', display: 'flex', gap: '8px' }}>
                  {(statusOf(h) === 'REVISAR') && (
                    <button className="btn" disabled={!!optimizing[ticker]} onClick={() => launchOptimize(ticker)}>
                      {optimizing[ticker] ? '⚙️ Lanzando…' : '⚙️ Optimizar'}
                    </button>
                  )}
                  {showActivate && (
                    <button className="btn btn-primary" onClick={() => activate(ticker)}>🟢 Activar</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
