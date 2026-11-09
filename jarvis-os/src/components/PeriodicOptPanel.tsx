import { useEffect, useState } from 'react';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useToast } from './Toast';
import { Rocket, RefreshCw, Clock, HeartPulse } from 'lucide-react';
import { reportScope, reportMetrics, metricDelta, pnlChangeLabel, reportVerdict, mlDiagnostic, isFreshReport, filterEvidence, activationRecommendation } from '../services/periodicOptPresentation';

// ─── Tipos de los reportes del Centro de Optimización (opt_reports) ────────────
interface OosMetrics {
    expectancy?: number; profit_factor?: number; net_pnl_r?: number;
    max_drawdown_r?: number; win_rate?: number; trade_count?: number;
}
interface WeeklyFollowup { status?: string; reason?: string; at?: number | string }
interface WeeklyApplication {
    status?: string; reason?: string; at?: number | string; report_timestamp?: number;
    asset_fingerprint?: string; followup?: WeeklyFollowup;
}
interface WeeklyApplied extends WeeklyApplication {
    applied_asset_fingerprint?: string; prev_path?: string;
}
interface WeeklyAutoState {
    applied?: Record<string, WeeklyApplied>;
    latest?: Record<string, WeeklyApplication>;
}
interface WeeklyConfigMetadata {
    autotune?: { report_timestamp?: number; applied_at_ms?: number; asset_fingerprint?: string; tracking_id?: string };
    updatedBy?: string;
    currentSnapshot?: Record<string, any>;
}
interface OptReport {
    ticker: string; timestamp: number; status: string;
    reason?: string; delta?: { d_exp_oos: number; dd_improve_ratio: number; pnl_drop_ratio: number };
    proposal_oos?: OosMetrics; production_oos?: OosMetrics;
    proposal_validation?: OosMetrics; production_validation?: OosMetrics;
    evaluation_certificate?: { validation_role?: string };
    certificate?: { validation_role?: string };
    selection_outcome?: string;
    last_successful_selection?: unknown;
    best_config?: Record<string, any>;
    // F3-etapa3: ahora incluye gestión de salida por gatillo (partialClosePct, slAfterTp1,
    // tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled) además de enabled/entryPercent.
    session_apply?: Record<string, Record<string, Record<string, any>>>;
    ks_proposal?: { maxDailyLossR: number; maxConsecutiveLosses: number; score: number };
    shadow_week?: { n: number; approve: number; downgrade: number; reject: number; note?: string };
    oos_split?: { train: number; test: number };
    data_refreshed_at?: number;
    appliedAt?: number; new_trades?: number;
    application?: WeeklyApplication;
    followup?: WeeklyFollowup;
    final_asset_config?: Record<string, any>;
    final_asset_fingerprint?: string;
    production_asset_snapshot?: Record<string, any>;
    production_asset_fingerprint?: string;
    // 🆕 sep-2026: veredicto Monte Carlo + propuestas nuevas del dominical
    montecarlo?: { survival?: number; verdict?: string; verdict_short?: string; n?: number };
    timesfm_apply?: { minScoreToOverrideReject?: number; source?: string } | null;
    bias_confluence?: {
        status?: string;
        recommended?: {
            bc: { tfs: string[]; minForFull: number; minForHalf: number; fullPts: number; halfPts: number };
            metrics: Record<string, any>; objective: number; margin_vs_baseline: number;
        } | null;
        note?: string;
    } | null;
}

// 🆕 sep-2026: propuesta de gatillos perdedores (gatillo×sesión) — opt_reports/LOSER_TRIGGERS_PROPOSAL
interface LoserProp { ticker: string; session: string; trigger: string; n: number; exp: number; action: string }
interface LoserReport { generatedAt?: string; status?: string; disables: LoserProp[]; enables: LoserProp[] }

// 🆕 sep-2026: Asset Scout (buscador de activos del sábado) — opt_reports/ASSET_SCOUT
interface ScoutRow {
    ticker: string; cat: string; symbol?: string; error?: string; verdict?: string; costSec?: number;
    full?: { n: number; wr: number; netR: number; pf: number; exp: number; maxDD: number };
    win84?: { n: number; wr: number; netR: number; pf: number; exp: number; maxDD: number };
}
interface ScoutReport { generatedAt?: string; windowDays?: number; universe?: string[]; results: ScoutRow[] }

// ─── Health-check (health_check/latest) ───────────────────────────────────────
interface HealthItem { check: string; status: 'PASS' | 'WARN' | 'FAIL'; detail: string }
interface HealthReport { timestamp: number; status: 'OK' | 'FAIL'; items: HealthItem[] }


const fmtR = (v?: number) => (!Number.isFinite(v) ? '—' : Number(v).toFixed(2));
const fmtPct = (v?: number) => (!Number.isFinite(v) ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

// Browser-safe identity comparison: never import the Node-only hashing/protocol
// module into Vite. Display a recorded hash only after matching its exact payload.
function normalizedSnapshot(value: any): string {
    const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize)
        : item !== null && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
            : item;
    return JSON.stringify(normalize(JSON.parse(JSON.stringify(value))));
}

function weeklyOperationalStatus(report: OptReport, autoState: WeeklyAutoState = {}, config: WeeklyConfigMetadata = {}, stateError: string | null = null) {
    const applied = autoState.applied?.[report.ticker];
    const latest = autoState.latest?.[report.ticker];
    // A prior application must never mark a new weekly candidate as applied.
    const validReportTimestamp = typeof report.timestamp === 'number' && Number.isFinite(report.timestamp);
    const sameReport = (entry?: WeeklyApplication) => validReportTimestamp && entry?.report_timestamp === report.timestamp;
    const application = (sameReport(latest) ? latest : undefined) ?? report.application;
    const appliedForReport = sameReport(applied) ? applied : undefined;
    const metadataForReport = validReportTimestamp && config.autotune?.report_timestamp === report.timestamp ? config.autotune : undefined;
    const applicationStatus = application?.status ?? (appliedForReport || metadataForReport ? 'APPLIED' : undefined);
    const currentFollowup = (sameReport(latest) ? latest?.followup : undefined) ?? report.followup ?? report.application?.followup;
    // Keep the previous config's pending/review evidence visible when a new report replaces it.
    const followup = currentFollowup ?? applied?.followup ?? latest?.followup;
    const followupReportTimestamp = currentFollowup ? report.timestamp
        : applied?.followup ? applied.report_timestamp : latest?.followup ? latest.report_timestamp : undefined;
    let followupLabel = 'Seguimiento posterior: sin información';
    switch (followup?.status) {
        case 'PENDING': followupLabel = 'Seguimiento posterior pendiente (PENDING)'; break;
        case 'KEEP': followupLabel = 'Seguimiento posterior: conservar (KEEP)'; break;
        case 'ROLLBACK': followupLabel = 'Seguimiento posterior: revertir (ROLLBACK)'; break;
        case undefined: break;
        default: followupLabel = `Seguimiento posterior: estado desconocido (${followup?.status})`;
    }
    let applicationLabel = 'Aplicación sin información';
    switch (applicationStatus) {
        case 'APPLIED': applicationLabel = 'Aplicación automática registrada (no confirma recepción del bot)'; break;
        case 'UNCHANGED': applicationLabel = 'Sin cambio registrado · validez actual no acreditada'; break;
        case 'BLOCKED': applicationLabel = 'Aplicación bloqueada'; break;
        case 'ROLLED_BACK': applicationLabel = 'Restauración registrada · validez actual no acreditada'; break;
        case 'ERROR': applicationLabel = 'Error de aplicación'; break;
        case undefined:
            if (stateError) applicationLabel = 'Estado automático no disponible';
            else if (report.appliedAt) applicationLabel = 'Aplicación registrada (legado)';
            else if (report.status === 'RECOMMEND') applicationLabel = 'Candidata de investigación · aplicación no acreditada';
            else if (report.status === 'HOLD' || report.status === 'HOLD_MC') applicationLabel = 'Sin cambio registrado · validez actual no acreditada';
            break;
        default: applicationLabel = `Estado de aplicación desconocido (${applicationStatus})`;
    }
    let version = config.autotune?.asset_fingerprint || 'Sin versión informada';
    if (config.currentSnapshot && (report.final_asset_config || report.production_asset_snapshot)) {
        const current = normalizedSnapshot(config.currentSnapshot);
        if (report.final_asset_config && current === normalizedSnapshot(report.final_asset_config) && report.final_asset_fingerprint)
            version = report.final_asset_fingerprint;
        else if (report.production_asset_snapshot && current === normalizedSnapshot(report.production_asset_snapshot) && report.production_asset_fingerprint)
            version = report.production_asset_fingerprint;
        else version = 'Configuración actual diferente de los snapshots del reporte';
    }
    return {
        applicationLabel,
        reason: application?.reason ?? (applicationStatus === 'BLOCKED' || applicationStatus === 'ERROR' ? 'Sin motivo informado' : report.reason),
        appliedAt: application?.at ?? (applicationStatus === 'APPLIED'
            ? appliedForReport?.at ?? metadataForReport?.applied_at_ms
            : applicationStatus === undefined ? report.appliedAt : undefined),
        version,
        trackingId: config.autotune?.tracking_id ?? (application as any)?.tracking_id,
        updatedBy: config.updatedBy,
        registeredVersion: applied?.applied_asset_fingerprint,
        followupLabel,
        followupReason: followup?.reason === 'future_interval_not_yet_available'
            ? 'Todavía no hay datos posteriores para comparar; el registro no acredita recepción del bot.'
            : followup?.reason === 'insufficient_trades' ? 'Todavía no hay suficientes operaciones para comparar ambas configuraciones.'
                : followup?.reason,
        followupReportTimestamp,
    };
}

