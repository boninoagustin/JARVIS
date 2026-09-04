import { useEffect, useState } from 'react';
import { collection, getDocs, doc, setDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useToast } from './Toast';
import { Rocket, RefreshCw, AlertTriangle, Clock, ShieldCheck, HeartPulse } from 'lucide-react';

// ─── Tipos de los reportes del Centro de Optimización (opt_reports) ────────────
interface OosMetrics {
    expectancy?: number; profit_factor?: number; net_pnl_r?: number;
    max_drawdown_r?: number; win_rate?: number; trade_count?: number;
}
interface OptReport {
    ticker: string; timestamp: number; status: 'RECOMMEND' | 'HOLD' | 'ERROR' | 'REFRESH_ERROR';
    reason?: string; delta?: { d_exp_oos: number; dd_improve_ratio: number; pnl_drop_ratio: number };
    proposal_oos?: OosMetrics; production_oos?: OosMetrics;
    best_config?: Record<string, any>;
    // F3-etapa3: ahora incluye gestión de salida por gatillo (partialClosePct, slAfterTp1,
    // tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled) además de enabled/entryPercent.
    session_apply?: Record<string, Record<string, Record<string, any>>>;
    ks_proposal?: { maxDailyLossR: number; maxConsecutiveLosses: number; score: number };
    shadow_week?: { n: number; approve: number; downgrade: number; reject: number; note?: string };
    oos_split?: { train: number; test: number };
    data_refreshed_at?: number;
    appliedAt?: number; new_trades?: number;
}

// ─── Health-check (health_check/latest) ───────────────────────────────────────
interface HealthItem { check: string; status: 'PASS' | 'WARN' | 'FAIL'; detail: string }
interface HealthReport { timestamp: number; status: 'OK' | 'FAIL'; items: HealthItem[] }

// Mapeo best_config (espacio hyperopt) → asset_configs (producción).
// 🚫 sessions/quedan fuera: el hyperopt las optimiza con el esquema del backtest
//    (tp2/slBuff por gatillo) que NO mapea 1:1 al esquema live → F3 con validación.
const APPLY_FIELDS: { src: string; dst: string; label: string; fmt: (v: any) => string }[] = [
    { src: 'minBuyPoints', dst: 'minPointsForBuy', label: 'Puntos Mín. BUY', fmt: v => String(Math.round(v)) },
    { src: 'minSellPoints', dst: 'minPointsForSell', label: 'Puntos Mín. SELL', fmt: v => String(Math.round(v)) },
    { src: 'fixedRR', dst: 'fixedRR', label: 'R:R Fijo (TP2)', fmt: v => Number(v).toFixed(2) },
    { src: 'slBufferPercent', dst: 'slBufferPercent', label: 'SL Buffer %', fmt: v => Number(v).toFixed(3) },
    { src: 'oteEntryPercent', dst: 'oteEntryPercent', label: 'OTE Entry %', fmt: v => String(Math.round(v)) },
    { src: 'minimal_roi', dst: 'minimal_roi', label: 'ROI time-decay', fmt: v => JSON.stringify(v) },
    // F3-etapa3: TP1 estructural a nivel activo (fallback cuando el gatillo no lo tiene)
    { src: 'tp1StructuralMinRR', dst: 'tp1StructuralMinRR', label: 'TP1 min RR estructural', fmt: v => Number(v).toFixed(2) },
];

const fmtR = (v?: number) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const fmtPct = (v?: number) => (v === undefined || v === null ? '—' : `${(v * 100).toFixed(1)}%`);

