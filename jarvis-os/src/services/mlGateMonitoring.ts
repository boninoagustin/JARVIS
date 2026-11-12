import { configFingerprint, type MLGateDeployment } from './mlGateDeployment';

/** Audit-only registration, written in the SAME transaction as a manual activation. */
export function buildMLActivationRecord(ticker: string, activationId: string, config: unknown, deployment: MLGateDeployment) {
    if (!/^[A-Z0-9]{1,24}$/.test(ticker) || !/^[A-Za-z0-9_-]{10,128}$/.test(activationId)) throw new Error('Identidad de activación inválida');
    const fingerprint = configFingerprint(config);
    if (deployment.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(deployment.modelSha256)
        || !/^[a-f0-9]{64}$/.test(deployment.evidenceId) || deployment.threshold <= 0 || deployment.threshold >= 1
        || !Number.isFinite(deployment.threshold) || !Number.isSafeInteger(deployment.evaluatedAt)
        || deployment.evaluatedAt <= 0 || deployment.configFingerprint !== fingerprint) throw new Error('Despliegue y configuración no coinciden');
    return { schemaVersion: 1, activationId, ticker, source: 'dashboard_requested', status: 'requested',
        deployment: { ...deployment }, configFingerprint: fingerprint, configSnapshot: JSON.parse(fingerprint) };
}
export interface MonitorMetrics { n: number; pnlR: number; mdd: number; wr: number; pf: number | null }
export interface MonitorWindow { fromMs: number; toMs: number; baseline: MonitorMetrics; active: MonitorMetrics; deltaR: number; status: string }
export interface ActiveAssessment {
    schemaVersion: 1; scope: string; status: string; ticker: string; activationId: string;
    modelSha256: string; threshold: number; configFingerprint: string; engineFingerprint: string;
    evaluatedAt: number; dataThroughMs?: number; dataStale?: boolean;
    windows: { cumulative: MonitorWindow; recent: MonitorWindow }; baseSignal: string; reason: string;
}
export interface MonitorRow {
    state: string; reason?: string; recommendation?: string; ticker?: string;
    activationId?: string; epochId?: string; modelSha256?: string; threshold?: number;
    requestedAtMs?: number; firstSeenMs?: number; fromMs?: number; runtimeAck?: string;
    activationConfigFingerprint?: string; currentConfigFingerprint?: string;
    assessment?: ActiveAssessment; confirmationCount?: number; lastAssessedAt?: number;
    candidateComparison?: {
        status: string; reason: string; candidateSha256?: string; threshold?: number;
        fromMs?: number; toMs?: number; baseline?: MonitorMetrics; active?: MonitorMetrics; candidate?: MonitorMetrics;
        deltaActiveR?: number; deltaCandidateR?: number;
        activeModelSha256?: string; activeEpochId?: string;
        configFingerprint?: string; engineFingerprint?: string;
        selectedAtMs?: number; firstSelectionObservedMs?: number; evaluatedAt?: number;
    };
}
const metrics = (m?: MonitorMetrics) => !!m && Number.isInteger(m.n) && m.n >= 0
    && [m.pnlR, m.mdd, m.wr].every(Number.isFinite) && m.mdd >= 0 && m.wr >= 0 && m.wr <= 100;