function WeeklyOperationalStatus({ report, autoState = {}, config = {}, stateError = null }: {
    report: OptReport; autoState?: WeeklyAutoState; config?: WeeklyConfigMetadata; stateError?: string | null;
}) {
    const status = weeklyOperationalStatus(report, autoState, config, stateError);
    const date = status.appliedAt ? new Date(status.appliedAt) : null;
    return <div role="status" style={{ marginTop: '16px', padding: '12px', border: '1px solid #333', borderRadius: '4px', color: '#ccc', fontSize: '0.8rem' }}>
        <b>{status.applicationLabel}</b>
        {stateError && <div style={{ color: '#ffaa00' }}>{stateError}</div>}
        {date && Number.isFinite(date.getTime()) && <div>Fecha registrada: {date.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}</div>}
        {status.reason && <div>{status.reason}</div>}
        <div style={{ marginTop: '8px', overflowWrap: 'anywhere' }}>Versión de configuración actual (metadatos): <code>{status.version}</code></div>
        {status.trackingId && <div>Seguimiento: <code>{status.trackingId}</code></div>}
        {status.updatedBy && <div>Actualizada por: {status.updatedBy}</div>}
        {status.registeredVersion && status.registeredVersion !== status.version && <div style={{ overflowWrap: 'anywhere' }}>Última versión automática registrada: <code>{status.registeredVersion}</code></div>}
        <div style={{ marginTop: '8px' }}><b>{status.followupLabel}</b></div>
        {status.followupReportTimestamp !== undefined && status.followupReportTimestamp !== report.timestamp && <div>Revisión de una aplicación anterior · reporte {new Date(status.followupReportTimestamp).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}</div>}
        {status.followupReason && <div>{status.followupReason}</div>}
        <div style={{ marginTop: '8px', color: '#888' }}>Estado registrado en almacenamiento; sin confirmación de recepción del bot.</div>
    </div>;
}