export default function PeriodicOptPanel() {
    const { toast } = useToast();
    const [reports, setReports] = useState<OptReport[]>([]);
    const [loading, setLoading] = useState(true);
    const [confirming, setConfirming] = useState<{
        ticker: string;
        diff: { label: string; old: string; new: string }[];
        mergedSessions: Record<string, Record<string, any>> | null;
    } | null>(null);
    const [applying, setApplying] = useState<string | null>(null);
    const [health, setHealth] = useState<HealthReport | null>(null);

    const fetchReports = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(collection(db, 'opt_reports'));
            const data = snap.docs.map(d => ({ ...(d.data() as OptReport), id: d.id }));
            setReports(data.sort((a, b) => b.timestamp - a.timestamp));
        } catch (err) {
            console.error('Error fetching opt_reports:', err);
            toast('Error al cargar reportes de optimización', 'error');
        } finally {
            setLoading(false);
        }
    };

    const fetchHealth = async () => {
        try {
            const hsnap = await getDoc(doc(db, 'health_check', 'latest'));
            if (hsnap.exists()) setHealth(hsnap.data() as HealthReport);
        } catch (err) {
            console.error('Error fetching health_check:', err);
        }
    };

    useEffect(() => { fetchReports(); fetchHealth(); }, []);

    const prepareApply = async (report: OptReport) => {
        const ticker = report.ticker;
        const currentSnap = await getDoc(doc(db, 'asset_configs', ticker));
        const current = currentSnap.exists() ? currentSnap.data() : {};
        const diff: { label: string; old: string; new: string }[] = [];
        for (const f of APPLY_FIELDS) {
            const proposed = report.best_config?.[f.src];
            if (proposed === undefined || proposed === null) continue;
            const cur = current[f.dst];
            const newStr = f.fmt(proposed);
            const oldStr = cur === undefined || cur === null ? '(sin configurar)' : f.fmt(cur);
            if (oldStr !== newStr) diff.push({ label: f.label, old: oldStr, new: newStr });
        }
        // Sesiones: SOLO enabled/entryPercent por gatillo (lo que el motor live lee).
        // Merge profundo: Firestore merge es shallow — si no fusionamos acá, se pisa toda la sesión.
        let mergedSessions: Record<string, Record<string, any>> | null = null;
        const sessionDiff: { label: string; old: string; new: string }[] = [];
        if (report.session_apply && Object.keys(report.session_apply).length > 0) {
            const currentSessions = (current.sessions || {}) as Record<string, Record<string, any>>;
            mergedSessions = JSON.parse(JSON.stringify(currentSessions));
            for (const [session, triggers] of Object.entries(report.session_apply)) {
                mergedSessions[session] = mergedSessions[session] || {};
                for (const [trig, changes] of Object.entries(triggers)) {
                    mergedSessions[session][trig] = { ...(mergedSessions[session][trig] || {}), ...changes };
                    const curT = currentSessions[session]?.[trig] || {};
                    for (const [k, v] of Object.entries(changes)) {
                        const oldV = curT[k] === undefined ? '(sin configurar)' : String(curT[k]);
                        if (String(v) !== String(curT[k])) sessionDiff.push({ label: `${session}/${trig} · ${k}`, old: oldV, new: String(v) });
                    }
                }
            }
        }
        diff.push(...sessionDiff);
        if (diff.length === 0) {
            toast(`La propuesta de ${ticker} ya está aplicada — no hay cambios`, 'success');
            return;
        }
        setConfirming({ ticker, diff, mergedSessions });
    };

    const confirmApply = async () => {
        if (!confirming) return;
        const ticker = confirming.ticker;
        setApplying(ticker);
        try {
            const report = reports.find(r => r.ticker === ticker)!;
            const payload: Record<string, any> = { updatedAt: new Date().toISOString(), updatedBy: 'periodic_opt' };
            for (const f of APPLY_FIELDS) {
                const proposed = report.best_config?.[f.src];
                if (proposed !== undefined && proposed !== null) payload[f.dst] = proposed;
            }
            if (confirming.mergedSessions) payload.sessions = confirming.mergedSessions;
            await setDoc(doc(db, 'asset_configs', ticker), payload, { merge: true });
            await setDoc(doc(db, 'opt_reports', ticker), { appliedAt: Date.now(), appliedBy: 'operador' }, { merge: true });
            toast(`✅ Optimización aplicada para ${ticker}`, 'success');
            setConfirming(null);
            fetchReports();
        } catch (e) {
            console.error(e);
            toast(`❌ Error aplicando optimización de ${ticker}`, 'error');
        } finally {
            setApplying(null);
        }
    };

    const statusBadge = (r: OptReport) => {
        if (r.appliedAt) return <span style={{ ...badge, background: '#0088ff20', color: '#0088ff', borderColor: '#0088ff40' }}>✓ APLICADA</span>;
        if (r.status === 'RECOMMEND') return <span style={{ ...badge, background: '#00e67620', color: '#00e676', borderColor: '#00e67640' }}>● RECOMIENDA APLICAR</span>;
        if (r.status === 'ERROR') return <span style={{ ...badge, background: '#ff333320', color: '#ff3333', borderColor: '#ff333340' }}>⚠ ERROR</span>;
        return <span style={{ ...badge, background: '#333', color: '#aaa', borderColor: '#444' }}>— SIN CAMBIOS</span>;
    };

    const badge: React.CSSProperties = { fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', border: '1px solid' };

    const card: React.CSSProperties = { padding: '20px', backgroundColor: '#0a0a0a', border: '1px solid #222', borderRadius: '8px' };

    if (loading) return <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>Cargando reportes de optimización...</div>;

    return (
        <div className="animate-fadeIn" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '16px', borderBottom: '1px solid #222' }}>
                <div>
                    <h2 style={{ color: '#e6e6e6', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
                        <Rocket size={20} color="#ffaa00" /> Optimización Periódica
                    </h2>
                    <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '4px', marginBottom: 0 }}>
                        Hyperopt semanal (OOS 70/30) vs. producción actual. El sistema <b>nunca aplica solo</b> — la decisión es tuya.
                    </p>
                </div>
                <button onClick={fetchReports} style={{ padding: '8px 16px', background: '#111', color: '#e6e6e6', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <RefreshCw size={14} /> Refrescar
                </button>
            </div>

            {/* 🩺 Health-check del sistema (health_check/latest) */}
            {health && (
                <div style={{ ...card, borderColor: health.status === 'OK' ? '#00e67640' : '#ff333350' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                        <h3 style={{ margin: 0, color: '#e6e6e6', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <HeartPulse size={18} color={health.status === 'OK' ? '#00e676' : '#ff3333'} />
                            {health.status === 'OK' ? 'Sistema sano' : 'Algo falla — revisar'}
                        </h3>
                        <span style={{ fontSize: '0.75rem', color: '#666' }}>
                            {new Date(health.timestamp).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
                        </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }}>
                        {health.items.map(i => (
                            <div key={i.check} style={{ display: 'flex', gap: '8px', fontSize: '0.8rem', alignItems: 'flex-start' }}>
                                <span style={{ flexShrink: 0 }}>{i.status === 'PASS' ? '✅' : i.status === 'FAIL' ? '❌' : '⚠️'}</span>
                                <span style={{ color: i.status === 'FAIL' ? '#ff3333' : i.status === 'WARN' ? '#ffaa00' : '#aaa' }}>{i.detail}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {reports.length === 0 && (
                <div style={{ ...card, textAlign: 'center', padding: '48px' }}>
                    <Clock size={28} color="#888" />
                    <p style={{ color: '#aaa', marginTop: '12px' }}>Sin reportes todavía.</p>
                    <p style={{ color: '#666', fontSize: '0.85rem' }}>
                        La primera corrida completa corre el domingo a las 02:00 (mercado cerrado) y cubre los 10 activos (~1.5-2h).
                    </p>
                </div>
            )}

            {reports.map(r => (
                <div key={r.ticker} style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                        <h3 style={{ margin: 0, color: '#e6e6e6', fontSize: '1.1rem' }}>{r.ticker}</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                {new Date(r.timestamp).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
                            </span>
                            {statusBadge(r)}
                        </div>
                    </div>

                    {r.status === 'ERROR' && (
                        <p style={{ color: '#ff3333', fontSize: '0.85rem', marginTop: '12px' }}>🛑 {r.reason}</p>
                    )}
                    {r.status === 'HOLD' && !r.appliedAt && (
                        <p style={{ color: '#aaa', fontSize: '0.85rem', marginTop: '12px' }}>⏸️ {r.reason || 'Sin mejora OOS suficiente — se mantiene la producción.'}</p>
                    )}

                    {r.production_oos && r.proposal_oos && (
                        <>
                            <table style={{ width: '100%', marginTop: '16px', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                                <thead>
                                    <tr style={{ color: '#888', textAlign: 'left' }}>
                                        <th style={{ padding: '6px 8px' }}>Métrica (OOS)</th>
                                        <th style={{ padding: '6px 8px' }}>Producción</th>
                                        <th style={{ padding: '6px 8px' }}>Propuesta</th>
                                        <th style={{ padding: '6px 8px' }}>Δ</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {([
                                        ['Expectativa (R)', 'expectancy', fmtR],
                                        ['Profit Factor', 'profit_factor', fmtR],
                                        ['Max Drawdown (R)', 'max_drawdown_r', fmtR],
                                        ['PnL Neto (R)', 'net_pnl_r', fmtR],
                                        ['Win Rate', 'win_rate', fmtPct],
                                        ['Trades', 'trade_count', (v: any) => String(v ?? '—')],
                                    ] as [string, string, (v: any) => string][]).map(([label, key, fmt]) => {
                                        const oldV = (r.production_oos as any)[key];
                                        const newV = (r.proposal_oos as any)[key];
                                        const better = key === 'max_drawdown_r' ? newV < oldV : newV > oldV;
                                        const color = newV === oldV ? '#aaa' : better ? '#00e676' : '#ff3333';
                                        return (
                                            <tr key={key} style={{ borderTop: '1px solid #1a1a1a' }}>
                                                <td style={{ padding: '6px 8px', color: '#aaa' }}>{label}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{fmt(oldV)}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{fmt(newV)}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace', color }}>{fmt(newV)}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>

                            {r.delta && (
                                <div style={{ display: 'flex', gap: '12px', marginTop: '12px', flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: '0.75rem', color: '#00e676' }}>Δ Expectativa: {r.delta.d_exp_oos >= 0 ? '+' : ''}{r.delta.d_exp_oos.toFixed(3)}R</span>
                                    <span style={{ fontSize: '0.75rem', color: '#00e676' }}>DD mejorado: {(r.delta.dd_improve_ratio * 100).toFixed(0)}%</span>
                                    <span style={{ fontSize: '0.75rem', color: r.delta.pnl_drop_ratio > 0.1 ? '#ffaa00' : '#888' }}>PnL: {(r.delta.pnl_drop_ratio * 100).toFixed(0)}%</span>
                                </div>
                            )}
                        </>
                    )}

                    {/* 🛡️ KS propuesta + 🌙 shadow + 📊 ventana OOS (fuera del condicional: visible aunque no haya propuesta) */}
                    <div style={{ display: 'flex', gap: '16px', marginTop: '14px', flexWrap: 'wrap', fontSize: '0.78rem', color: '#aaa' }}>
                        {r.ks_proposal && (
                            <span title="Propuesta del killswitch sweep (NO se aplica acá — editalo en Panel de Control)">
                                🛡️ <b>KS propuesta:</b> maxDLR {r.ks_proposal.maxDailyLossR}R · maxCL {r.ks_proposal.maxConsecutiveLosses}
                            </span>
                        )}
                        {r.shadow_week && (
                            <span title="Shadow TimesFM — decisiones de los últimos 7 días">
                                🌙 <b>Shadow 7d:</b> {r.shadow_week.n} decisiones ({r.shadow_week.approve}✓/{r.shadow_week.downgrade}↓/{r.shadow_week.reject}✗)
                            </span>
                        )}
                        {r.oos_split && (
                            <span title="Ventana de validación out-of-sample del backtest">
                                📊 <b>OOS:</b> {r.oos_split.train} train / {r.oos_split.test} test
                            </span>
                        )}
                        {r.data_refreshed_at && (
                            <span title="Última regeneración de los CSVs SMC (walk-forward)">
                                🗓️ <b>Datos:</b> {new Date(r.data_refreshed_at).toLocaleDateString('es-AR')}
                            </span>
                        )}
                    </div>
                    {r.session_apply && Object.keys(r.session_apply).length > 0 && (
                        <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '8px', marginBottom: 0 }}>
                            ⚙️ La propuesta incluye ajustes por gatillo (enabled/entryPercent) — se muestran en el modal de confirmación.
                        </p>
                    )}

                    {r.status === 'RECOMMEND' && !r.appliedAt && (
                        <button
                            onClick={() => prepareApply(r)}
                            disabled={applying === r.ticker}
                            style={{ marginTop: '16px', padding: '10px 20px', background: '#00e676', color: '#000', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applying === r.ticker ? 'wait' : 'pointer' }}
                        >
                            {applying === r.ticker ? 'APLICANDO...' : 'REVISAR Y APLICAR'}
                        </button>
                    )}
                </div>
            ))}

            {/* Modal de confirmación con diff */}
            {confirming && (
                <div className="modal-overlay" onClick={() => setConfirming(null)}>
                    <div className="modal-content-premium" onClick={e => e.stopPropagation()} style={{ borderColor: 'var(--border-color)', maxWidth: '460px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <div className="modal-header-premium" style={{ justifyContent: 'space-between', width: '100%', flexShrink: 0 }}>
                            <span style={{ color: 'var(--accent-gold)' }}>🚀</span>
                            <h3 style={{ margin: 0 }}>APLICAR OPTIMIZACIÓN — {confirming.ticker}</h3>
                        </div>
                        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: '4px' }}>
                        <p style={{ fontSize: '0.8rem', color: '#888' }}>Cambios que se van a escribir en asset_configs:</p>
                        <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                            <tbody>
                                {confirming.diff.map(d => (
                                    <tr key={d.label} style={{ borderBottom: '1px solid #1a1a1a' }}>
                                        <td style={{ padding: '8px 4px', color: '#aaa' }}>{d.label}</td>
                                        <td style={{ padding: '8px 4px', color: '#ff3333', fontFamily: 'monospace' }}>{d.old}</td>
                                        <td style={{ padding: '8px 4px', color: '#888' }}>→</td>
                                        <td style={{ padding: '8px 4px', color: '#00e676', fontFamily: 'monospace' }}>{d.new}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '8px' }}>
                            <ShieldCheck size={12} style={{ verticalAlign: '-2px' }} /> Se escribe SOLO lo listado (merge). Sesiones/gatillos no se tocan. El bot toma la config nueva al instante (listener Firestore).
                        </p>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', marginTop: '14px', flexShrink: 0 }}>
                            <button onClick={() => setConfirming(null)} style={{ flex: 1, padding: '10px', background: '#111', color: '#e6e6e6', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer' }}>Cancelar</button>
                            <button onClick={confirmApply} disabled={applying === confirming.ticker} style={{ flex: 1, padding: '10px', background: '#00e676', color: '#000', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applying === confirming.ticker ? 'wait' : 'pointer' }}>
                                {applying === confirming.ticker ? 'APLICANDO...' : 'CONFIRMAR'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
