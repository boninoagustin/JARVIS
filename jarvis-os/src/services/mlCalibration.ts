export interface MLPartitionProgress {
    accepted: number;
    required?: number;
    missing: number;
    wins: number;
    losses: number;
}
export interface MLCandidateMetrics {
    n: number; pnlR: number; wr: number; pf: number | null; mdd: number;
}
export interface MLThresholdTrial {
    threshold: number;
    metrics: MLCandidateMetrics;
    eligible: boolean;
    reason?: string;
}
export interface MLCandidateComparison {
    schemaVersion: 2;
    status: string;
    ticker: string;
    candidateSha256: string;
    candidate: string;
    evaluatedAt: number;
    selectedThreshold: number | null;
    calibration: {
        fromMs: number; toMs: number; baseline: MLCandidateMetrics;
        runs: MLThresholdTrial[]; selectedMode: 'off' | 'gate'; selectedThreshold: number | null; selectionMade?: boolean;
    };
    validation: {
        fromMs: number; toMs: number; baseline?: MLCandidateMetrics;
        selected?: MLCandidateMetrics | null; deltaR?: number | null;
    };
    recommendation: string;
    reason: string;
    scope: string;
}
export interface MLCalibrationStatus {
    state: string;
    trade?: boolean;
    ready: boolean;
    bootstrapRequired?: boolean;
    train?: MLPartitionProgress;
    calibration?: MLPartitionProgress;
    validation?: MLPartitionProgress;
    reason?: string;
    updatedAt?: number;
    job?: { state: string; reason?: string; candidate?: string };
    candidate?: { path: string; sha256: string };
    comparison?: MLCandidateComparison;
}
export const ML_THRESHOLDS = [0.50, 0.65, 0.80] as const;
export function validMLMetrics(m?: MLCandidateMetrics | null): m is MLCandidateMetrics {
    return !!m && Number.isInteger(m.n) && m.n >= 0
        && [m.pnlR, m.wr, m.mdd].every(Number.isFinite) && m.wr >= 0 && m.wr <= 100
        && m.mdd >= 0 && (m.pf === null || (Number.isFinite(m.pf) && m.pf >= 0));
}
/** Never reinterpret old fixed-threshold or mismatched-candidate results as this protocol. */
export function currentMLComparison(status: MLCalibrationStatus | undefined, ticker: string): MLCandidateComparison | null {
    const c = status?.comparison, identity = status?.candidate;
    if (!c || c.schemaVersion !== 2 || !['valid', 'insufficient'].includes(c.status) || c.ticker !== ticker
        || c.scope !== 'temporal_threshold_holdout' || !identity
        || !/^[a-f0-9]{64}$/.test(c.candidateSha256) || identity.sha256 !== c.candidateSha256
        || identity.path !== c.candidate || !Number.isFinite(c.evaluatedAt)) return null;
    const a = c.calibration, v = c.validation;
    if (!a || !v || ![a.fromMs, a.toMs, v.fromMs, v.toMs].every(Number.isFinite)
        || !(a.fromMs < a.toMs && a.toMs <= v.fromMs && v.fromMs < v.toMs)
        || !validMLMetrics(a.baseline) || !Array.isArray(a.runs) || a.runs.length !== 3
        || ML_THRESHOLDS.some(t => a.runs.filter(r => r.threshold === t).length !== 1)
        || a.runs.some(r => !validMLMetrics(r.metrics) || typeof r.eligible !== 'boolean' || (r.eligible && r.metrics.n < 20))) return null;
    const winner = a.baseline.n >= 20 ? a.runs.filter(r => r.eligible && r.metrics.pnlR > a.baseline.pnlR)
        .sort((x, y) => y.metrics.pnlR - x.metrics.pnlR || Math.abs(x.threshold - .65) - Math.abs(y.threshold - .65) || x.threshold - y.threshold)[0] : undefined;
    if ((winner?.threshold ?? null) !== a.selectedThreshold || (winner ? 'gate' : 'off') !== a.selectedMode
        || (a.selectionMade === false && a.baseline.n >= 20)) return null;
    if (a.selectedMode === 'off') {
        if (a.selectedThreshold !== null || c.selectedThreshold !== null || v.selected != null || v.deltaR != null) return null;
    } else if (a.selectedMode === 'gate') {
        const winner = a.runs.find(r => r.threshold === a.selectedThreshold);
        if (!winner?.eligible || winner.metrics.n < 20 || a.baseline.n < 20
            || winner.metrics.pnlR <= a.baseline.pnlR || c.selectedThreshold !== a.selectedThreshold) return null;
        if (v.selected != null) {
            if (!validMLMetrics(v.baseline) || !validMLMetrics(v.selected) || !Number.isFinite(v.deltaR)
                || Math.abs(v.deltaR! - (v.selected.pnlR - v.baseline.pnlR)) > 1e-6) return null;
        }
    } else return null;
    if (v.baseline != null && !validMLMetrics(v.baseline)) return null;
    if (c.status === 'valid' && (a.baseline.n < 20 || a.selectionMade === false || !validMLMetrics(v.baseline) || v.baseline.n < 30
        || (a.selectedMode === 'gate' && (!validMLMetrics(v.selected) || v.selected.n < 30)))) return null;
    return c;
}
/** Three disjoint partitions; runtime loading alone requires fifty Train samples. */
export function canRecalibrateML(status: MLCalibrationStatus | undefined): boolean {
    const valid = (p: MLPartitionProgress | undefined, minimum: number) => !!p && Number.isInteger(p.accepted)
        && p.accepted >= Math.max(minimum, p.required ?? minimum) && p.missing === 0
        && Number.isInteger(p.wins) && Number.isInteger(p.losses)
        && p.wins > 0 && p.losses > 0 && p.wins + p.losses === p.accepted;
    return status?.ready === true && valid(status.train, 50) && valid(status.calibration, 20) && valid(status.validation, 30)
        && !['queued', 'running', 'comparing'].includes((status.job?.state ?? '').toLowerCase());
}
