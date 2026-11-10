import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useToast } from './Toast';
import { assetRecommendation } from '../services/assetRecommendation';

// Recomendación operativa única desde roster_proposals.
// detection_health muestra diagnósticos, nunca recomendaciones paralelas de activar/apagar.
// Las acciones fuera de roster son manuales, secundarias y requieren confirmación explícita.

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
  optimizingAt?: string | null;
  tunedAt?: string | null;
  tuneDecision?: string | null;
  lastTune?: any;
}

interface AssetCfg {
  enabled?: boolean;
  disabledReason?: string;
  riskPercent?: number;
  rosterOverride?: { verdict?: string };
}

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  OK: { label: 'Baseline positivo', color: '#22c55e' },
  REVISAR: { label: 'Revisar detección', color: '#eab308' },
  OPTIMIZANDO: { label: '⏳ OPTIMIZANDO...', color: '#38bdf8' },
  OPTIMIZABLE: { label: 'Candidato de tune positivo', color: '#22c55e' },
  CANDIDATO_APAGAR: { label: 'Detección débil', color: '#eab308' },
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

  // 05-nov-2026: propuesta de roster (TRADE/WATCH/OFF) por evidencia y cluster.
  const [roster, setRoster] = useState<Record<string, any>>({});
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'roster_proposals'), (snap) => {
      const m: Record<string, any> = {};
      snap.forEach((d) => { if (d.id !== '_SUMMARY') m[d.id] = d.data(); });
      setRoster(m);
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
        case 'recommendation': return roster[r.ticker]?.verdict ?? 'SIN PROPUESTA';
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
  }, [health, cfgs, sort, props, roster]);

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

  const activate = async (ticker: string, manual = false) => {
    try {
      // Re-read evidence when clicked: a background weekly run may have changed the roster.
      const [rp, hp, cp, risk] = await Promise.all([
        getDoc(doc(db, 'roster_proposals', ticker)), getDoc(doc(db, 'detection_health', ticker)),
        getDoc(doc(db, 'asset_configs', ticker)), getDoc(doc(db, 'risk_proposals', ticker)),
      ]);
      const cfg = cp.data() as AssetCfg | undefined;
      const decision = assetRecommendation({ on: isOn(cfg), roster: rp.data(), healthAt: hp.data()?.evaluatedAt,
        operatorOverride: cfg?.rosterOverride?.verdict === 'TRADE', riskVerdict: risk.data()?.verdict });
      if (!manual && decision.action !== 'activate') {
        toast(`No activar recomendado: ${decision.reason}`, 'error');
        return;
      }
      const message = manual
        ? `EXCEPCIÓN MANUAL: ${ticker} no tiene una recomendación vigente de activar. ${decision.reason}\n\n¿Activarlo de todos modos con el riesgo configurado? Esto NO cambia su roster ni lo convierte en TRADE recomendado.`
        : `¿Activar ${ticker} según el roster TRADE? Usará el riesgo configurado, sin aumentarlo. Las propuestas de riesgo se aprueban por separado.`;
      if (!confirm(message)) return;
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

  const activateByPaper = async (ticker: string) => {
    try {
      // Releer evidencia al pulsar: el ciclo semanal puede haberla cambiado.
      const [rp, pp] = await Promise.all([
        getDoc(doc(db, 'roster_proposals', ticker)), getDoc(doc(db, 'paper_trades', ticker)),
      ]);
      const roster = rp.data() as any;
      const paper = pp.data() as any;
      if (roster?.paperReady !== true) {
        toast('La evidencia paper ya no está vigente. Refrescá y revisá el roster.', 'error');
        return;
      }
      const n = Number(paper?.n ?? 0);
      const wr = paper?.wr != null ? Number(paper.wr) : 0;
      const exp = paper?.expectancy != null ? Number(paper.expectancy) : 0;
      const message = `🧪 Activar ${ticker} por evidencia paper.\n\n${n} cierres simulados · WR ${(wr * 100).toFixed(0)}% · ${exp >= 0 ? '+' : ''}${exp.toFixed(2)}R/tr.\n\nEl candidato está certificado forward y el paper es positivo. Es una decisión tuya: usa el riesgo configurado (sin aumentarlo) y NO convierte el roster en TRADE.`;
      if (!confirm(message)) return;
      await setDoc(doc(db, 'asset_configs', ticker), { enabled: true, disabledReason: '' }, { merge: true });
      try {
        const atRef = doc(db, 'optimization_config', 'active_tickers');
        const atSnap = await getDoc(atRef);
        const cur: string[] = atSnap.exists() && Array.isArray(atSnap.data()?.tickers) ? atSnap.data().tickers : [];
        if (!cur.includes(ticker)) await setDoc(atRef, { tickers: [...cur, ticker], updatedAt: new Date().toISOString() }, { merge: true });
      } catch (err) { console.warn('No se pudo auto-promover a active_tickers:', err); }
      toast(`✅ ${ticker} activado por evidencia paper. El bot lo toma en caliente.`, 'success');
    } catch (e: any) {
      toast(`Error activando por paper: ${e.message}`, 'error');
    }
  };

  // 03-nov-2026: faltaba el botón para apagar. Escribe disabledReason para que sea una
  // decisión del operador explícita (el rollout y el auto-disable la respetan).
  const deactivate = async (ticker: string) => {
    if (!confirm(`¿Pausar nuevas entradas de ${ticker}? Es reversible. Esta acción no envía órdenes de cierre ni modifica posiciones abiertas. WATCH sigue en optimización; PARKED recibe health semanal.`)) return;
    try {
      await setDoc(doc(db, 'asset_configs', ticker), {
        enabled: false,
        disabledReason: `desactivado desde Salud de Activos (${new Date().toISOString().slice(0, 10)})`,
      }, { merge: true });
      toast(`⏸ ${ticker}: nuevas entradas pausadas. No se enviaron órdenes de cierre.`, 'success');
    } catch (e: any) {
      toast(`Error apagando: ${e.message}`, 'error');
    }
  };

  const statusOf = (h?: HealthDoc) => h?.status ?? 'SIN_DATOS';
  const ago = (iso?: string | null) => {
    if (!iso) return '';
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1 ? 'ahora' : m < 60 ? `hace ${m}m` : `hace ${Math.floor(m / 60)}h`;
  };
  // 03-nov-2026: si el job muere, el doc queda en OPTIMIZANDO para siempre → botón de rescate.
  const resetOptimizing = async (ticker: string) => {
    if (!confirm(`¿Reiniciar el estado de ${ticker}? El proceso puede seguir corriendo en el VPS (revisá /tmp/detection_opt_${ticker}.log).`)) return;
    try {
      await setDoc(doc(db, 'detection_health', ticker), { status: health[ticker]?.baselineStatus ?? 'REVISAR', optimizingAt: null }, { merge: true });
      toast(`Estado de ${ticker} reiniciado.`, 'success');
    } catch (e: any) {
      toast(`Error: ${e.message}`, 'error');
    }
  };

  // El "Lanzando…" local dura hasta que Firestore confirma OPTIMIZANDO (evita el parpadeo del botón).
  useEffect(() => {
    setOptimizing((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const t of Object.keys(prev)) {
        if (prev[t] && health[t]?.status === 'OPTIMIZANDO') { next[t] = false; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [health]);

  return (
    <div style={{ padding: '20px', maxWidth: '1600px', margin: '0 auto', overflowX: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0 }}>Salud de Activos (detección SMC)</h2>
        <button onClick={launchHealthAll} className="btn btn-primary">📊 Evaluar todo el pool</button>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        <strong>El roster define la recomendación.</strong> TRADE: activar o mantener activo. WATCH: pausar entradas y seguir optimizando.
        {' '}PARKED / OFF: mantener apagado. Las acciones requieren tu confirmación y no cierran posiciones abiertas.
      </p>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
        TRADE exige ≥ 0,05 R/tr, ≥ 30 trades, viabilidad y cupo (máx. 2 por cluster / 10 en total).
        {' '}La detección y el riesgo son diagnósticos separados: un baseline positivo no equivale a una recomendación de activar.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
            {([['ticker', 'Activo'], ['on', 'Entradas'], ['recommendation', 'Recomendación del roster'], ['status', 'Diagnóstico de detección'], ['baselineR', 'Baseline (R)'],
              ['bestR', 'Mejor tras optimizar (R)'], ['avgR', 'R/tr'], ['riskProp', 'Riesgo (separado)'], ['trades', 'Trades'], ['actions', 'Acciones']] as const).map(([key, label]) => (
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
            const recommendation = assetRecommendation({ on, roster: roster[ticker], healthAt: h?.evaluatedAt,
              operatorOverride: c?.rosterOverride?.verdict === 'TRADE', riskVerdict: props[ticker]?.verdict });
            return (
              <tr key={ticker} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '8px', fontWeight: 600 }}>{ticker}</td>
                <td style={{ padding: '8px' }}>
                  {on ? <span style={{ color: '#22c55e' }}>✅ ON</span> : <span style={{ color: '#ef4444' }} title={reason}>❌ OFF</span>}
                </td>
                <td style={{ padding: '8px', minWidth: 200 }}>
                  <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{recommendation.rosterLabel}</span>
                  <strong style={{ display: 'block', color: recommendation.color }}>{recommendation.label}</strong>
                  <span style={{ display: 'block', marginTop: 4, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{recommendation.reason}</span>
                  {roster[ticker]?.paperReady && (
                    <span style={{ display: 'block', marginTop: 4, fontSize: '0.72rem', color: '#38bdf8' }} title="Excepción al roster: la detección es floja, pero la gestión mejorada gana en datos forward (simulados). Activarla es decisión tuya; no es P&L real.">
                      🧪 Paper-ready (excepción): gestión gana pese a detección floja · {roster[ticker].paperTrades} trades · WR {(Number(roster[ticker].paperWr) * 100).toFixed(0)}% · +{Number(roster[ticker].paperExp).toFixed(2)}R/tr
                    </span>
                  )}
                  {roster[ticker]?.generatedAt && <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>Roster: {ago(roster[ticker].generatedAt)}</span>}
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
                          Configurado: {Number.isFinite(Number(c?.riskPercent)) ? `${Number(c?.riskPercent).toFixed(2)}%` : 'global'}
                          <span style={{ display: 'block' }}>Propuesta: {Number.isFinite(Number(pr.proposalPct)) ? `${Number(pr.proposalPct).toFixed(2)}%` : '—'} · {pr.verdict}</span>
                        </span>
                        <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.68rem' }}>No activa el activo ni garantiza una entrada.</span>
                        {(pr.verdict === 'SUBIR' || pr.verdict === 'BAJAR') && !pr.applied && (
                          <button className="btn" style={{ marginLeft: 6, padding: '2px 6px', fontSize: '0.72rem' }}
                            onClick={() => applyRisk(ticker, Number(pr.proposalPct))}>Aplicar solo riesgo</button>
                        )}
                      </>
                    );
                  })()}
                </td>
                <td style={{ padding: '8px' }}>{h?.trades ?? '—'}</td>
                <td style={{ padding: '8px', minWidth: 220 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
                  {(() => {
                    const st = statusOf(h);
                    const since = h?.optimizingAt ? new Date(h.optimizingAt) : null;
                    const stuck = since ? Date.now() - since.getTime() > 45 * 60 * 1000 : false;
                    // 03-nov-2026: mientras el server diga OPTIMIZANDO NO se muestra el botón
                    // (antes reaparecía al instante porque el POST vuelve enseguida y no se
                    // sabía si estaba corriendo).
                    if (st === 'OPTIMIZANDO') {
                      return (
                        <>
                          <span style={{ color: stuck ? '#eab308' : '#38bdf8', fontSize: '0.85rem' }}>
                            {stuck ? '⚠️ Estancado' : '⏳ Optimizando…'}{since ? ` desde ${since.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}` : ''}
                          </span>
                          {stuck && (
                            <button className="btn" style={{ padding: '2px 6px', fontSize: '0.72rem' }} onClick={() => resetOptimizing(ticker)}>Reiniciar estado</button>
                          )}
                        </>
                      );
                    }
                    return (
                      <>
                        {(st === 'REVISAR' || st === 'CANDIDATO_APAGAR') && (
                          <button className="btn" disabled={!!optimizing[ticker]} onClick={() => {
                            if (on && !confirm(`${ticker} está OPERANDO. Optimizar corre 60 trials (~10-30 min) y, si mejora, aplica el preset y reinicia el bot. ¿Seguir?`)) return;
                            launchOptimize(ticker);
                          }}>
                            {optimizing[ticker] ? '⏳ Lanzando…' : '⚙️ Optimizar'}
                          </button>
                        )}
                        {h?.tunedAt && (
                          <span
                            title={(() => {
                              const t = h.lastTune;
                              const head = `Última optimización: ${new Date(h.tunedAt).toLocaleString('es-AR')}`;
                              if (!t) return head;
                              return `${head}\nCandidato: train ${t.candTrainR}R → OOS ${t.candOosR}R (${t.candOosTrades}t)\nActual:    train ${t.actTrainR}R → OOS ${t.actOosR}R (${t.actOosTrades}t)${t.reason ? `\n${t.reason}` : ''}`;
                            })()}
                            style={{ fontSize: '0.7rem', color: h.tuneDecision === 'APPLIED' ? '#22c55e' : '#eab308' }}>
                            últ.: {ago(h.tunedAt)} · {h.tuneDecision === 'APPLIED' ? 'aplicó' : 'no aplicó'}
                          </span>
                        )}
                      </>
                    );
                  })()}
                  {recommendation.action === 'activate' && (
                    <button className="btn btn-primary" onClick={() => activate(ticker)}>Activar recomendado</button>
                  )}
                  {recommendation.action === 'pause' && (
                    <button className="btn" onClick={() => deactivate(ticker)} title="Pausa nuevas entradas; no envía órdenes de cierre">Pausar nuevas entradas</button>
                  )}
                  {roster[ticker]?.paperReady && !on && (
                    <button className="btn btn-primary" onClick={() => activateByPaper(ticker)} title="Excepción al roster: detección floja pero gestión validada forward. Activarlo es tu decisión con el riesgo actual, sin convertirlo en TRADE.">
                      🧪 Activar (excepción por paper)
                    </button>
                  )}
                  <details style={{ fontSize: '0.72rem' }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Acciones manuales</summary>
                    {!on && recommendation.action !== 'activate' && (
                      <>
                        <p>Fuera de recomendación. No convierte el roster en TRADE.</p>
                        <button className="btn" onClick={() => activate(ticker, true)}>Activar manualmente (excepción)</button>
                      </>
                    )}
                    {on && recommendation.action !== 'pause' && (
                      <button className="btn" onClick={() => deactivate(ticker)}>Pausar manualmente</button>
                    )}
                    {((!on && recommendation.action === 'activate') || (on && recommendation.action === 'pause')) && (
                      <span>La acción recomendada está disponible arriba.</span>
                    )}
                  </details>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
