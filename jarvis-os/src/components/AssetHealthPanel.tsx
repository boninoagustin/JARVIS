import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, doc, updateDoc, getDoc, setDoc } from 'firebase/firestore';
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
  avgR?: number | null;
  baselineStatus?: string;
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
  OPTIMIZANDO: { label: '⏳ OPTIMIZANDO...', color: '#38bdf8' },
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

  // 03-nov-2026: propuestas de riesgo (risk_allocator, semanal). Sólo se muestran; aplicar es 1 click.
  const [props, setProps] = useState<Record<string, any>>({});
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'risk_proposals'), (snap) => {
      const m: Record<string, any> = {};
      snap.forEach((d) => { if (d.id !== '_SUMMARY') m[d.id] = d.data(); });
      setProps(m);
    }, () => { });
    return unsub;
  }, []);

  const applyRisk = async (ticker: string, pct: number) => {
    if (!confirm(`¿Aplicar riesgo ${pct.toFixed(2)}% a ${ticker}? El bot lo toma en caliente (listener de Firestore).`)) return;
    try {
      await setDoc(doc(db, 'asset_configs', ticker), {
        riskPercent: pct,
        riskPercentUpdatedAt: new Date().toISOString(),
        riskPercentUpdatedBy: 'panel:risk_allocator',
      }, { merge: true });
      await setDoc(doc(db, 'risk_proposals', ticker), { applied: true, appliedAt: new Date().toISOString() }, { merge: true });
      toast(`✅ ${ticker}: riesgo ${pct.toFixed(2)}% aplicado.`, 'success');
    } catch (e: any) {
      toast(`Error aplicando riesgo: ${e.message}`, 'error');
    }
  };

  // 03-nov-2026: tabla ordenable. Default: baseline R de mayor a menor.
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'baselineR', dir: -1 });
  const toggleSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }));
  const rows = useMemo(() => {
    const tickers = new Set<string>([...Object.keys(health), ...Object.keys(cfgs).filter(t => t !== 'GLOBAL')]);
    const arr = [...tickers].map((t) => ({ ticker: t, h: health[t], c: cfgs[t] }));
    const onVal = (c?: AssetCfg) => (c?.enabled === true && !(c?.disabledReason && c.disabledReason.trim() !== '') ? 1 : 0);
    const val = (r: { ticker: string; h?: HealthDoc; c?: AssetCfg }) => {
      switch (sort.key) {
        case 'ticker': return r.ticker;
        case 'on': return onVal(r.c);
        case 'status': return r.h?.status ?? 'SIN_DATOS';
        case 'bestR': return r.h?.bestR ?? -9999;
        case 'avgR': return r.h?.avgR ?? -9999;
        case 'trades': return r.h?.trades ?? -1;
        case 'riskProp': return props[r.ticker]?.proposalPct ?? -1;
        default: return r.h?.baselineR ?? -9999;
      }
    };
    return arr.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string' || typeof vb === 'string') return sort.dir * String(va).localeCompare(String(vb));
      return sort.dir * ((va as number) - (vb as number));
    });
  }, [health, cfgs, sort, props]);

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
      await setDoc(doc(db, 'asset_configs', ticker), { enabled: true, disabledReason: '' }, { merge: true });
      // 🚀 Promover a active_tickers para que el optimizador semanal lo procese
      try {
        const atRef = doc(db, 'optimization_config', 'active_tickers');
        const atSnap = await getDoc(atRef);
        const cur: string[] = atSnap.exists() && Array.isArray(atSnap.data()?.tickers) ? atSnap.data().tickers : [];
        if (!cur.includes(ticker)) {
          await setDoc(atRef, { tickers: [...cur, ticker], updatedAt: new Date().toISOString() }, { merge: true });
        }
      } catch (err) {
        console.warn('No se pudo auto-promover a active_tickers:', err);
      }
      // 03-nov-2026: activar NO debe reescribir detection_health — antes ponía status 'OK'
      // y borraba el veredicto del tune (OPTIMIZABLE / CANDIDATO_APAGAR).
      toast(`✅ ${ticker} activado. El bot lo toma en caliente (listener de Firestore).`, 'success');
    } catch (e: any) {
      toast(`Error activando: ${e.message}`, 'error');
    }
  };

  // 03-nov-2026: faltaba el botón para apagar. Escribe disabledReason para que sea una
  // decisión del operador explícita (el rollout y el auto-disable la respetan).
  const deactivate = async (ticker: string) => {
    if (!confirm(`¿Apagar ${ticker}? Deja de operar en vivo (reversible). El optimizador semanal lo sigue evaluando.`)) return;
    try {
      await setDoc(doc(db, 'asset_configs', ticker), {
        enabled: false,
        disabledReason: `desactivado desde Salud de Activos (${new Date().toISOString().slice(0, 10)})`,
      }, { merge: true });
      toast(`🛑 ${ticker} apagado.`, 'success');
    } catch (e: any) {
      toast(`Error apagando: ${e.message}`, 'error');
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
            {([['ticker', 'Activo'], ['on', 'Operando'], ['status', 'Salud'], ['baselineR', 'Baseline (R)'],
              ['bestR', 'Mejor tras optimizar (R)'], ['avgR', 'R/tr'], ['riskProp', 'Riesgo'], ['trades', 'Trades'], ['actions', 'Acciones']] as const).map(([key, label]) => (
              <th key={key} onClick={() => key !== 'actions' && toggleSort(key)}
                title={key === 'actions' ? undefined : 'Clic para ordenar'}
                style={{ padding: '8px', cursor: key === 'actions' ? 'default' : 'pointer', userSelect: 'none' }}>
                {label}{sort.key === key ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ ticker, h, c }) => {
            const st = STATUS_STYLE[statusOf(h)];
            const on = isOn(c);
            const reason = on ? '' : (c?.disabledReason || '—');
            const showActivate = !on && h && (h.status === 'OPTIMIZABLE' || (h.bestR !== null && (h.bestR ?? 0) > 0) || (h.status === 'OK' && (h.baselineR ?? 0) > 0));
            return (
              <tr key={ticker} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '8px', fontWeight: 600 }}>{ticker}</td>
                <td style={{ padding: '8px' }}>
                  {on ? <span style={{ color: '#22c55e' }}>✅ ON</span> : <span style={{ color: '#ef4444' }} title={reason}>❌ OFF</span>}
                </td>
                <td style={{ padding: '8px', color: st?.color ?? '#888' }}>
                  {st?.label ?? '… sin datos'}
                  {h?.baselineStatus && h.baselineStatus !== h.status && (
                    <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary, #888)' }}>baseline: {h.baselineStatus}</span>
                  )}
                </td>
                <td style={{ padding: '8px', fontFamily: 'var(--font-mono)' }}>{h?.baselineR ?? '—'}</td>
                <td style={{ padding: '8px', fontFamily: 'var(--font-mono)' }}>{h?.bestR ?? '—'}</td>
                <td style={{ padding: '8px', fontFamily: 'var(--font-mono)', color: (h?.avgR ?? 0) < 0 ? '#ef4444' : '#22c55e' }}>{h?.avgR != null ? h.avgR.toFixed(3) : '—'}</td>
                <td style={{ padding: '8px', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  {(() => {
                    const pr = props[ticker];
                    if (!pr) return '—';
                    const color = pr.verdict === 'SUBIR' ? '#22c55e' : pr.verdict === 'BAJAR' ? '#eab308' : pr.verdict === 'NO_OPERAR' ? '#ef4444' : '#888';
                    return (
                      <>
                        <span style={{ color }} title={`${pr.verdict} · ${pr.note || ''}`}>
                          {(Number(pr.currentPct) ?? 0).toFixed(2)}% → {(Number(pr.proposalPct) ?? 0).toFixed(2)}%
                        </span>
                        {(pr.verdict === 'SUBIR' || pr.verdict === 'BAJAR') && !pr.applied && (
                          <button className="btn" style={{ marginLeft: 6, padding: '2px 6px', fontSize: '0.72rem' }}
                            onClick={() => applyRisk(ticker, Number(pr.proposalPct))}>Aplicar</button>
                        )}
                      </>
                    );
                  })()}
                </td>
                <td style={{ padding: '8px' }}>{h?.trades ?? '—'}</td>
                <td style={{ padding: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {statusOf(h) === 'OPTIMIZANDO' && (
                    <span style={{ color: '#38bdf8', fontSize: '0.85rem' }}>⏳ En proceso...</span>
                  )}
                  {(statusOf(h) === 'REVISAR' || statusOf(h) === 'CANDIDATO_APAGAR') && (
                    <button className="btn" disabled={!!optimizing[ticker]} onClick={() => {
                      // 03-nov-2026: también se puede optimizar un activo QUE ESTÁ OPERANDO
                      // (antes el botón sólo aparecía para los apagados). Si aplica, reinicia el bot.
                      if (on && !confirm(`${ticker} está OPERANDO. Optimizar corre 60 trials (~10-30 min) y, si mejora, aplica el preset y reinicia el bot. ¿Seguir?`)) return;
                      launchOptimize(ticker);
                    }}>
                      {optimizing[ticker] ? '⚙️ Lanzando…' : '⚙️ Optimizar'}
                    </button>
                  )}
                  {showActivate && (
                    <button className="btn btn-primary" onClick={() => activate(ticker)}>🟢 Activar</button>
                  )}
                  {/* 03-nov-2026: "Apagar" sólo se destaca cuando el activo NO está bien
                      (CANDIDATO_APAGAR = recomendación; REVISAR = opción sensata). En un activo
                      OK/OPTIMIZABLE queda como link discreto: es una acción, no un consejo. */}
                  {on && (statusOf(h) === 'CANDIDATO_APAGAR' || statusOf(h) === 'REVISAR') && (
                    <button className="btn" onClick={() => deactivate(ticker)} title="Deshabilitar el activo en vivo (reversible)">🛑 Apagar</button>
                  )}
                  {on && (statusOf(h) === 'OK' || statusOf(h) === 'OPTIMIZABLE') && (
                    <>
                      <span style={{ color: '#22c55e', fontSize: '0.85rem' }}>✓ Calibrado</span>
                      <a onClick={() => deactivate(ticker)} title="Deshabilitar (reversible) — sólo si querés sacarlo del pool activo"
                        style={{ fontSize: '0.72rem', color: '#888', cursor: 'pointer', textDecoration: 'underline' }}>deshabilitar</a>
                    </>
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
