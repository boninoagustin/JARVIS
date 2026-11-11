export interface MLPartitionProgress {
    accepted: number;
    required?: number;
    missing: number;
    wins: number;
    losses: number;
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
    job?: { state: string; reason?: string };
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
