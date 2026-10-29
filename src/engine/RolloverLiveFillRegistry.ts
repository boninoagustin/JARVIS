/** In-process fill boundary only. No service imports, timers or IO on import. */
export interface RolloverVerifiedFillEvent {
    tradeId: string; ticker: string; positionId: string; nowMs: number;
    /** Scoped authoritative broker lookup, invoked only by an opted-in observer. */
    readPosition(): Promise<unknown>;
}
type FillObserver = (event: RolloverVerifiedFillEvent) => Promise<void>;
let observer: FillObserver | undefined;
export function setRolloverLiveFillObserver(next: FillObserver | undefined): void { observer = next; }
export async function notifyRolloverVerifiedFill(event: RolloverVerifiedFillEvent): Promise<void> {
    await observer?.(event);
}