function windowValid(w?: MonitorWindow): boolean {
    return !!w && Number.isSafeInteger(w.fromMs) && Number.isSafeInteger(w.toMs) && w.fromMs < w.toMs
        && metrics(w.baseline) && metrics(w.active) && Number.isFinite(w.deltaR)
        && Math.abs(w.deltaR - (w.active.pnlR - w.baseline.pnlR)) < 1e-6;
}
/** Hide metrics if any current stored identity/config differs, even during refresh races. */
export interface MonitorReference { activationId?: string; enabled?: boolean }
export function currentActiveAssessment(row: MonitorRow | undefined, ticker: string, config: any, now = Date.now(), reference?: MonitorReference): ActiveAssessment | null {
    const a = row?.assessment, d = config?.mlGateDeployment;
    if (!row || row.state !== 'ASSESSED' || config?.mlGateEnabled !== true || d?.schemaVersion !== 2
        || reference?.enabled !== true || reference.activationId !== row.activationId
        || !a || a.schemaVersion !== 1 || !Number.isFinite(a.threshold) || a.threshold <= 0 || a.threshold >= 1
        || a.scope !== 'post_activation_replay' || a.status !== 'valid' || a.ticker !== ticker
        || !row.activationId || a.activationId !== row.activationId || !row.epochId
        || !/^[a-f0-9]{64}$/.test(a.configFingerprint) || !/^[a-f0-9]{64}$/.test(a.engineFingerprint)
        || !/^[a-f0-9]{64}$/.test(a.modelSha256) || a.modelSha256 !== d?.modelSha256
        || a.modelSha256 !== row.modelSha256 || a.threshold !== d?.threshold || a.threshold !== row.threshold
        || a.dataStale === true || !Number.isFinite(a.evaluatedAt) || a.evaluatedAt > now
        || now - a.evaluatedAt > 8 * 86400000 || !Number.isSafeInteger(a.dataThroughMs)
        || a.dataThroughMs! > now || now - a.dataThroughMs! > 7 * 86400000
        || !windowValid(a.windows?.cumulative) || !windowValid(a.windows?.recent)) return null;
    try {
        const f = configFingerprint(config);
        if (row.activationConfigFingerprint !== f || row.currentConfigFingerprint !== f) return null;
    } catch { return null; }
    if (!Number.isSafeInteger(row.fromMs) || a.windows.cumulative.fromMs < row.fromMs!
        || a.windows.recent.fromMs < a.windows.cumulative.fromMs || a.windows.recent.toMs !== a.windows.cumulative.toMs) return null;
    return a;
}
export function currentCandidateForwardComparison(row: MonitorRow | undefined, assessment: ActiveAssessment | null, candidateSha: string | undefined, now = Date.now()) {
    const c = row?.candidateComparison;
    if (!assessment || !row || !c || !['valid', 'insufficient'].includes(c.status)
        || !candidateSha || c.candidateSha256 !== candidateSha || !/^[a-f0-9]{64}$/.test(candidateSha)
        || c.activeModelSha256 !== assessment.modelSha256 || c.activeEpochId !== row.epochId
        || c.configFingerprint !== assessment.configFingerprint || c.engineFingerprint !== assessment.engineFingerprint
        || !Number.isSafeInteger(c.fromMs) || !Number.isSafeInteger(c.toMs) || c.fromMs! >= c.toMs!
        || c.fromMs! < assessment.windows.cumulative.fromMs || c.toMs! !== assessment.windows.cumulative.toMs
        || !Number.isSafeInteger(c.firstSelectionObservedMs) || c.firstSelectionObservedMs! > c.fromMs!
        || !Number.isSafeInteger(c.selectedAtMs) || c.selectedAtMs! > c.fromMs!
        || !Number.isFinite(c.evaluatedAt) || c.evaluatedAt! > now || now - c.evaluatedAt! > 8 * 86400000
        || !Number.isFinite(c.threshold) || c.threshold! <= 0 || c.threshold! >= 1
        || !metrics(c.baseline) || !metrics(c.active) || !metrics(c.candidate)
        || !Number.isFinite(c.deltaActiveR) || !Number.isFinite(c.deltaCandidateR)
        || Math.abs(c.deltaActiveR! - (c.active!.pnlR - c.baseline!.pnlR)) > 1e-6
        || Math.abs(c.deltaCandidateR! - (c.candidate!.pnlR - c.baseline!.pnlR)) > 1e-6
        || (c.status === 'valid' && [c.baseline!, c.active!, c.candidate!].some(m => m.n < 30))) return null;
    return c;
}
export function monitorRecommendation(row: MonitorRow, assessment: ActiveAssessment | null): string {
    if (!assessment) return row.state === 'INACTIVE' ? 'Gate apagado' : 'Sin recomendación de rendimiento';
    const enough = Object.values(assessment.windows).every(w => w.status === 'sufficient' && w.baseline.n >= 30 && w.active.n >= 30);
    if (!enough) return 'Datos insuficientes';
    const windows = Object.values(assessment.windows);
    if (row.recommendation === 'RECOMMEND_DISABLE' && assessment.baseSignal === 'DISABLE_SIGNAL' && (row.confirmationCount ?? 0) >= 2
        && windows.every(w => w.deltaR <= -5 && w.active.mdd > w.baseline.mdd + 2)) return 'Recomendar apagar — requiere decisión manual';
    if (row.recommendation === 'RECOMMEND_RECALIBRATE' && assessment.baseSignal === 'RECALIBRATE_SIGNAL' && (row.confirmationCount ?? 0) >= 2
        && windows.every(w => w.deltaR <= -2)) return 'Recomendar recalibrar';
    if (row.recommendation === 'MAINTAIN' && assessment.baseSignal === 'MAINTAIN'
        && windows.every(w => w.deltaR > 0 && w.active.mdd <= w.baseline.mdd * 1.25 + 1)) return 'Mantener';
    if (row.recommendation === 'OBSERVE_PENDING_CONFIRMATION') return 'Observar: deterioro pendiente de confirmación semanal';
    return 'Seguir observando';
}
