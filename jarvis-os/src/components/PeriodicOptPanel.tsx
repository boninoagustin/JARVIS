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
    ticker: string; timestamp: number; status: 'RECOMMEND' | 'HOLD' | 'HOLD_MC' | 'ERROR' | 'REFRESH_ERROR';
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

// Mapeo best_config (espacio hyperopt) → asset_configs (producción).
// 🚫 sessions/quedan fuera: el hyperopt las optimiza con el esquema del backtest
//    (tp2/slBuff por gatillo) que NO mapea 1:1 al esquema live → F3 con validación.
const APPLY_FIELDS: { src: string; dst: string; label: string; fmt: (v: any) => string }[] = [
    { src: 'minBuyPoints', dst: 'minPointsForBuy', label: 'Puntos Mín. BUY', fmt: v => String(Math.round(v)) },
    { src: 'minSellPoints', dst: 'minPointsForSell', label: 'Puntos Mín. SELL', fmt: v => String(Math.round(v)) },
    // 🆕 sep-2026 (A/B VWAP): peso del evento VWAP en el scoring (por activo)
    { src: 'vwapPts', dst: 'vwapPts', label: 'Peso VWAP (pts)', fmt: v => String(Math.round(v)) },
    // 🆕 sep-2026 (Capa 1): pesos de zona × sesión (OB/GOD/SB/BREAKER/SWEEP/DIV × sesión)
    { src: 'zoneWeights', dst: 'zoneWeights', label: 'Pesos de zona × sesión', fmt: v => JSON.stringify(v) },
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
        mergedTimesfm: Record<string, any> | null;
        mergedBias: any;
    } | null>(null);
    const [applying, setApplying] = useState<string | null>(null);
    const [health, setHealth] = useState<HealthReport | null>(null);
    // 🆕 sep-2026: reporte de gatillos perdedores (gatillo×sesión) + desactivar activo
    const [loser, setLoser] = useState<LoserReport | null>(null);
    const [loserApplying, setLoserApplying] = useState<{
        ticker: string;
        diff: { label: string; old: string; new: string }[];
        mergedSessions: Record<string, Record<string, any>>;
    } | null>(null);
    const [disabling, setDisabling] = useState<string | null>(null);
    const [activating, setActivating] = useState<string | null>(null);
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
    // 🐛 fix (sep-2026): gatillos ya aplicados por ticker (persistido en el doc LOSER_TRIGGERS_PROPOSAL.applied)
    // — sin esto, la tarjeta seguía mostrando las propuestas tras aplicarlas (el reporte es estático).
    const [loserApplied, setLoserApplied] = useState<Record<string, number>>({});
    // 🆕 sep-2026: Asset Scout — ranking de candidatos + lista de activos oficiales + estado enabled
    const [scout, setScout] = useState<ScoutReport | null>(null);
    const [activeList, setActiveList] = useState<string[]>([]);
    const [promoting, setPromoting] = useState<string | null>(null);
    const [assetEnabled, setAssetEnabled] = useState<Record<string, boolean>>({});

    const fetchReports = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(collection(db, 'opt_reports'));
            // 🩺 FIX key-warning: opt_reports también guarda docs sin ticker (ej. PARITY_LIVE_VS_BACKTEST
            // del report de paridad), que no son reports por activo. Filtrarlos evita key={undefined}
            // en el map de abajo (warning de React) y que aparezcan como tarjetas fantasma.
            const data = snap.docs
                .map(d => ({ ...(d.data() as OptReport), id: d.id }))
                .filter(r => typeof r.ticker === 'string' && r.ticker.length > 0);
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

    // 🆕 sep-2026: reporte de gatillos perdedores (documento aparte en opt_reports)
    const fetchLoser = async () => {
        try {
            const lsnap = await getDoc(doc(db, 'opt_reports', 'LOSER_TRIGGERS_PROPOSAL'));
            if (lsnap.exists()) {
                const d = lsnap.data() as any;
                setLoser({ generatedAt: d.generatedAt, status: d.status, disables: d.disables || [], enables: d.enables || [] });
                // 🐛 fix: propuestas ya aplicadas en sesiones anteriores del panel
                setLoserApplied(d.applied && typeof d.applied === 'object' ? d.applied : {});
            }
        } catch (err) {
            console.error('Error fetching loser triggers:', err);
        }
    };

    // 🆕 sep-2026: Asset Scout + lista de activos oficiales + estado enabled por activo
    const fetchScout = async () => {
        try {
            const s = await getDoc(doc(db, 'opt_reports', 'ASSET_SCOUT'));
            if (s.exists()) setScout(s.data() as ScoutReport);
            const a = await getDoc(doc(db, 'optimization_config', 'active_tickers'));
            if (a.exists()) {
                const d = a.data() as any;
                setActiveList(Array.isArray(d.tickers) ? d.tickers : []);
            }
            const snap = await getDocs(collection(db, 'asset_configs'));
            const en: Record<string, boolean> = {};
            const mg: Record<string, boolean> = {};
            const co: Record<string, boolean> = {};
            const tf: Record<string, boolean> = {};
            snap.forEach(d => {
                if (d.id !== 'GLOBAL') {
                    en[d.id] = (d.data() as any).enabled !== false;
                    mg[d.id] = (d.data() as any).mlGateEnabled === true; // 🆕 gate ML por activo
                    co[d.id] = (d.data() as any).correlationFilter?.shadow === false; // 🆕 filtro correlación: shadow:false = BLOQUEA
                    tf[d.id] = (d.data() as any).timesfm?.enabled === true; // 🆕 filtro TimesFM: enabled = activo
                }
            });
            setAssetEnabled(en);
            setMlGateOn(mg);
            setCorrOn(co);
            setTfmOn(tf);
            // 🆕 16-sep-2026: resultados del sweep ML publicados por scripts/ml_threshold_sweep.ts
            const ev = await getDocs(collection(db, 'ml_gate_evals'));
            const evMap: Record<string, any> = {};
            ev.forEach(d => { evMap[d.id] = d.data(); });
            setMlEvals(evMap);
            // 🆕 16-sep-2026: contrafactual del filtro de correlación (scripts/corr_gate_eval.ts)
            const ce = await getDocs(collection(db, 'corr_gate_evals'));
            const ceMap: Record<string, any> = {};
            ce.forEach(d => { ceMap[d.id] = d.data(); });
            setCorrEvals(ceMap);
            // 🆕 16-sep-2026: contrafactual del filtro TimesFM (scripts/timesfm_gate_eval.ts)
            const te = await getDocs(collection(db, 'timesfm_gate_evals'));
            const teMap: Record<string, any> = {};
            te.forEach(d => { teMap[d.id] = d.data(); });
            setTfmEvals(teMap);
            // 🆕 16-sep-2026: contrafactual de señales bloqueadas (scripts/blocked_signals_eval.ts)
            const be = await getDoc(doc(db, 'blocked_signals_evals', '_GLOBAL'));
            if (be.exists()) setBlkEvals(be.data());
            // 🆕 16-sep-2026: salidas (exits_gate_eval) + rollover A/D (rollover_eval)
            const xe = await getDocs(collection(db, 'exits_gate_evals'));
            const xeMap: Record<string, any> = {};
            xe.forEach(d => { xeMap[d.id] = d.data(); });
            setExitsEvals(xeMap);
            const re = await getDocs(collection(db, 'rollover_evals'));
            const reMap: Record<string, any> = {};
            re.forEach(d => { reMap[d.id] = d.data(); });
            setRollEvals(reMap);
            const ro: Record<string, { A: boolean; D: boolean }> = {};
            snap.forEach(d => {
                if (d.id === 'GLOBAL') return;
                const c = d.data() as any;
                ro[d.id] = { A: c.rolloverBeEnabled !== false, D: c.rolloverEntryBlock !== false };
            });
            setRollOn(ro);
        } catch (err) {
            console.error('Error fetching scout:', err);
        }
    };

    // 🆕 sep-2026: promover un candidato a la lista oficial (el dominical lo optimiza el domingo)
    const promoteTicker = async (ticker: string) => {
        setPromoting(ticker);
        try {
            const ref = doc(db, 'optimization_config', 'active_tickers');
            const snap = await getDoc(ref);
            const cur: string[] = snap.exists() ? ((snap.data() as any).tickers || []) : [];
            if (cur.includes(ticker)) {
                toast(`${ticker} ya está en la lista oficial`, 'info' as any);
                setPromoting(null);
                return;
            }
            await setDoc(ref, { tickers: [...cur, ticker], updatedAt: new Date().toISOString() }, { merge: true });
            setActiveList([...cur, ticker]);
            toast(`⚡ ${ticker} PROMOVIDO — el optimizador dominical lo evalúa el próximo domingo (hyperopt + ML)`, 'success');
        } catch (e) {
            console.error(e);
            toast(`❌ Error promoviendo ${ticker}`, 'error');
        } finally {
            setPromoting(null);
        }
    };

    // 🆕 16-sep-2026: activar/apagar el gate ML de un activo (mlGateEnabled en asset_configs → bot en caliente)
    const toggleMLGate = async (ticker: string, on: boolean) => {
        try {
            await setDoc(doc(db, 'asset_configs', ticker), { mlGateEnabled: on }, { merge: true });
            setMlGateOn(prev => ({ ...prev, [ticker]: on }));
            toast(on ? `🧠 GATE ML ACTIVADO en ${ticker} — el bot lo toma al instante` : `🧠 Gate ML apagado en ${ticker}`, on ? 'success' : 'info' as any);
        } catch (e) {
            console.error(e);
            toast(`❌ Error actualizando gate ML de ${ticker}`, 'error');
        }
    };

    // 🆕 16-sep-2026: lista para la tabla GATE ML (oficiales ∪ con config ∪ evaluados)
    const mlTickers = [...new Set([...activeList, ...Object.keys(assetEnabled), ...Object.keys(mlEvals)])].sort();

    // 🆕 16-sep-2026: activar/apagar el filtro de correlación de un activo
    // (correlationFilter.shadow:false = bloquea de verdad; shadow:true = solo observa)
    const toggleCorrFilter = async (ticker: string, on: boolean) => {
        try {
            await setDoc(doc(db, 'asset_configs', ticker), { correlationFilter: { shadow: !on } }, { merge: true });
            setCorrOn(prev => ({ ...prev, [ticker]: on }));
            toast(on ? `🧲 FILTRO CORRELACIÓN ACTIVADO en ${ticker} — bloquea y aplica risk-parity al instante` : `🧲 Filtro correlación en observación en ${ticker}`, on ? 'success' : 'info' as any);
        } catch (e) {
            console.error(e);
            toast(`❌ Error actualizando filtro de correlación de ${ticker}`, 'error');
        }
    };

    // 🆕 16-sep-2026: lista para la tabla FILTRO CORRELACIÓN
    const corrTickers = [...new Set([...activeList, ...Object.keys(assetEnabled), ...Object.keys(corrEvals).filter(k => k !== '_GLOBAL')])].sort();
    const fmtUsd = (v?: number) => (v === undefined || v === null) ? '—' : `${v >= 0 ? '+' : ''}$${Number(v).toFixed(2)}`;
    const fmtRc = (v?: number) => (v === undefined || v === null) ? '' : ` / ${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}R`;

    // 🆕 16-sep-2026: activar/apagar TimesFM de un activo (read-modify-write para no pisar
    // el resto del bloque timesfm: minScoreToOverrideReject, mults, tp2Dynamic...)
    const toggleTimesfm = async (ticker: string, on: boolean) => {
        try {
            const ref = doc(db, 'asset_configs', ticker);
            const snap = await getDoc(ref);
            const cur = snap.exists() ? ((snap.data() as any).timesfm ?? {}) : {};
            await setDoc(ref, { timesfm: { ...cur, enabled: on } }, { merge: true });
            setTfmOn(prev => ({ ...prev, [ticker]: on }));
            toast(on ? `🧊 TIMESFM ACTIVADO en ${ticker} — dirección + riskMult al instante` : `🧊 TimesFM apagado en ${ticker}`, on ? 'success' : 'info' as any);
        } catch (e) {
            console.error(e);
            toast(`❌ Error actualizando TimesFM de ${ticker}`, 'error');
        }
    };

    // 🆕 16-sep-2026: lista para la tabla TIMESFM
    const tfmTickers = [...new Set([...activeList, ...Object.keys(assetEnabled), ...Object.keys(tfmEvals).filter(k => k !== '_GLOBAL')])].sort();

    // 🆕 16-sep-2026: toggle reglas rollover A/D por activo (flags booleanos directos)
    const toggleRollover = async (ticker: string, rule: 'A' | 'D', on: boolean) => {
        try {
            const field = rule === 'A' ? 'rolloverBeEnabled' : 'rolloverEntryBlock';
            await setDoc(doc(db, 'asset_configs', ticker), { [field]: on }, { merge: true });
            setRollOn(prev => ({ ...prev, [ticker]: { ...(prev[ticker] ?? { A: true, D: true }), [rule]: on } }));
            toast(`🌙 Regla ${rule} de rollover ${on ? 'ACTIVADA' : 'apagada'} en ${ticker}`, on ? 'success' : 'info' as any);
        } catch (e) {
            console.error(e);
            toast(`❌ Error actualizando rollover de ${ticker}`, 'error');
        }
    };

    // 🆕 16-sep-2026: lista para las tablas SALIDAS y ROLLOVER
    const exitsTickers = [...new Set([...activeList, ...Object.keys(exitsEvals).filter(k => k !== '_GLOBAL')])].sort();
    const rollTickers = [...new Set([...activeList, ...Object.keys(rollEvals).filter(k => k !== '_GLOBAL')])].sort();

    // 🆕 16-sep-2026: aplicar una política de salida a TODOS los gatillos de un activo.
    // P1=puro (sin parcial/trail/BE), P2=parcial 50%+BE, P3=parcial 50% sin BE.
    // Escribe los genes en cada bloque sessions[s][t] → el bot los toma en caliente.
    // (El próximo dominical PROPONE de nuevo, no pisa: aplicar otra propuesta sí los reemplaza.)
    const [exitApplying, setExitApplying] = useState<string | null>(null);
    // 🆕 16-sep-2026: feedback de política aplicada (el botón quedaba igual después de aplicar)
    const [appliedExitPolicies, setAppliedExitPolicies] = useState<Record<string, string>>({});
    const applyExitPolicy = async (ticker: string, policy: 'P1' | 'P2' | 'P3') => {
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
            for (const s of Object.keys(sessions)) {
                for (const g of Object.keys(sessions[s] ?? {})) {
                    sessions[s][g] = { ...sessions[s][g], ...GENES[policy] };
                    touched++;
                }
            }
            await setDoc(ref, { sessions }, { merge: true });
            const name = policy === 'P1' ? 'PURO TP2/SL' : policy === 'P2' ? 'PARCIAL 50% + BE' : 'PARCIAL 50% SIN BE';
            setAppliedExitPolicies(prev => ({ ...prev, [ticker]: policy }));
            // Reflejar los genes nuevos en la columna GENES ACTUALES sin recargar la página
            setExitsEvals(prev => prev[ticker]
                ? { ...prev, [ticker]: { ...prev[ticker], genes: { partialClosePct: GENES[policy].partialClosePct, tp15BeEnabled: GENES[policy].tp15BeEnabled, atrTrailEnabled: GENES[policy].atrTrailEnabled } } }
                : prev);
            toast(`🎯 ${ticker}: política "${name}" aplicada a ${touched} gatillos — el bot la usa al instante`, 'success');
        } catch (e) {
            console.error(e);
            toast(`❌ Error aplicando política de salida en ${ticker}`, 'error');
        } finally {
            setExitApplying(null);
        }
    };

    // 🆕 sep-2026: activar un activo (escribe enabled=true — el bot lo toma al instante vía listener)
    const confirmActivate = async () => {
        const ticker = activating;
        if (!ticker) return;
        setApplying(ticker);
        try {
            await setDoc(doc(db, 'asset_configs', ticker), {
                enabled: true,
                updatedAt: new Date().toISOString(),
                updatedBy: 'panel_activate',
            }, { merge: true });
            setAssetEnabled(prev => ({ ...prev, [ticker]: true }));
            toast(`🔵 ${ticker} ACTIVADO — el bot puede operarlo desde ahora`, 'success');
            setActivating(null);
        } catch (e) {
            console.error(e);
            toast(`❌ Error activando ${ticker}`, 'error');
        } finally {
            setApplying(null);
        }
    };

    useEffect(() => { fetchReports(); fetchHealth(); fetchLoser(); fetchScout(); }, []);

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
                    // 🆕 11-sep-2026: política gatillo-por-gatillo (solo-5M derogada por Bon):
                    // los 15m ganadores (AUDJPY/XAUUSD.oteChoch15m) ahora se proponen y aplican.
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
        // 🆕 sep-2026: umbral TimesFM tuneado por activo — merge PROFUNDO del bloque timesfm
        let mergedTimesfm: Record<string, any> | null = null;
        const tfProposed = report.timesfm_apply?.minScoreToOverrideReject;
        if (tfProposed !== undefined && tfProposed !== null) {
            const curTf = (current.timesfm || {}) as Record<string, any>;
            if ((curTf.minScoreToOverrideReject ?? 15) !== tfProposed) {
                mergedTimesfm = { ...curTf, minScoreToOverrideReject: tfProposed };
                diff.push({ label: '🌙 TimesFM umbral', old: String(curTf.minScoreToOverrideReject ?? 15), new: String(tfProposed) });
            }
        }
        // 🆕 sep-2026: confluencia de bias por activo (bono de alineación)
        let mergedBias: any = null;
        const bcRec = report.bias_confluence?.recommended?.bc;
        if (bcRec && Array.isArray(bcRec.tfs) && bcRec.tfs.length) {
            const curBc = (current.biasConfluence || {}) as any;
            const newStr = JSON.stringify(bcRec);
            const oldStr = curBc && Object.keys(curBc).length ? JSON.stringify(curBc) : '(default 3/3 macro)';
            if (oldStr !== newStr) {
                mergedBias = bcRec;
                diff.push({ label: '🧭 Bias confluencia', old: oldStr, new: newStr });
            }
        }
        if (diff.length === 0) {
            toast(`La propuesta de ${ticker} ya está aplicada — no hay cambios`, 'success');
            return;
        }
        setConfirming({ ticker, diff, mergedSessions, mergedTimesfm, mergedBias });
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
            // 🆕 sep-2026: bloque timesfm (merge profundo) y confluencia de bias
            if (confirming.mergedTimesfm) payload.timesfm = confirming.mergedTimesfm;
            if (confirming.mergedBias) payload.biasConfluence = confirming.mergedBias;
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

    // 🆕 sep-2026: DESACTIVAR activo (killswitch maestro, sobrevive al tune — solo mergea sessions)
    const confirmDisable = async () => {
        const ticker = disabling;
        if (!ticker) return;
        setApplying(ticker);
        try {
            await setDoc(doc(db, 'asset_configs', ticker), {
                enabled: false,
                disabledReason: 'desactivado manual desde el panel', // 🆕 27-sep-2026: protege el kill manual del auto-activador
                updatedAt: new Date().toISOString(),
                updatedBy: 'panel_disable',
            }, { merge: true });
            setAssetEnabled(prev => ({ ...prev, [ticker]: false })); // 🐛 fix: sin esto el botón seguía visible
            toast(`🔴 ${ticker} DESACTIVADO — no entrará en nuevos trades (las posiciones abiertas siguen gestionándose)`, 'success');
            setDisabling(null);
        } catch (e) {
            console.error(e);
            toast(`❌ Error desactivando ${ticker}`, 'error');
        } finally {
            setApplying(null);
        }
    };

    // 🆕 sep-2026: aplicar propuesta de gatillos perdedores (gatillo×sesión)
    const prepareLoserApply = async (ticker: string) => {
        if (!loser) return;
        const currentSnap = await getDoc(doc(db, 'asset_configs', ticker));
        const current = currentSnap.exists() ? currentSnap.data() : {};
        const merged = JSON.parse(JSON.stringify(current.sessions || {})) as Record<string, Record<string, any>>;
        const diff: { label: string; old: string; new: string }[] = [];
        const props = [...loser.disables, ...loser.enables].filter(p => p.ticker === ticker);
        if (props.length === 0) { toast(`Sin propuestas para ${ticker}`, 'info' as any); return; }
        for (const p of props) {
            merged[p.session] = merged[p.session] || {};
            const curT = merged[p.session][p.trigger] || {};
            if (loser.disables.includes(p)) {
                diff.push({ label: `🔴 ${p.session}/${p.trigger}`, old: `minScore ${curT.minScore ?? '(—)'}`, new: 'minScore 99 (APAGAR)' });
                merged[p.session][p.trigger] = { ...curT, minScore: 99 };
            } else {
                diff.push({ label: `🟢 ${p.session}/${p.trigger}`, old: `minScore ${curT.minScore ?? '(—)'}`, new: 'minScore 4 + enabled (ACTIVAR)' });
                merged[p.session][p.trigger] = { ...curT, minScore: 4, enabled: true };
            }
        }
        setLoserApplying({ ticker, diff, mergedSessions: merged });
    };

    const confirmLoserApply = async () => {
        if (!loserApplying) return;
        const { ticker, mergedSessions } = loserApplying;
        setApplying(`loser:${ticker}`);
        try {
            await setDoc(doc(db, 'asset_configs', ticker), {
                sessions: mergedSessions,
                updatedAt: new Date().toISOString(),
                updatedBy: 'panel_loser',
            }, { merge: true });
            // 🐛 fix: marcar como aplicado (local + persistido) para que la tarjeta no lo siga mostrando
            const next = { ...loserApplied, [ticker]: Date.now() };
            setLoserApplied(next);
            const lref = doc(db, 'opt_reports', 'LOSER_TRIGGERS_PROPOSAL');
            const lsnap = await getDoc(lref);
            const prevApplied = (lsnap.exists() && lsnap.data().applied && typeof lsnap.data().applied === 'object') ? lsnap.data().applied : {};
            await setDoc(lref, { applied: { ...prevApplied, [ticker]: Date.now() } }, { merge: true });
            toast(`✅ Gatillos aplicados para ${ticker}`, 'success');
            setLoserApplying(null);
            fetchLoser();
        } catch (e) {
            console.error(e);
            toast(`❌ Error aplicando gatillos de ${ticker}`, 'error');
        } finally {
            setApplying(null);
        }
    };

    const statusBadge = (r: OptReport) => {
        if (r.appliedAt) return <span style={{ ...badge, background: '#0088ff20', color: '#0088ff', borderColor: '#0088ff40' }}>✓ APLICADA</span>;
        if (r.status === 'RECOMMEND') return <span style={{ ...badge, background: '#00e67620', color: '#00e676', borderColor: '#00e67640' }}>● RECOMIENDA APLICAR</span>;
        if (r.status === 'HOLD_MC') return <span style={{ ...badge, background: '#ffaa0020', color: '#ffaa00', borderColor: '#ffaa0040' }}>⛔ SIN EDGE (MC)</span>;
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
                        {/* 🆕 sep-2026: veredicto Monte Carlo + propuestas nuevas (TimesFM / bias) */}
                        {r.montecarlo?.verdict_short && (
                            <span title={r.montecarlo.verdict || 'Monte Carlo'}>
                                🎲 <b>Monte Carlo:</b> {r.montecarlo.verdict_short}
                                {r.montecarlo.survival !== undefined && ` (${(r.montecarlo.survival * 100).toFixed(0)}% survival, n=${r.montecarlo.n ?? '—'})`}
                            </span>
                        )}
                        {r.timesfm_apply?.minScoreToOverrideReject !== undefined && r.timesfm_apply?.minScoreToOverrideReject !== null && (
                            <span title="Umbral del filtro TimesFM tuneado por activo (se aplica con el botón de abajo)">
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

                    {/* 🆕 sep-2026: HOLD_MC + producción perdiendo → sugerencia de desactivar el activo */}
                    {r.status === 'HOLD_MC' && !r.appliedAt && assetEnabled[r.ticker] !== false && (r.production_oos?.net_pnl_r ?? 0) < 0 && (
                        <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                            <button
                                onClick={() => setDisabling(r.ticker)}
                                disabled={applying === r.ticker}
                                style={{ padding: '10px 20px', background: '#ff3333', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applying === r.ticker ? 'wait' : 'pointer' }}
                            >
                                {applying === r.ticker ? 'APLICANDO...' : '🔴 DESACTIVAR ACTIVO'}
                            </button>
                            <span style={{ fontSize: '0.75rem', color: '#ffaa00' }}>
                                El backtest propone mejorar, pero el Monte Carlo no confirma edge y la producción OOS pierde {fmtR(r.production_oos.net_pnl_r)}R. Si lo dejás, seguí de cerca.
                            </span>
                        </div>
                    )}

                    {/* 🆕 sep-2026: activo desactivado o sin config con RECOMMEND → propuesta de activación */}
                    {r.status === 'RECOMMEND' && !r.appliedAt && !assetEnabled[r.ticker] && (
                        <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                            <button
                                onClick={() => setActivating(r.ticker)}
                                disabled={applying === r.ticker}
                                style={{ padding: '10px 20px', background: '#0088ff', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applying === r.ticker ? 'wait' : 'pointer' }}
                            >
                                {applying === r.ticker ? 'APLICANDO...' : '🔵 ACTIVAR ACTIVO'}
                            </button>
                            <span style={{ fontSize: '0.75rem', color: '#888' }}>
                                Este activo está desactivado o nunca operó. Activarlo deja que el bot entre en sus señales (aplicá primero la optimización si querés la config fina).
                            </span>
                        </div>
                    )}
                </div>
            ))}

            {/* 🆕 sep-2026: propuesta de gatillos perdedores (gatillo×sesión) */}
            {loser && (
                <div style={{ ...card, borderColor: (loser.disables.length || loser.enables.length) ? '#ffaa0040' : '#222' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                        <h3 style={{ margin: 0, color: '#e6e6e6', fontSize: '1.05rem' }}>🚦 Gatillos perdedores — propuesta semanal (gatillo × sesión)</h3>
                        {loser.generatedAt && (
                            <span style={{ fontSize: '0.75rem', color: '#666' }}>
                                {new Date(loser.generatedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
                            </span>
                        )}
                    </div>
                    {loser.disables.length === 0 && loser.enables.length === 0 ? (
                        <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '10px', marginBottom: 0 }}>
                            Sin propuestas esta semana: ningún gatillo×sesión pasa los umbrales (n≥8, ±0.15R/t en ventana 84d).
                        </p>
                    ) : (() => {
                        const pendingTickers = [...new Set([...loser.disables, ...loser.enables].map(p => p.ticker))]
                            .filter(t => !loserApplied[t]);
                        if (pendingTickers.length === 0) {
                            return (
                                <p style={{ color: '#00e676', fontSize: '0.85rem', marginTop: '10px', marginBottom: 0 }}>
                                    ✅ Todas las propuestas de esta semana ya fueron aplicadas.
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
                                            <button
                                                onClick={() => prepareLoserApply(ticker)}
                                                disabled={applying === `loser:${ticker}`}
                                                style={{ padding: '6px 14px', background: '#ffaa00', color: '#000', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applying === `loser:${ticker}` ? 'wait' : 'pointer' }}
                                            >
                                                {applying === `loser:${ticker}` ? 'APLICANDO...' : 'REVISAR Y APLICAR'}
                                            </button>
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
                                {new Date(scout.generatedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })} · ventana {scout.windowDays}d
                            </span>
                        )}
                    </div>
                    <p style={{ fontSize: '0.75rem', color: '#888', marginTop: '6px', marginBottom: 0 }}>
                        Screening con config sonda (sin hyperopt). PROMOVER agrega el activo a la lista oficial: el dominical le corre hyperopt + ML y recién ahí te propone activarlo. Nunca opera solo.
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
                                    const canPromote = (v === 'PASS' || v === 'MARGINAL') && !promoted;
                                    return (
                                        <tr key={row.ticker} style={{ borderTop: '1px solid #1a1a1a' }}>
                                            <td style={{ padding: '6px 8px', color: '#e6e6e6', fontWeight: 600 }}>{row.ticker}</td>
                                            <td style={{ padding: '6px 8px', color: '#aaa' }}>{row.cat}</td>
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: row.error ? '#ff6666' : '#aaa' }}>{row.error ? '⚠' : row.win84?.n ?? '—'}</td>
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#aaa' }}>{row.error ? '—' : (row.win84?.pf ?? '—').toFixed(2)}</td>
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: (row.win84?.netR ?? 0) >= 0 ? '#00e676' : '#ff6666' }}>{row.error ? '—' : (row.win84?.netR ?? 0).toFixed(1)}</td>
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#aaa' }}>{row.error ? '—' : (row.win84?.maxDD ?? 0).toFixed(1)}</td>
                                            <td style={{ padding: '6px 8px', fontWeight: 700, color: vColor }}>{row.error ? 'ERROR' : v}</td>
                                            <td style={{ padding: '6px 8px' }}>
                                                {promoted ? (
                                                    <span style={{ fontSize: '0.72rem', color: '#4488ff', fontWeight: 700 }}>✓ PROMOVIDO</span>
                                                ) : canPromote ? (
                                                    <button
                                                        onClick={() => promoteTicker(row.ticker)}
                                                        disabled={promoting === row.ticker}
                                                        style={{ padding: '5px 12px', background: '#4488ff', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: promoting === row.ticker ? 'wait' : 'pointer', fontSize: '0.75rem' }}
                                                    >
                                                        {promoting === row.ticker ? '...' : '⚡ PROMOVER'}
                                                    </button>
                                                ) : (
                                                    <span style={{ fontSize: '0.72rem', color: '#555' }}>—</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

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

            {/* 🆕 sep-2026: modal de confirmación para DESACTIVAR activo */}
            {disabling && (
                <div className="modal-overlay" onClick={() => setDisabling(null)}>
                    <div className="modal-content-premium" onClick={e => e.stopPropagation()} style={{ borderColor: '#ff333350', maxWidth: '460px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <div className="modal-header-premium" style={{ justifyContent: 'space-between', width: '100%', flexShrink: 0 }}>
                            <span>🔴</span>
                            <h3 style={{ margin: 0 }}>DESACTIVAR {disabling}</h3>
                        </div>
                        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: '4px' }}>
                            <p style={{ fontSize: '0.85rem', color: '#ff6666' }}>
                                Vas a escribir <b>enabled=false</b> en asset_configs/{disabling}.
                            </p>
                            <p style={{ fontSize: '0.8rem', color: '#aaa' }}>
                                El bot dejará de abrir posiciones nuevas en este activo. Las posiciones ya abiertas se siguen gestionando normalmente (SL/TP/parciales). Sobrevive al optimizador dominical (que solo mergea sesiones). Podés revertirlo desde el Panel de Control o desde acá en la próxima corrida.
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', marginTop: '14px', flexShrink: 0 }}>
                            <button onClick={() => setDisabling(null)} style={{ flex: 1, padding: '10px', background: '#111', color: '#e6e6e6', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer' }}>Cancelar</button>
                            <button onClick={confirmDisable} disabled={applying === disabling} style={{ flex: 1, padding: '10px', background: '#ff3333', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applying === disabling ? 'wait' : 'pointer' }}>
                                {applying === disabling ? 'APLICANDO...' : 'CONFIRMAR DESACTIVACIÓN'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 🆕 sep-2026: modal de confirmación para ACTIVAR activo */}
            {activating && (
                <div className="modal-overlay" onClick={() => setActivating(null)}>
                    <div className="modal-content-premium" onClick={e => e.stopPropagation()} style={{ borderColor: '#4488ff60', maxWidth: '460px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <div className="modal-header-premium" style={{ justifyContent: 'space-between', width: '100%', flexShrink: 0 }}>
                            <span>🔵</span>
                            <h3 style={{ margin: 0 }}>ACTIVAR {activating}</h3>
                        </div>
                        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: '4px' }}>
                            <p style={{ fontSize: '0.85rem', color: '#88bbff' }}>
                                Vas a escribir <b>enabled=true</b> en asset_configs/{activating}.
                            </p>
                            <p style={{ fontSize: '0.8rem', color: '#aaa' }}>
                                El bot empieza a tomar señales de este activo al instante (listener Firestore). Si el activo nunca operó, conviene aplicar primero la optimización recomendada (botón verde) para que entre con la config fina del dominical y no con defaults.
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', marginTop: '14px', flexShrink: 0 }}>
                            <button onClick={() => setActivating(null)} style={{ flex: 1, padding: '10px', background: '#111', color: '#e6e6e6', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer' }}>Cancelar</button>
                            <button onClick={confirmActivate} disabled={applying === activating} style={{ flex: 1, padding: '10px', background: '#0088ff', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applying === activating ? 'wait' : 'pointer' }}>
                                {applying === activating ? 'APLICANDO...' : 'CONFIRMAR ACTIVACIÓN'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 🆕 sep-2026: modal de confirmación para aplicar gatillos perdedores */}
            {loserApplying && (
                <div className="modal-overlay" onClick={() => setLoserApplying(null)}>
                    <div className="modal-content-premium" onClick={e => e.stopPropagation()} style={{ borderColor: '#ffaa0050', maxWidth: '460px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <div className="modal-header-premium" style={{ justifyContent: 'space-between', width: '100%', flexShrink: 0 }}>
                            <span>🚦</span>
                            <h3 style={{ margin: 0 }}>GATILLOS — {loserApplying.ticker}</h3>
                        </div>
                        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: '4px' }}>
                            <p style={{ fontSize: '0.8rem', color: '#888' }}>Cambios que se van a escribir en sessions de asset_configs:</p>
                            <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                                <tbody>
                                    {loserApplying.diff.map(d => (
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
                                Merge profundo: solo se tocan los gatillos listados; el resto de sessions queda intacto. El bot toma la config al instante (listener Firestore).
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', marginTop: '14px', flexShrink: 0 }}>
                            <button onClick={() => setLoserApplying(null)} style={{ flex: 1, padding: '10px', background: '#111', color: '#e6e6e6', border: '1px solid #333', borderRadius: '4px', cursor: 'pointer' }}>Cancelar</button>
                            <button onClick={confirmLoserApply} disabled={applying === `loser:${loserApplying.ticker}`} style={{ flex: 1, padding: '10px', background: '#ffaa00', color: '#000', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: applying === `loser:${loserApplying.ticker}` ? 'wait' : 'pointer' }}>
                                {applying === `loser:${loserApplying.ticker}` ? 'APLICANDO...' : 'CONFIRMAR'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* 🆕 16-sep-2026: GATE ML POR ACTIVO — activar/apagar desde el panel (mlGateEnabled, bot en caliente) */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🧠 GATE ML POR ACTIVO</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>sweep → ml_gate_evals · botón → asset_configs.mlGateEnabled (sin restart)</span>
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
                                                <span style={{ color: '#666', fontSize: '0.68rem' }}> · {new Date(ev.evaluatedAt).toLocaleString()}</span>
                                            </span>
                                            : <span style={{ color: '#666' }}>sin evaluación</span>}
                                    </td>
                                    <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                                        <button
                                            onClick={() => toggleMLGate(t, !on)}
                                            style={{
                                                padding: '6px 12px', fontSize: '0.78rem', fontWeight: 700, borderRadius: '4px', cursor: 'pointer',
                                                background: on ? '#111' : (deltaGood ? '#0088ff' : '#222'),
                                                color: on ? '#e6e6e6' : (deltaGood ? '#fff' : '#999'),
                                                border: `1px solid ${on ? '#333' : (deltaGood ? '#0088ff' : '#444')}`,
                                            }}
                                        >
                                            {on ? 'APAGAR GATE' : 'ACTIVAR GATE'}
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <p style={{ fontSize: '0.7rem', color: '#666', marginTop: '10px', marginBottom: 0 }}>
                    {mlTickers.length === 0
                        ? 'Sin activos — la lista sale de optimization_config/active_tickers.'
                        : 'Regla (16-sep-2026): activar SOLO si el sweep muestra que el gate suma (Δ positivo). Apagar si resta o el modelo quedó viejo. El bot aplica en caliente, sin restart.'}
                </p>
            </div>
            {/* 🆕 16-sep-2026: FILTRO CORRELACIÓN POR ACTIVO — contrafactual + botón (shadow:false bloquea en vivo) */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🧲 FILTRO CORRELACIÓN POR ACTIVO</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>eval → corr_gate_evals · botón → asset_configs.correlationFilter (sin restart)</span>
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
                                        <button
                                            onClick={() => toggleCorrFilter(t, !on)}
                                            style={{
                                                padding: '6px 12px', fontSize: '0.78rem', fontWeight: 700, borderRadius: '4px', cursor: 'pointer',
                                                background: on ? '#111' : '#222',
                                                color: on ? '#e6e6e6' : '#999',
                                                border: `1px solid ${on ? '#333' : '#444'}`,
                                            }}
                                        >
                                            {on ? 'APAGAR FILTRO' : 'ACTIVAR FILTRO'}
                                        </button>
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
                    Criterio: activar cuando el bloqueo o el risk-parity muestren ahorro neto sostenido (Δ verde). Apagar si cuesta trades ganadores (Δ rojo). Cubre TODOS los gatillos (OTE + directas) — verificado contra cTrader.
                </p>
            </div>
            {/* 🆕 16-sep-2026: TIMESFM POR ACTIVO — contrafactual + botón (asset_configs.timesfm.enabled) */}
            <div className="premium-card" style={{ marginTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <h3 style={{ margin: 0 }}>🧊 TIMESFM POR ACTIVO</h3>
                    <span style={{ fontSize: '0.72rem', color: '#777' }}>eval → timesfm_gate_evals · botón → asset_configs.timesfm.enabled (sin restart)</span>
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
                                        <button
                                            onClick={() => toggleTimesfm(t, !on)}
                                            style={{
                                                padding: '6px 12px', fontSize: '0.78rem', fontWeight: 700, borderRadius: '4px', cursor: 'pointer',
                                                background: on ? '#111' : '#222',
                                                color: on ? '#e6e6e6' : '#999',
                                                border: `1px solid ${on ? '#333' : '#444'}`,
                                            }}
                                        >
                                            {on ? 'APAGAR TIMESFM' : 'ACTIVAR TIMESFM'}
                                        </button>
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
                    Simulación conservadora: SL tiene prioridad sobre TP dentro de cada vela M5; TP1 cuenta como objetivo completo (en real es parcial); cap 24h → queda "abierta". Los bloqueos de cada filtro se controlan desde su sección (ML, correlación, TimesFM).
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
                            const bestPol = ev.R1 === best ? 'P1' : ev.R2 === best ? 'P2' : ev.R3 === best ? 'P3' : null;
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
                                        {appliedExitPolicies[t]
                                            ? <button
                                                disabled
                                                style={{ padding: '6px 12px', fontSize: '0.75rem', fontWeight: 700, borderRadius: '4px', cursor: 'default', background: '#00c853', color: '#fff', border: 'none' }}
                                            >
                                                ✓ {appliedExitPolicies[t]} APLICADA
                                            </button>
                                            : bestPol && enough
                                                ? <button
                                                    onClick={() => applyExitPolicy(t, bestPol)}
                                                    disabled={exitApplying === t}
                                                    style={{ padding: '6px 12px', fontSize: '0.75rem', fontWeight: 700, borderRadius: '4px', cursor: exitApplying === t ? 'wait' : 'pointer', background: '#0088ff', color: '#fff', border: 'none' }}
                                                >
                                                    {exitApplying === t ? 'APLICANDO...' : `APLICAR ${bestPol} (mejor)`}
                                                </button>
                                                : bestPol
                                                    ? <span style={{ fontSize: '0.7rem', color: '#888' }} title="Comparación no decidible con esta muestra — esperar a n≥30 trades simulados">⏳ datos insuficientes (n={ev.n}/30)</span>
                                                    : <span style={{ fontSize: '0.7rem', color: '#888' }}>la config viva ya es la mejor</span>}
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
                    Simulación conservadora (SL prioritario dentro de la vela M5). "Puro" = sin parcial, sin trail, sin BE — todo al TP2 o SL. Si REAL pierde contra PURO de forma sostenida, los gadgets de salida están cortando ganadores y hay que re-tunear los genes (lo propone el optimizador, lo validás vos acá).
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
                                        <button onClick={() => toggleRollover(t, 'A', !st.A)} style={{ padding: '4px 8px', fontSize: '0.7rem', borderRadius: '4px', cursor: 'pointer', background: st.A ? '#111' : '#333', color: st.A ? '#00e676' : '#999', border: '1px solid #333' }}>
                                            A {st.A ? 'ON' : 'OFF'}
                                        </button>
                                        <button onClick={() => toggleRollover(t, 'D', !st.D)} style={{ padding: '4px 8px', fontSize: '0.7rem', borderRadius: '4px', cursor: 'pointer', background: st.D ? '#111' : '#333', color: st.D ? '#00e676' : '#999', border: '1px solid #333' }}>
                                            D {st.D ? 'ON' : 'OFF'}
                                        </button>
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
