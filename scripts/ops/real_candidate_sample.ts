// Read-only screening evidence, not authorization to switch an account to real money.
export function closedVerifiedSample(rows: Array<{ id: string; data(): any }>, now: number, accountId?: string) {
  const byTicker = new Map<string, { n: number; wins: number }>();
  const seen = new Set<string>();
  for (const doc of rows) {
    const x = doc.data();
    if (!x || x.isBacktest || ['backtesting', 'backtest', 'simulation'].includes(x.mode) || x.duplicateOf) continue;
    if (x.ctraderStatus !== 'EXECUTED' || x.riskAccountingStatus !== 'VERIFIED') continue;
    if (x.executionIncidentPending || x.closeAccountingPending) continue;
    if (!['WIN', 'LOSS', 'BREAKEVEN'].includes(x.result) || typeof x.rMultiple !== 'number' || !Number.isFinite(x.rMultiple)) continue;
    const closed = typeof x.closedAt === 'number' ? x.closedAt : Date.parse(x.closedAt || '');
    if (!Number.isFinite(closed) || closed > now || closed < now - 21 * 864e5) continue;
    if (accountId && x.ctraderAccountId != null && String(x.ctraderAccountId) !== accountId) continue;
    const ticker = typeof x.ticker === 'string' ? x.ticker.toUpperCase() : '';
    if (!ticker || !x.ctraderPositionId) continue;
    const key = `${x.ctraderAccountId ?? accountId ?? 'unknown'}:${x.ctraderPositionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = byTicker.get(ticker) || { n: 0, wins: 0 };
    v.n++; if (x.result === 'WIN') v.wins++;
    byTicker.set(ticker, v);
  }
  return byTicker;
}
export function candidateEnabled(cfg: any): boolean {
  return cfg?.enabled === true && !String(cfg.disabledReason || '').trim();
}
