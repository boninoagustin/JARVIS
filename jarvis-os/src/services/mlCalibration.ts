export interface MLPartitionProgress {
    accepted: number;
    required?: number;
    missing: number;
    wins: number;
    losses: number;
}
export interface MLCandidateMetrics {
    n: number;
    pnlR: number;
    wr: number;
    pf: number | null;
    mdd: number;
}
export interface MLCandidateComparison {
    schemaVersion: 1;
    status: string;
    ticker: string;
    candidateSha256: string;
    candidate: string;
    threshold: number;
    evaluatedAt: number;
    fromMs: number;
    toMs: number;
    baseline: MLCandidateMetrics;
    gate: MLCandidateMetrics;
    deltaR: number;
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
    validation?: MLPartitionProgress;
    reason?: string;
    updatedAt?: number;
    job?: { state: string; reason?: string; candidate?: string };
    candidate?: { path: string; sha256: string };
    comparison?: MLCandidateComparison;
}

/** Only the exact current candidate can supply the panel's return numbers. */
export function currentMLComparison(status: MLCalibrationStatus | undefined, ticker: string): MLCandidateComparison | null {
    const c = status?.comparison;
    const identity = status?.candidate;
    const metrics = (m?: MLCandidateMetrics) => !!m && Number.isInteger(m.n) && m.n >= 0
        && [m.pnlR, m.wr, m.mdd].every(Number.isFinite) && m.wr >= 0 && m.wr <= 100
        && m.mdd >= 0 && (m.pf === null || (Number.isFinite(m.pf) && m.pf >= 0));
    if (!c || c.schemaVersion !== 1 || c.status !== 'valid' || c.ticker !== ticker
        || c.scope !== 'retrospective_validation' || !identity
        || !/^[a-f0-9]{64}$/.test(c.candidateSha256) || identity.sha256 !== c.candidateSha256
        || identity.path !== c.candidate || !Number.isFinite(c.threshold) || c.threshold <= 0 || c.threshold >= 1
        || !Number.isFinite(c.fromMs) || !Number.isFinite(c.toMs) || c.fromMs >= c.toMs
        || !Number.isFinite(c.evaluatedAt) || !metrics(c.baseline) || !metrics(c.gate)
        || !Number.isFinite(c.deltaR) || Math.abs(c.deltaR - (c.gate.pnlR - c.baseline.pnlR)) > 1e-6) return null;
    return c;
}

/** Fail closed: honor the runtime's 50-train floor as well as validation. */
export function canRecalibrateML(status: MLCalibrationStatus | undefined): boolean {
    const valid = (p: MLPartitionProgress | undefined, minimum: number) => !!p && Number.isInteger(p.accepted)
        && p.accepted >= Math.max(minimum, p.required ?? minimum) && p.missing === 0
        && Number.isInteger(p.wins) && Number.isInteger(p.losses)
        && p.wins > 0 && p.losses > 0 && p.wins + p.losses === p.accepted;
    return status?.ready === true && valid(status.train, 50) && valid(status.validation, 20)
        && !['queued', 'running'].includes((status.job?.state ?? '').toLowerCase());
}