export default function PeriodicOptPanel() {
    const { toast } = useToast();
    const [reports, setReports] = useState<OptReport[]>([]);
    const [autoState, setAutoState] = useState<WeeklyAutoState>({});
    const [configMetadata, setConfigMetadata] = useState<Record<string, WeeklyConfigMetadata>>({});
    const [stateError, setStateError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const [health, setHealth] = useState<HealthReport | null>(null);
    // 🆕 sep-2026: reporte de gatillos perdedores (gatillo×sesión) + desactivar activo
    const [loser, setLoser] = useState<LoserReport | null>(null);
    // 🆕 16-sep-2026: GATE ML por activo (ml_gate_evals = sweep publicado; mlGateOn = mlGateEnabled en asset_configs)
    const [mlEvals, setMlEvals] = useState<Record<string, any>>({});
    const [mlGateOn, setMlGateOn] = useState<Record<string, boolean>>({});
    // 🆕 16-sep-2026: FILTRO CORRELACIÓN por activo (corr_gate_evals = contrafactual; corrOn = correlationFilter.shadow===false)
    const [corrEvals, setCorrEvals] = useState<Record<string, any>>({});
    const [corrOn, setCorrOn] = useState<Record<string, boolean>>({});
    // 🆕 16-sep-2026: FILTRO TIMESFM por activo (timesfm_gate_evals = contrafactual; tfmOn = timesfm.enabled)
    const [tfmEvals, setTfmEvals] = useState<Record<string, any>>({});
    const [tfmOn, setTfmOn] = useState<Record<string, boolean>>({});
    // 🆕 16-sep-2026: señales bloqueadas (blocked_signals_evals = contrafactual simulado)
    const [blkEvals, setBlkEvals] = useState<any>(null);
    // 🆕 16-sep-2026: salidas (exits_gate_evals) y rollover A/D (rollover_evals)
    const [exitsEvals, setExitsEvals] = useState<Record<string, any>>({});
    const [rollEvals, setRollEvals] = useState<Record<string, any>>({});
    const [rollOn, setRollOn] = useState<Record<string, { A: boolean; D: boolean }>>({});
    // 🆕 sep-2026: Asset Scout — ranking de candidatos + lista de activos oficiales + estado enabled
    const [scout, setScout] = useState<ScoutReport | null>(null);
    const [activeList, setActiveList] = useState<string[]>([]);
    const [assetEnabled, setAssetEnabled] = useState<Record<string, boolean>>({});
    const [promoting, setPromoting] = useState<string | null>(null);
    const [exitApplying, setExitApplying] = useState<string | null>(null);
    const [appliedExitPolicies, setAppliedExitPolicies] = useState<Record<string, string>>({});
    const [loserApplied, setLoserApplied] = useState<Record<string, number>>({});

    // All sections refresh as one read-only batch. Failed reads clear old values,
    // rather than displaying an earlier successful response as current evidence.
    const refreshAll = async () => {
        setLoading(true);
        try {
            const names = ['opt_reports', 'auto_state', 'asset_configs', 'active_tickers', 'health_check',
                'ml_gate_evals', 'corr_gate_evals', 'timesfm_gate_evals', 'blocked_signals_evals', 'exits_gate_evals', 'rollover_evals'];
            const results = await Promise.allSettled([
                getDocs(collection(db, 'opt_reports')), getDoc(doc(db, 'optimization_config', 'auto_state')),
                getDocs(collection(db, 'asset_configs')), getDoc(doc(db, 'optimization_config', 'active_tickers')),
                getDoc(doc(db, 'health_check', 'latest')), getDocs(collection(db, 'ml_gate_evals')),
                getDocs(collection(db, 'corr_gate_evals')), getDocs(collection(db, 'timesfm_gate_evals')),
                getDoc(doc(db, 'blocked_signals_evals', '_GLOBAL')), getDocs(collection(db, 'exits_gate_evals')),
                getDocs(collection(db, 'rollover_evals')),
            ]);
            const value = (i: number): any => results[i].status === 'fulfilled' ? results[i].value : null;
            const document = (i: number): any => value(i)?.exists() ? value(i).data() : null;
            const entries = (i: number): Record<string, any> => Object.fromEntries((value(i)?.docs ?? []).map((d: any) => [d.id, d.data()]));
            const allReports = entries(0);
            setReports(Object.values(allReports).filter((r: any) => typeof r.ticker === 'string' && r.ticker.length > 0)
                .sort((a, b) => b.timestamp - a.timestamp) as OptReport[]);
            setLoser(allReports.LOSER_TRIGGERS_PROPOSAL ? { ...allReports.LOSER_TRIGGERS_PROPOSAL,
                disables: allReports.LOSER_TRIGGERS_PROPOSAL.disables ?? [], enables: allReports.LOSER_TRIGGERS_PROPOSAL.enables ?? [] } : null);
            setScout(allReports.ASSET_SCOUT ?? null);
            setAutoState(document(1) ?? {});
            const configs = Object.entries(entries(2)).filter(([id]) => id !== 'GLOBAL');
            setConfigMetadata(Object.fromEntries(configs.map(([id, c]) => [id, { autotune: c.autotune, updatedBy: c.updatedBy, currentSnapshot: c }])));
            setAssetEnabled(Object.fromEntries(configs.map(([id, c]) => [id, c.enabled !== false])));
            setMlGateOn(Object.fromEntries(configs.map(([id, c]) => [id, c.mlGateEnabled === true])));
            setCorrOn(Object.fromEntries(configs.map(([id, c]) => [id, c.correlationFilter?.shadow === false])));
            setTfmOn(Object.fromEntries(configs.map(([id, c]) => [id, c.timesfm?.enabled === true])));
            setRollOn(Object.fromEntries(configs.map(([id, c]) => [id, { A: c.rolloverBeEnabled !== false, D: c.rolloverEntryBlock !== false }])));
            const tickers = document(3)?.tickers;
            setActiveList(Array.isArray(tickers) ? tickers.filter((t: unknown) => typeof t === 'string') : []);
            setHealth(document(4)); setMlEvals(entries(5)); setCorrEvals(entries(6)); setTfmEvals(entries(7));
            setBlkEvals(document(8)); setExitsEvals(entries(9)); setRollEvals(entries(10));
            const failures = results.flatMap((r, i) => r.status === 'rejected' ? [names[i]] : []);
            setStateError(failures.length ? `Lecturas no disponibles (datos anteriores descartados): ${failures.join(', ')}` : null);
        } catch (err) {
            console.error('Error refreshing optimization diagnostics:', err);
            setReports([]); setActiveList([]);
            setStateError('No se pudo actualizar el panel. No usar sus diagnósticos para operar.');
            toast('Error al actualizar diagnósticos', 'error');
        } finally { setLoading(false); }
    };

    // 🆕 16-sep-2026: lista para la tabla GATE ML (oficiales ∪ con config ∪ evaluados)
    const mlTickers = [...new Set([...activeList, ...Object.keys(assetEnabled), ...Object.keys(mlEvals)])].sort();

    // 🆕 16-sep-2026: lista para la tabla FILTRO CORRELACIÓN
    const corrTickers = [...new Set([...activeList, ...Object.keys(assetEnabled), ...Object.keys(corrEvals).filter(k => k !== '_GLOBAL')])].sort();
    const fmtUsd = (v?: number) => (v === undefined || v === null) ? '—' : `${v >= 0 ? '+' : ''}$${Number(v).toFixed(2)}`;
    const fmtRc = (v?: number) => (v === undefined || v === null) ? '' : ` / ${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}R`;

    // 🆕 16-sep-2026: lista para la tabla TIMESFM
    const tfmTickers = [...new Set([...activeList, ...Object.keys(assetEnabled), ...Object.keys(tfmEvals).filter(k => k !== '_GLOBAL')])].sort();

    // 🆕 16-sep-2026: lista para las tablas SALIDAS y ROLLOVER
    const exitsTickers = [...new Set([...activeList, ...Object.keys(exitsEvals).filter(k => k !== '_GLOBAL')])].sort();
    const rollTickers = [...new Set([...activeList, ...Object.keys(rollEvals).filter(k => k !== '_GLOBAL')])].sort();

    useEffect(() => { void refreshAll(); }, []);

    const statusBadge = (r: OptReport) => <span style={{ ...badge, color: '#aaa', borderColor: '#444' }}>
        {reportVerdict(r.status, reportScope(r, activeList).current)}
    </span>;

    const badge: React.CSSProperties = { fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', border: '1px solid' };

    const card: React.CSSProperties = { padding: '20px', backgroundColor: '#0a0a0a', border: '1px solid #222', borderRadius: '8px' };

    // ── Acciones de features (restauradas con evidencia fresca + confirmación) ──
    // Cada toggle escribe su config real en asset_configs y el bot la toma en caliente.
    // No se actúa sobre evaluaciones vencidas; el roster (activar/pausar activo) vive en Salud.
    const confirmAction = (label: string, evidence: boolean | { actionable: boolean; reason: string | null }, detail: string): boolean => {
        const actionable = typeof evidence === 'boolean' ? evidence : evidence.actionable;
        const reason = typeof evidence === 'boolean' ? null : evidence.reason;
        if (!actionable) { toast(`${label}: ${reason ?? 'evidencia insuficiente'}`, 'error'); return false; }
        return window.confirm(`${label}\n\n${detail}`);
    };

    const promoteTicker = async (ticker: string) => {
        if (!confirmAction('Promover activo', isFreshReport(scout?.generatedAt),
            `Agregar ${ticker} al universo de optimización (active_tickers). NO lo habilita a operar: eso es el roster en Salud de Activos.`)) return;
        setPromoting(ticker);
        try {
            const ref = doc(db, 'optimization_config', 'active_tickers');
            const snap = await getDoc(ref);
            const cur: string[] = snap.exists() ? ((snap.data() as any).tickers || []) : [];
            if (cur.includes(ticker)) { toast(`${ticker} ya está en el universo`, 'info'); return; }
            await setDoc(ref, { tickers: [...cur, ticker], updatedAt: new Date().toISOString() }, { merge: true });
            setActiveList([...cur, ticker]);
            toast(`⚡ ${ticker} PROMOVIDO al universo de optimización (próximo ciclo)`, 'success');
        } catch (e) { console.error(e); toast(`Error promoviendo ${ticker}`, 'error'); }
        finally { setPromoting(null); }
    };

    const toggleMLGate = async (ticker: string, on: boolean) => {
        const ev = mlEvals[ticker];
        // Activar exige que el gate MEJORE (Δ>0); apagar solo exige evidencia fresca+mínima.
        const advice = on
            ? activationRecommendation(ev?.evaluatedAt, ev?.sinGate?.n, ev?.delta)
            : filterEvidence(ev?.evaluatedAt, ev?.sinGate?.n);
        if (!confirmAction(`Gate ML ${on ? 'ON' : 'OFF'} — ${ticker}`, on ? { actionable: advice.recommend, reason: advice.reason } : advice,
            `Cambia mlGateEnabled. El umbral runtime lo fija el modelo (pipeline de entrenamiento), no este botón: umbral probado ${ev?.bestGate?.umbral ?? '—'}.`)) return;
        try {
            await setDoc(doc(db, 'asset_configs', ticker), { mlGateEnabled: on }, { merge: true });
            setMlGateOn(p => ({ ...p, [ticker]: on }));
            toast(`Gate ML ${on ? 'ON' : 'OFF'} en ${ticker}`, on ? 'success' : 'info');
        } catch (e) { console.error(e); toast(`Error gate ML ${ticker}`, 'error'); }
    };

    const toggleCorrFilter = async (ticker: string, on: boolean) => {
        const ev = corrEvals[ticker];
        const delta = (Number(ev?.blk?.usd) || 0) + (Number(ev?.rp?.usd) || 0);
        const advice = on ? activationRecommendation(ev?.evaluatedAt, ev?.n, delta) : filterEvidence(ev?.evaluatedAt, ev?.n);
        if (!confirmAction(`Filtro correlación ${on ? 'ON' : 'observa'} — ${ticker}`, on ? { actionable: advice.recommend, reason: advice.reason } : advice,
            `correlationFilter.shadow=${!on}. ${on ? 'Bloquea y aplica risk-parity' : 'Solo observa'}.`)) return;
        try {
            await setDoc(doc(db, 'asset_configs', ticker), { correlationFilter: { shadow: !on } }, { merge: true });
            setCorrOn(p => ({ ...p, [ticker]: on }));
            toast(`Correlación ${on ? 'ON' : 'observa'} en ${ticker}`, on ? 'success' : 'info');
        } catch (e) { console.error(e); toast(`Error correlación ${ticker}`, 'error'); }
    };

    const toggleTimesfm = async (ticker: string, on: boolean) => {
        const ev = tfmEvals[ticker];
        const delta = Number(ev?.mult?.usd) || 0;
        const advice = on ? activationRecommendation(ev?.evaluatedAt, ev?.n, delta) : filterEvidence(ev?.evaluatedAt, ev?.n);
        if (!confirmAction(`TimesFM ${on ? 'ON' : 'OFF'} — ${ticker}`, on ? { actionable: advice.recommend, reason: advice.reason } : advice,
            `timesfm.enabled=${on} (read-modify-write para no pisar el resto del bloque timesfm).`)) return;
        try {
            const ref = doc(db, 'asset_configs', ticker);
            const snap = await getDoc(ref);
            const cur = snap.exists() ? ((snap.data() as any).timesfm ?? {}) : {};
            await setDoc(ref, { timesfm: { ...cur, enabled: on } }, { merge: true });
            setTfmOn(p => ({ ...p, [ticker]: on }));
            toast(`TimesFM ${on ? 'ON' : 'OFF'} en ${ticker}`, on ? 'success' : 'info');
        } catch (e) { console.error(e); toast(`Error TimesFM ${ticker}`, 'error'); }
    };

    const toggleRollover = async (ticker: string, rule: 'A' | 'D', on: boolean) => {
        if (!confirmAction(`Rollover ${rule} ${on ? 'ON' : 'OFF'} — ${ticker}`, filterEvidence(rollEvals[ticker]?.evaluatedAt, rollEvals[ticker]?.nVentanas),
            `${rule === 'A' ? 'rolloverBeEnabled' : 'rolloverEntryBlock'} = ${on}.`)) return;
        try {
            const field = rule === 'A' ? 'rolloverBeEnabled' : 'rolloverEntryBlock';
            await setDoc(doc(db, 'asset_configs', ticker), { [field]: on }, { merge: true });
            setRollOn(p => ({ ...p, [ticker]: { ...(p[ticker] ?? { A: true, D: true }), [rule]: on } }));
            toast(`Rollover ${rule} ${on ? 'ON' : 'OFF'} en ${ticker}`, on ? 'success' : 'info');
        } catch (e) { console.error(e); toast(`Error rollover ${ticker}`, 'error'); }
    };

    const applyExitPolicy = async (ticker: string, policy: 'P1' | 'P2' | 'P3') => {
        if (!confirmAction(`Política de salida ${policy} — ${ticker}`, filterEvidence(exitsEvals[ticker]?.evaluatedAt, exitsEvals[ticker]?.n),
            `Reescribe los genes de salida de TODOS los gatillos de ${ticker} (no cierra posiciones abiertas).`)) return;
        setExitApplying(ticker);
        try {
            const GENES: Record<string, Record<string, any>> = {
                P1: { partialClosePct: 0, tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, slAfterTp1: 'none' },
                P2: { partialClosePct: 50, tp15BeEnabled: true, atrTrailEnabled: false, structuralTrailEnabled: false, slAfterTp1: 'midpoint' },
                P3: { partialClosePct: 50, tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, slAfterTp1: 'none' },
            };
            const ref = doc(db, 'asset_configs', ticker);
            const snap = await getDoc(ref);
            const cur = snap.exists() ? (snap.data() as any) : {};
            const sessions = JSON.parse(JSON.stringify(cur.sessions ?? {}));
            let touched = 0;
            for (const s of Object.keys(sessions)) for (const g of Object.keys(sessions[s] ?? {})) { sessions[s][g] = { ...sessions[s][g], ...GENES[policy] }; touched++; }
            await setDoc(ref, { sessions, updatedAt: new Date().toISOString(), updatedBy: 'panel_exit_policy' }, { merge: true });
            setAppliedExitPolicies(p => ({ ...p, [ticker]: policy }));
            toast(`🎯 ${ticker}: política ${policy} aplicada a ${touched} gatillos`, 'success');
        } catch (e) { console.error(e); toast(`Error política de salida ${ticker}`, 'error'); }
        finally { setExitApplying(null); }
    };

    const applyLoserForTicker = async (ticker: string) => {
        if (!loser) return;
        const props = [...loser.disables, ...loser.enables].filter(p => p.ticker === ticker);
        if (props.length === 0) { toast(`Sin propuestas para ${ticker}`, 'info'); return; }
        if (!confirmAction(`Gatillos perdedores — ${ticker}`, filterEvidence(loser.generatedAt, props.reduce((s, p) => s + (Number(p.n) || 0), 0)),
            `Apaga (minScore=99) o reactiva (minScore=4+enabled) los gatillos×sesión propuestos. ${props.map(p => `${p.session}/${p.trigger}`).join(', ')}.`)) return;
        setPromoting(ticker);
        try {
            const ref = doc(db, 'asset_configs', ticker);
            const snap = await getDoc(ref);
            const current = snap.exists() ? (snap.data() as any) : {};
            const merged = JSON.parse(JSON.stringify(current.sessions || {}));
            for (const p of props) {
                merged[p.session] = merged[p.session] || {};
                const curT = merged[p.session][p.trigger] || {};
                if (loser.disables.includes(p)) merged[p.session][p.trigger] = { ...curT, minScore: 99 };
                else merged[p.session][p.trigger] = { ...curT, minScore: 4, enabled: true };
            }
            await setDoc(ref, { sessions: merged, updatedAt: new Date().toISOString(), updatedBy: 'panel_loser' }, { merge: true });
            const next = { ...loserApplied, [ticker]: Date.now() };
            setLoserApplied(next);
            const lref = doc(db, 'opt_reports', 'LOSER_TRIGGERS_PROPOSAL');
            const lsnap = await getDoc(lref);
            const prevApplied = (lsnap.exists() && lsnap.data().applied && typeof lsnap.data().applied === 'object') ? lsnap.data().applied : {};
            await setDoc(lref, { applied: { ...prevApplied, [ticker]: Date.now() } }, { merge: true });
            toast(`✅ Gatillos aplicados para ${ticker}`, 'success');
            void refreshAll();
        } catch (e) { console.error(e); toast(`Error gatillos ${ticker}`, 'error'); }
        finally { setPromoting(null); }
    };

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
                        Hyperopt semanal de Scoring y Gestión (sábados 06:00 CEST) vs. producción. Para calibrar umbrales de <b>detección SMC</b> (Capa 1), ver la pestaña <a href="/assets" style={{ color: '#38bdf8', textDecoration: 'underline' }}>Salud de Activos</a>.
                    </p>
                </div>
                <button onClick={() => void refreshAll()} disabled={loading} style={{ padding: '8px 16px', background: '#111', color: '#e6e6e6', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <RefreshCw size={14} /> Refrescar
                </button>
            </div>

            <p style={{ color: '#aaa', margin: 0 }}>
                Gates, salidas y gatillos se pueden activar/desactivar acá con evidencia fresca (eval ≤8 días); el bot los toma en caliente.
                {' '}<a href="/assets">Salud de Activos</a>: roster, activación y riesgo (única fuente para decidir qué activos operan).
                {' '}La selección del optimizador y los contrafactuales no son garantía de rendimiento futuro ni confirman recepción del bot.
            </p>
            {stateError && <div role="alert" style={{ color: '#ffaa00' }}>{stateError}</div>}
            <div>Reportes vigentes (≤8 días y active_tickers): {reports.filter(r => reportScope(r, activeList).current).length}.
                {' '}Candidatas de investigación vigentes: {reports.filter(r => reportScope(r, activeList).current && r.status === 'RECOMMEND').length}.
                {' '}Los históricos quedan excluidos de este recuento.</div>

            {/* 🩺 Health-check del sistema (health_check/latest) */}
            {health && (
                <div style={{ ...card, borderColor: health.status === 'OK' ? '#00e67640' : '#ff333350' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                        <h3 style={{ margin: 0, color: '#e6e6e6', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <HeartPulse size={18} color={health.status === 'OK' ? '#00e676' : '#ff3333'} />
                            {health.status === 'OK' ? 'Health-check registrado: OK' : 'Health-check registrado: revisar'}
                        </h3>
                        <span style={{ fontSize: '0.75rem', color: '#666' }}>
                            {!isFreshReport(health.timestamp) && 'HISTÓRICO / FECHA NO VÁLIDA · '}{new Date(health.timestamp).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
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

            {[...reports].sort((a, b) => Number(reportScope(b, activeList).current) - Number(reportScope(a, activeList).current)).map(r => {
                const metrics = reportMetrics(r);
                return (
                <div key={`${r.ticker}:${r.timestamp}`} style={card}>
                    <div style={{ color: reportScope(r, activeList).current ? '#aaa' : '#ffaa00', marginBottom: 8 }}>{reportScope(r, activeList).label}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                        <h3 style={{ margin: 0, color: '#e6e6e6', fontSize: '1.1rem' }}>{r.ticker}</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                {new Date(r.timestamp).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
                            </span>
                            {statusBadge(r)}
                        </div>
                    </div>

                    {(r.status === 'ERROR' || r.status === 'REFRESH_ERROR' || r.status.startsWith('HOLD_')) && (
                        <p style={{ color: '#ff3333', fontSize: '0.85rem', marginTop: '12px' }}>🛑 {r.reason || 'Resultado no concluyente; revisar evidencia y disponibilidad. No implica desactivar el activo.'}</p>
                    )}
                    {r.selection_outcome && <p>Intento de selección: {r.selection_outcome}. No acredita aplicación.</p>}
                    {r.last_successful_selection != null && <details><summary>Última selección exitosa: referencia histórica, no candidata vigente</summary>
                        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(r.last_successful_selection, null, 2)}</pre>
                    </details>}
                    {r.status === 'HOLD' && !r.appliedAt && (
                        <p style={{ color: '#aaa', fontSize: '0.85rem', marginTop: '12px' }}>⏸️ {r.reason || 'Sin mejora suficiente en la evaluación; no acredita validez de producción.'}</p>
                    )}

                    {metrics.production && metrics.proposal && (
                        <>
                            <table style={{ width: '100%', marginTop: '16px', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                                <thead>
                                    <tr style={{ color: '#888', textAlign: 'left' }}>
                                        <th style={{ padding: '6px 8px' }}>Métrica · {metrics.label}</th>
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
                                        const oldV = (metrics.production as any)[key];
                                        const newV = (metrics.proposal as any)[key];
                                        const difference = metricDelta(newV, oldV);
                                        const better = key === 'max_drawdown_r' ? newV < oldV : newV > oldV;
                                        const color = difference === undefined || difference === 0 || key === 'trade_count' ? '#aaa' : better ? '#00e676' : '#ff3333';
                                        return (
                                            <tr key={key} style={{ borderTop: '1px solid #1a1a1a' }}>
                                                <td style={{ padding: '6px 8px', color: '#aaa' }}>{label}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{fmt(oldV)}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{fmt(newV)}</td>
                                                <td style={{ padding: '6px 8px', fontFamily: 'monospace', color }}>{difference === undefined ? '—' : `${difference > 0 ? '+' : ''}${fmt(difference)}${key === 'win_rate' ? ' (pp)' : ''}`}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>

                            {r.delta && (
                                <div style={{ display: 'flex', gap: '12px', marginTop: '12px', flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: '0.75rem', color: '#00e676' }}>Δ Expectativa: {r.delta.d_exp_oos >= 0 ? '+' : ''}{r.delta.d_exp_oos.toFixed(3)}R</span>
                                    <span style={{ fontSize: '0.75rem', color: '#00e676' }}>DD mejorado: {(r.delta.dd_improve_ratio * 100).toFixed(0)}%</span>
                                    <span style={{ fontSize: '0.75rem', color: r.delta.pnl_drop_ratio > 0.1 ? '#ffaa00' : '#888' }}>{pnlChangeLabel(r.delta.pnl_drop_ratio)}</span>
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
                            <span title="Partición informada por el reporte; independencia no acreditada">
                                📊 <b>Partición del reporte:</b> {r.oos_split.train} train / {r.oos_split.test} test
                            </span>
                        )}
                        {r.data_refreshed_at && (
                            <span title="Última regeneración de los CSVs SMC (walk-forward)">
                                🗓️ <b>Datos:</b> {new Date(r.data_refreshed_at).toLocaleDateString('es-AR')}
                            </span>
                        )}
                        {/* 🆕 sep-2026: veredicto Monte Carlo + propuestas nuevas (TimesFM / bias) */}
                        {r.montecarlo?.verdict_short && (
                            <span title={r.montecarlo.verdict || 'Monte Carlo'}>
                                🎲 <b>Monte Carlo:</b> {r.montecarlo.verdict_short}
                                {r.montecarlo.survival !== undefined && ` (${(r.montecarlo.survival * 100).toFixed(0)}% survival, n=${r.montecarlo.n ?? '—'})`}
                            </span>
                        )}
                        {r.timesfm_apply?.minScoreToOverrideReject !== undefined && r.timesfm_apply?.minScoreToOverrideReject !== null && (
                            <span title="Umbral propuesto para el candidato semanal; consultar el estado de aplicación automática">
                                🌙 <b>TimesFM umbral propuesto:</b> {r.timesfm_apply.minScoreToOverrideReject}
                            </span>
                        )}
                        {r.bias_confluence?.recommended?.bc && (
                            <span title={`Confluencia de bias (bono de alineación) — margen vs baseline: ${r.bias_confluence.recommended.margin_vs_baseline?.toFixed?.(2) ?? '—'}`}>
                                🧭 <b>Bias propuesto:</b> {r.bias_confluence.recommended.bc.tfs.join('/')} · {r.bias_confluence.recommended.bc.minForFull}/{r.bias_confluence.recommended.bc.tfs.length} alineados → +{r.bias_confluence.recommended.bc.fullPts} pts
                            </span>
                        )}
                    </div>
                    {r.session_apply && Object.keys(r.session_apply).length > 0 && (
                        <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '8px', marginBottom: 0 }}>
                            ⚙️ La propuesta incluye ajustes por gatillo (enabled/entryPercent); su aplicación depende del proceso automático.
                        </p>
                    )}


                    <WeeklyOperationalStatus report={r} autoState={autoState} config={configMetadata[r.ticker]} stateError={stateError} />

                    <p style={{ color: '#888', fontSize: '0.8rem' }}>Este diagnóstico no recomienda activar ni desactivar.
                        {' '}Revisar el roster en <a href="/assets">Salud de Activos</a>.</p>
                </div>
            );})}

            {/* 🆕 sep-2026: propuesta de gatillos perdedores (gatillo×sesión) */}
            {loser && (
                <div style={{ ...card, borderColor: (loser.disables.length || loser.enables.length) ? '#ffaa0040' : '#222' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                        <h3 style={{ margin: 0, color: '#e6e6e6', fontSize: '1.05rem' }}>🚦 Gatillos perdedores — investigación / legado (gatillo × sesión)</h3>
                        {loser.generatedAt && (
                            <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                {!isFreshReport(loser.generatedAt) && 'HISTÓRICO / VENCIDO · '}{new Date(loser.generatedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
                            </span>
                        )}
                    </div>
                    <p style={{ fontSize: '0.8rem', color: '#aaa' }}>Propuesta de apagar (minScore=99) o reactivar gatillos×sesión perdedores/ganadores. Aplicarla es decisión tuya; el bot la toma en caliente. No cierra posiciones abiertas.</p>
                    {loser.disables.length === 0 && loser.enables.length === 0 ? (
                        <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '10px', marginBottom: 0 }}>
                            Sin propuestas en este reporte: ningún gatillo×sesión pasa los umbrales (n≥8, ±0.15R/t en ventana 84d).
                        </p>
                    ) : (() => {
                        const pendingTickers = [...new Set([...loser.disables, ...loser.enables].map(p => p.ticker))];
                        if (pendingTickers.length === 0) {
                            return (
                                <p style={{ color: '#00e676', fontSize: '0.85rem', marginTop: '10px', marginBottom: 0 }}>
                                    Sin propuestas de investigación en este reporte.
                                </p>
                            );
                        }
                        return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' }}>
                            {pendingTickers.map(ticker => {
                                const ds = loser.disables.filter(p => p.ticker === ticker);
                                const es = loser.enables.filter(p => p.ticker === ticker);
                                return (
                                    <div key={ticker} style={{ border: '1px solid #222', borderRadius: '6px', padding: '12px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                                            <b style={{ color: '#e6e6e6' }}>{ticker}</b>
                                            <button className="btn" disabled={!filterEvidence(loser.generatedAt, [...ds, ...es].reduce((s, p) => s + (Number(p.n) || 0), 0)).actionable || loserApplied[ticker] !== undefined} onClick={() => applyLoserForTicker(ticker)} title={filterEvidence(loser.generatedAt, [...ds, ...es].reduce((s, p) => s + (Number(p.n) || 0), 0)).reason ?? ''}>{loserApplied[ticker] !== undefined ? 'Aplicado' : !filterEvidence(loser.generatedAt, [...ds, ...es].reduce((s, p) => s + (Number(p.n) || 0), 0)).actionable ? 'Evidencia insuficiente' : 'Aplicar'}</button>
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                                            {ds.map(d => (
                                                <span key={`${d.session}|${d.trigger}`} style={{ fontSize: '0.75rem', padding: '3px 8px', borderRadius: '4px', background: '#ff333320', color: '#ff6666', border: '1px solid #ff333340' }}>
                                                    🔴 {d.session}/{d.trigger} — {d.n} trades, {d.exp}R/t
                                                </span>
                                            ))}
                                            {es.map(e => (
                                                <span key={`${e.session}|${e.trigger}`} style={{ fontSize: '0.75rem', padding: '3px 8px', borderRadius: '4px', background: '#00e67620', color: '#00e676', border: '1px solid #00e67640' }}>
                                                    🟢 {e.session}/{e.trigger} — {e.n} trades, +{e.exp}R/t
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        );
                    })()}
                </div>
            )}

            {/* 🆕 sep-2026: Asset Scout — buscador de activos (sábado) */}
            {scout && scout.results && scout.results.length > 0 && (
                <div style={{ ...card, borderColor: '#4488ff40' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                        <h3 style={{ margin: 0, color: '#e6e6e6', fontSize: '1.05rem' }}>🔭 Asset Scout — buscador de activos</h3>
                        {scout.generatedAt && (
                            <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                {!isFreshReport(scout.generatedAt) && 'HISTÓRICO / VENCIDO · '}{new Date(scout.generatedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })} · ventana {scout.windowDays}d
                            </span>
                        )}
                    </div>
                    <p style={{ fontSize: '0.75rem', color: '#888', marginTop: '6px', marginBottom: 0 }}>
                        Screening con config sonda (sin hyperopt). Investigación, no recomendación de promoción o activación. El universo de optimización no es el roster operativo.
                    </p>
                    <div style={{ overflowX: 'auto', marginTop: '12px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                            <thead>
                                <tr style={{ color: '#888', textAlign: 'left' }}>
                                    <th style={{ padding: '6px 8px' }}>Activo</th>
                                    <th style={{ padding: '6px 8px' }}>Cat</th>
                                    <th style={{ padding: '6px 8px' }}>84d n</th>
                                    <th style={{ padding: '6px 8px' }}>PF</th>
                                    <th style={{ padding: '6px 8px' }}>Net (R)</th>
                                    <th style={{ padding: '6px 8px' }}>DD (R)</th>
                                    <th style={{ padding: '6px 8px' }}>Veredicto</th>
                                    <th style={{ padding: '6px 8px' }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...scout.results].sort((a, b) => (b.win84?.pf ?? 0) - (a.win84?.pf ?? 0)).map(row => {
                                    const v = row.verdict;
                                    const vColor = v === 'PASS' ? '#00e676' : v === 'MARGINAL' ? '#ffaa00' : v === 'FAIL' ? '#ff6666' : '#777';
                                    const promoted = activeList.includes(row.ticker);
                                    return (
                                        <tr key={row.ticker} style={{ borderTop: '1px solid #1a1a1a' }}>
                                            <td style={{ padding: '6px 8px', color: '#e6e6e6', fontWeight: 600 }}>{row.ticker}</td>
                                            <td style={{ padding: '6px 8px', color: '#aaa' }}>{row.cat}</td>
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: row.error ? '#ff6666' : '#aaa' }}>{row.error ? '⚠' : row.win84?.n ?? '—'}</td>
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#aaa' }}>{row.error ? '—' : row.win84?.pf?.toFixed(2) ?? '—'}</td>
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: (row.win84?.netR ?? 0) >= 0 ? '#00e676' : '#ff6666' }}>{row.error ? '—' : (row.win84?.netR ?? 0).toFixed(1)}</td>
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#aaa' }}>{row.error ? '—' : (row.win84?.maxDD ?? 0).toFixed(1)}</td>
                                            <td style={{ padding: '6px 8px', fontWeight: 700, color: vColor }}>{row.error ? 'ERROR' : v}</td>
                                            <td style={{ padding: '6px 8px' }}>
                                                {promoted
                                                    ? <span style={{ color: '#00e676', fontSize: '0.78rem' }}>En universo de optimización</span>
                                                    : <button className="btn" disabled={promoting === row.ticker || !isFreshReport(scout?.generatedAt)} onClick={() => promoteTicker(row.ticker)}>{promoting === row.ticker ? '…' : 'Promover'}</button>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}


            {/* 🆕 16-sep-2026: GATE ML POR ACTIVO — activar/apagar desde el panel (mlGateEnabled, bot en caliente) */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🧠 GATE ML POR ACTIVO</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>sweep → ml_gate_evals · estado almacenado, sin recepción del bot</span>
                </div>
                <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse', marginTop: '10px' }}>
                    <thead>
                        <tr style={{ textAlign: 'left', color: '#777', fontSize: '0.72rem' }}>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>ACTIVO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>GATE</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>MODELO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>SWEEP: SIN GATE → MEJOR GATE</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {mlTickers.map(t => {
                            const ev = mlEvals[t];
                            const on = mlGateOn[t] === true;
                            const delta: number | undefined = ev?.delta;
                            const deltaGood = delta !== undefined && delta > 0;
                            return (
                                <tr key={t} style={{ borderBottom: '1px solid #1a1a1a' }}>
                                    <td style={{ padding: '8px 4px', fontWeight: 700 }}>{t}</td>
                                    <td style={{ padding: '8px 4px' }}>
                                        {on
                                            ? <span style={{ color: '#00e676', fontWeight: 700 }}>● ON</span>
                                            : <span style={{ color: '#888' }}>○ OFF</span>}
                                    </td>
                                    <td style={{ padding: '8px 4px', color: '#aaa', fontSize: '0.78rem' }}>
                                        {ev ? (ev.modelo ?? '—') : '—'}
                                        {ev?.trainedAt ? <div style={{ color: '#666', fontSize: '0.68rem' }}>train {new Date(ev.trainedAt).toLocaleDateString()}</div> : null}
                                    </td>
                                    <td style={{ padding: '8px 4px', fontSize: '0.8rem' }}>
                                        {ev
                                            ? <span>
                                                {Number(ev.sinGate?.pnlR ?? 0).toFixed(1)}R → {Number(ev.bestGate?.pnlR ?? 0).toFixed(1)}R{' '}
                                                <span style={{ color: deltaGood ? '#00e676' : '#ff5555', fontWeight: 700 }}>
                                                    ({deltaGood ? '+' : ''}{Number(delta).toFixed(1)}R)
                                                </span>
                                                <span style={{ color: '#666', fontSize: '0.68rem' }}> · {!isFreshReport(ev.evaluatedAt) && 'HISTÓRICO / VENCIDO · '}{new Date(ev.evaluatedAt).toLocaleString()}</span>
                                                <div>{mlDiagnostic(ev)}</div>
                                            </span>
                                            : <span style={{ color: '#666' }}>sin evaluación</span>}
                                    </td>
                                    <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                                        {on
                                            ? <button className="btn" disabled={!filterEvidence(ev?.evaluatedAt, ev?.sinGate?.n).actionable} onClick={() => toggleMLGate(t, false)} title={filterEvidence(ev?.evaluatedAt, ev?.sinGate?.n).reason ?? ''}>Apagar gate</button>
                                            : activationRecommendation(ev?.evaluatedAt, ev?.sinGate?.n, ev?.delta).recommend
                                                ? <button className="btn" onClick={() => toggleMLGate(t, true)}>Activar gate</button>
                                                : <span style={{ color: '#888', fontSize: '0.72rem' }} title={activationRecommendation(ev?.evaluatedAt, ev?.sinGate?.n, ev?.delta).reason ?? ''}>No activar</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '10px', marginBottom: 0 }}>
                    {mlTickers.length === 0
                        ? 'Sin activos — la lista sale de optimization_config/active_tickers.'
                        : 'El toggle cambia mlGateEnabled (el bot lo toma en caliente). El umbral runtime lo fija el modelo; el sweep no certifica OOS ni equivalencia con ese umbral.'}
                </p>
            </div>
            <p style={{ color: '#888' }}>Las siguientes evaluaciones son diagnósticos históricos/contrafactuales, no recomendaciones vigentes. Los estados ON/OFF son metadatos almacenados, no confirmación del bot.</p>
            {/* 🆕 16-sep-2026: FILTRO CORRELACIÓN POR ACTIVO — contrafactual + botón (shadow:false bloquea en vivo) */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🧲 FILTRO CORRELACIÓN POR ACTIVO</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>eval → corr_gate_evals · diagnóstico / estado almacenado</span>
                </div>
                <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse', marginTop: '10px' }}>
                    <thead>
                        <tr style={{ textAlign: 'left', color: '#777', fontSize: '0.72rem' }}>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>ACTIVO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>FILTRO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>EVALUADAS</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>SI HUBIERA BLOQUEADO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>SI RISK-PARITY</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {corrTickers.map(t => {
                            const ev = corrEvals[t];
                            const on = corrOn[t] === true;
                            const blk = ev?.blk;
                            const rp = ev?.rp;
                            return (
                                <tr key={t} style={{ borderBottom: '1px solid #1a1a1a' }}>
                                    <td style={{ padding: '8px 4px', fontWeight: 700 }}>{t}</td>
                                    <td style={{ padding: '8px 4px' }}>
                                        {on
                                            ? <span style={{ color: '#00e676', fontWeight: 700 }}>● ACTIVO</span>
                                            : <span style={{ color: '#888' }}>○ observa</span>}
                                    </td>
                                    <td style={{ padding: '8px 4px', color: '#aaa' }}>
                                        {ev ? ev.n : '—'}
                                        {ev?.degraded > 0 ? <span style={{ color: '#ffaa00', fontSize: '0.7rem' }}> ({ev.degraded} sin ρ)</span> : null}
                                    </td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', color: (blk?.usd ?? 0) > 0 ? '#00e676' : (blk?.n ?? 0) > 0 ? '#ff5555' : '#888', fontSize: '0.8rem' }}>
                                        {ev ? (blk?.n > 0 ? `${fmtUsd(blk.usd)}${fmtRc(blk.R)} (${blk.n})` : '—') : '—'}
                                    </td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', color: (rp?.usd ?? 0) > 0 ? '#00e676' : (rp?.n ?? 0) > 0 ? '#ff5555' : '#888', fontSize: '0.8rem' }}>
                                        {ev ? (rp?.n > 0 ? `${fmtUsd(rp.usd)}${fmtRc(rp.R)} (${rp.n})` : '—') : '—'}
                                    </td>
                                    <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                                        {on
                                            ? <button className="btn" disabled={!filterEvidence(ev?.evaluatedAt, ev?.n).actionable} onClick={() => toggleCorrFilter(t, false)} title={filterEvidence(ev?.evaluatedAt, ev?.n).reason ?? ''}>Pasar a observación</button>
                                            : activationRecommendation(ev?.evaluatedAt, ev?.n, (Number(ev?.blk?.usd) || 0) + (Number(ev?.rp?.usd) || 0)).recommend
                                                ? <button className="btn" onClick={() => toggleCorrFilter(t, true)}>Activar filtro</button>
                                                : <span style={{ color: '#888', fontSize: '0.72rem' }} title={activationRecommendation(ev?.evaluatedAt, ev?.n, (Number(ev?.blk?.usd) || 0) + (Number(ev?.rp?.usd) || 0)).reason ?? ''}>No activar</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '10px', marginBottom: 0 }}>
                    {corrEvals['_GLOBAL']
                        ? `Desde el 14/9: ${corrEvals['_GLOBAL'].n} entradas evaluadas · bloqueo neto ${fmtUsd(corrEvals['_GLOBAL'].blk?.usd)} · risk-parity neto ${fmtUsd(corrEvals['_GLOBAL'].rp?.usd)} · ${corrEvals['_GLOBAL'].degraded} degradadas (se recalculan cada domingo).`
                        : 'Aún sin evaluación — el contrafactual se publica con el pipeline dominical.'}
                </p>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '6px', marginBottom: 0 }}>
                    Contrafactual diagnóstico: activar el filtro es una decisión tuya; el bot la toma en caliente. Un Δ favorable no es garantía de rendimiento futuro.
                </p>
            </div>
            {/* 🆕 16-sep-2026: TIMESFM POR ACTIVO — contrafactual + botón (asset_configs.timesfm.enabled) */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🧊 TIMESFM POR ACTIVO</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>eval → timesfm_gate_evals · diagnóstico / estado almacenado</span>
                </div>
                <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse', marginTop: '10px' }}>
                    <thead>
                        <tr style={{ textAlign: 'left', color: '#777', fontSize: '0.72rem' }}>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>ACTIVO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>FILTRO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>EVALUADAS</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>Δ POR RISK MULT</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>RECHAZOS</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {tfmTickers.map(t => {
                            const ev = tfmEvals[t];
                            const on = tfmOn[t] === true;
                            const mult = ev?.mult;
                            return (
                                <tr key={t} style={{ borderBottom: '1px solid #1a1a1a' }}>
                                    <td style={{ padding: '8px 4px', fontWeight: 700 }}>{t}</td>
                                    <td style={{ padding: '8px 4px' }}>
                                        {on
                                            ? <span style={{ color: '#00e676', fontWeight: 700 }}>● ACTIVO</span>
                                            : <span style={{ color: '#888' }}>○ apagado</span>}
                                    </td>
                                    <td style={{ padding: '8px 4px', color: '#aaa' }}>
                                        {ev ? ev.n : '—'}
                                        {ev?.degraded > 0 ? <span style={{ color: '#ffaa00', fontSize: '0.7rem' }}> ({ev.degraded} degrad.)</span> : null}
                                    </td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', color: (mult?.usd ?? 0) > 0 ? '#00e676' : (mult?.n ?? 0) > 0 ? '#ff5555' : '#888', fontSize: '0.8rem' }}>
                                        {ev ? (mult?.n > 0 ? `${fmtUsd(mult.usd)}${fmtRc(mult.R)} (${mult.n})` : '—') : '—'}
                                    </td>
                                    <td style={{ padding: '8px 4px', color: (ev?.reject ?? 0) > 0 ? '#ffaa00' : '#888', fontFamily: 'monospace' }}>
                                        {ev && ev.reject > 0 ? `${ev.reject} bloqueadas` : ev ? '0' : '—'}
                                    </td>
                                    <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                                        {on
                                            ? <button className="btn" disabled={!filterEvidence(ev?.evaluatedAt, ev?.n).actionable} onClick={() => toggleTimesfm(t, false)} title={filterEvidence(ev?.evaluatedAt, ev?.n).reason ?? ''}>Apagar TimesFM</button>
                                            : activationRecommendation(ev?.evaluatedAt, ev?.n, Number(ev?.mult?.usd) || 0).recommend
                                                ? <button className="btn" onClick={() => toggleTimesfm(t, true)}>Activar TimesFM</button>
                                                : <span style={{ color: '#888', fontSize: '0.72rem' }} title={activationRecommendation(ev?.evaluatedAt, ev?.n, Number(ev?.mult?.usd) || 0).reason ?? ''}>No activar</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '10px', marginBottom: 0 }}>
                    {tfmEvals['_GLOBAL']
                        ? `Desde el 14/9: ${tfmEvals['_GLOBAL'].n} evaluadas · Δ por riskMult ${fmtUsd(tfmEvals['_GLOBAL'].mult?.usd)} · ${tfmEvals['_GLOBAL'].reject} rechazadas (su contrafactual solo lo mide el backtest por ablación) · ${tfmEvals['_GLOBAL'].degraded} degradadas.`
                        : 'Aún sin evaluación — se publica con el pipeline dominical.'}
                </p>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '6px', marginBottom: 0 }}>
                    El Δ mide el ajuste de TAMAÑO (riskMult) sobre trades ejecutados: verde = achicar apuestas ahorró; rojo = costó ganancias. Los rechazos (REJECT) nunca ejecutaron — se cuentan, su costo/beneficio se mide con ablación en backtest.
                </p>
            </div>
            {/* 🆕 16-sep-2026: SEÑALES BLOQUEADAS (contrafactual simulado con velas M5 reales) */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🛑 SEÑALES BLOQUEADAS (contrafactual)</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>blocked_signals_eval · simulación con velas M5 reales de cTrader</span>
                </div>
                <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse', marginTop: '10px' }}>
                    <thead>
                        <tr style={{ textAlign: 'left', color: '#777', fontSize: '0.72rem' }}>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>MOTIVO DE BLOQUEO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>SEÑALES</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>HABRÍAN GANADO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>HABRÍAN PERDIDO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>ABIERTAS</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>ΣR HIPOTÉTICO</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(blkEvals?.reasons ?? []).map((r: any) => {
                            const good = r.sumR > 0;
                            return (
                                <tr key={r.reason} style={{ borderBottom: '1px solid #1a1a1a' }}>
                                    <td style={{ padding: '8px 4px', fontWeight: 700 }}>{r.reason}</td>
                                    <td style={{ padding: '8px 4px', color: '#aaa' }}>{r.n}</td>
                                    <td style={{ padding: '8px 4px', color: '#00e676' }}>{r.wins}</td>
                                    <td style={{ padding: '8px 4px', color: '#ff5555' }}>{r.losses}</td>
                                    <td style={{ padding: '8px 4px', color: '#ffaa00' }}>{r.open}</td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', fontWeight: 700, color: good ? '#00e676' : r.sumR < 0 ? '#ff5555' : '#888' }}>
                                        {r.sumR >= 0 ? '+' : ''}{Number(r.sumR).toFixed(1)}R
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '10px', marginBottom: 0 }}>
                    {blkEvals
                        ? `Desde el 14/9: ${blkEvals.n} bloqueos simulados · ΣR hipotético ${blkEvals.sumR >= 0 ? '+' : ''}${blkEvals.sumR}R · ${blkEvals.sinBarras} sin datos de velas. Verde = el bloqueo te SALVÓ de pérdidas; rojo = te COSTÓ ganancias.`
                        : 'Aún sin bloqueos registrados — la captura arrancó hoy y se publica cada domingo.'}
                </p>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '6px', marginBottom: 0 }}>
                    Simulación conservadora: SL tiene prioridad sobre TP dentro de cada vela M5; TP1 cuenta como objetivo completo (en real es parcial); cap 24h → queda "abierta". Los estados almacenados de cada filtro se muestran sin controles de modificación.
                </p>
            </div>
            {/* 🆕 16-sep-2026: SALIDAS (contrafactual de gestión de salida por activo) */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🎯 SALIDAS — ¿QUÉ POLÍTICA HABRÍA RENDIDO MÁS?</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>exits_gate_eval · simulación con velas M5 reales</span>
                </div>
                <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse', marginTop: '10px' }}>
                    <thead>
                        <tr style={{ textAlign: 'left', color: '#777', fontSize: '0.72rem' }}>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>ACTIVO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>N</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>REAL (config viva)</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>PURO TP2/SL</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>PARCIAL 50% + BE</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>PARCIAL 50% SIN BE</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>GENES ACTUALES</th>
                        </tr>
                    </thead>
                    <tbody>
                        {exitsTickers.map(t => {
                            const ev = exitsEvals[t];
                            if (!ev) return null;
                            const enough = (ev.n ?? 0) >= 30; // 🆕 22-sep: gate n≥30 — con menos, el "mejor" es ruido
                            const best = Math.max(ev.R0, ev.R1, ev.R2, ev.R3);
                            const cell = (v: number) => ({
                                color: enough && v === best ? '#00e676' : v < 0 ? '#ff5555' : '#aaa',
                                weight: enough && v === best ? 700 : 400,
                            });
                            return (
                                <tr key={t} style={{ borderBottom: '1px solid #1a1a1a' }}>
                                    <td style={{ padding: '8px 4px', fontWeight: 700 }}>{t}</td>
                                    <td style={{ padding: '8px 4px', color: '#aaa' }}>{ev.n}</td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', ...cell(ev.R0) }}>{ev.R0 >= 0 ? '+' : ''}{ev.R0.toFixed(1)}R</td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', ...cell(ev.R1) }}>{ev.R1 >= 0 ? '+' : ''}{ev.R1.toFixed(1)}R</td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', ...cell(ev.R2) }}>{ev.R2 >= 0 ? '+' : ''}{ev.R2.toFixed(1)}R</td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', ...cell(ev.R3) }}>{ev.R3 >= 0 ? '+' : ''}{ev.R3.toFixed(1)}R</td>
                                    <td style={{ padding: '8px 4px', color: '#888', fontSize: '0.72rem' }}>
                                        {ev.genes ? `parcial ${ev.genes.partialClosePct}% · BE:${ev.genes.tp15BeEnabled ? 'on' : 'off'} · trail:${ev.genes.atrTrailEnabled ? 'on' : 'off'}` : '—'}
                                    </td>
                                    <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                                        {filterEvidence(ev?.evaluatedAt, ev?.n).actionable ? (
                                            <span style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                                <button className="btn" onClick={() => applyExitPolicy(t, 'P1')} disabled={exitApplying === t}>P1</button>
                                                <button className="btn" onClick={() => applyExitPolicy(t, 'P2')} disabled={exitApplying === t}>P2</button>
                                                <button className="btn" onClick={() => applyExitPolicy(t, 'P3')} disabled={exitApplying === t}>P3</button>
                                            </span>
                                        ) : <span style={{ color: '#888', fontSize: '0.72rem' }}>{filterEvidence(ev?.evaluatedAt, ev?.n).reason ?? ''}</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '10px', marginBottom: 0 }}>
                    {exitsEvals['_GLOBAL']
                        ? `Desde el 14/9: ${exitsEvals['_GLOBAL'].n} trades simulados · real ${exitsEvals['_GLOBAL'].R0 >= 0 ? '+' : ''}${exitsEvals['_GLOBAL'].R0}R vs puro ${exitsEvals['_GLOBAL'].R1 >= 0 ? '+' : ''}${exitsEvals['_GLOBAL'].R1}R. Verde = la mejor política del activo.`
                        : 'Aún sin datos — se publica con el pipeline dominical.'}
                </p>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '6px', marginBottom: 0 }}>
                    Simulación conservadora (SL prioritario dentro de la vela M5). "Puro" = sin parcial, sin trail, sin BE — todo al TP2 o SL. Si REAL pierde contra PURO de forma sostenida, los gadgets de salida están cortando ganadores y hay que re-tunear los genes (la comparación es investigación, no una validación certificada).
                </p>
            </div>

            {/* 🆕 16-sep-2026: ROLLOVER A/D POR ACTIVO */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🌙 ROLLOVER A/D POR ACTIVO</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>rollover_eval · A = SL→BE pre-rollover · D = bloqueo de entradas</span>
                </div>
                <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse', marginTop: '10px' }}>
                    <thead>
                        <tr style={{ textAlign: 'left', color: '#777', fontSize: '0.72rem' }}>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>ACTIVO</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>VENTANAS CRUZADAS</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>SL TOCADO POR SPREAD</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>R SALVADO (A)</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>ENTRADAS BLOQUEADAS (D)</th>
                            <th style={{ padding: '6px 4px', borderBottom: '1px solid #222' }}>REGLAS</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rollTickers.map(t => {
                            const ev = rollEvals[t];
                            if (!ev || (ev.nVentanas === 0 && ev.dBlocked === 0)) return null;
                            const st = rollOn[t] ?? { A: true, D: true };
                            return (
                                <tr key={t} style={{ borderBottom: '1px solid #1a1a1a' }}>
                                    <td style={{ padding: '8px 4px', fontWeight: 700 }}>{t}</td>
                                    <td style={{ padding: '8px 4px', color: '#aaa' }}>{ev.nVentanas}</td>
                                    <td style={{ padding: '8px 4px', color: ev.slTocado > 0 ? '#ffaa00' : '#888' }}>{ev.slTocado}</td>
                                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', color: ev.rSalvado > 0 ? '#00e676' : '#888' }}>
                                        {ev.rSalvado > 0 ? `+${ev.rSalvado.toFixed(1)}R` : '—'}
                                    </td>
                                    <td style={{ padding: '8px 4px', color: ev.dBlocked > 0 ? '#ffaa00' : '#888' }}>{ev.dBlocked}</td>
                                    <td style={{ padding: '8px 4px', display: 'flex', gap: '6px' }}>
                                        <button className="btn" disabled={!filterEvidence(ev?.evaluatedAt, ev?.nVentanas).actionable} onClick={() => toggleRollover(t, 'A', !st.A)}>A {st.A ? 'ON' : 'OFF'}</button>
                                        <button className="btn" disabled={!filterEvidence(ev?.evaluatedAt, ev?.nVentanas).actionable} onClick={() => toggleRollover(t, 'D', !st.D)}>D {st.D ? 'ON' : 'OFF'}</button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '10px', marginBottom: 0 }}>
                    {rollEvals['_GLOBAL']
                        ? `Desde el 14/9: ${rollEvals['_GLOBAL'].nVentanas} ventanas cruzadas · R salvado ${rollEvals['_GLOBAL'].rSalvado > 0 ? '+' : ''}${rollEvals['_GLOBAL'].rSalvado}R (A) · ${rollEvals['_GLOBAL'].dBlocked} entradas bloqueadas (D).`
                        : 'Aún sin datos — se publica con el pipeline dominical.'}
                </p>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '6px', marginBottom: 0 }}>
                    Ventana medida: 20:15-21:05 UTC (feed muerto + pico de spread ~19 pips). Supuesto: BE aplicado cuando la regla A está ON. Las bloqueadas por D se simulan en la sección de señales bloqueadas (motivo ROLLOVER).
                </p>
            </div>
        </div>
    );
}
