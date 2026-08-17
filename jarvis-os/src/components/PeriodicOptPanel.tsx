import { useEffect, useState } from 'react';
import { collection, getDocs, doc, setDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useToast } from './Toast';
import { Rocket, RefreshCw, AlertTriangle, Clock, ShieldCheck } from 'lucide-react';

// ─── Tipos de los reportes del Centro de Optimización (opt_reports) ────────────
interface OosMetrics {
    expectancy?: number; profit_factor?: number; net_pnl_r?: number;
    max_drawdown_r?: number; win_rate?: number; trade_count?: number;
}
interface OptReport {
    ticker: string; timestamp: number; status: 'RECOMMEND' | 'HOLD' | 'ERROR';
    reason?: string; delta?: { d_exp_oos: number; dd_improve_ratio: number; pnl_drop_ratio: number };
    proposal_oos?: OosMetrics; production_oos?: OosMetrics;
    best_config?: Record<string, any>;
    appliedAt?: number; new_trades?: number;
}

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
];

const fmtR = (v?: number) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const fmtPct = (v?: number) => (v === undefined || v === null ? '—' : `${(v * 100).toFixed(1)}%`);

export default function PeriodicOptPanel() {
    const { toast } = useToast();
    const [reports, setReports] = useState<OptReport[]>([]);
    const [loading, setLoading] = useState(true);
    const [confirming, setConfirming] = useState<{ ticker: string; diff: { label: string; old: string; new: string }[] } | null>(null);
    const [applying, setApplying] = useState<string | null>(null);

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

    useEffect(() => { fetchReports(); }, []);

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
        if (diff.length === 0) {
            toast(`La propuesta de ${ticker} ya está aplicada — no hay cambios`, 'success');
            return;
        }
        setConfirming({ ticker, diff });
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
                    <div className="modal-content-premium" onClick={e => e.stopPropagation()} style={{ borderColor: 'var(--border-color)', maxWidth: '460px' }}>
                        <div className="modal-header-premium" style={{ justifyContent: 'space-between', width: '100%' }}>
                            <span style={{ color: 'var(--accent-gold)' }}>🚀</span>
                            <h3 style={{ margin: 0 }}>APLICAR OPTIMIZACIÓN — {confirming.ticker}</h3>
                        </div>
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
                        <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
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
