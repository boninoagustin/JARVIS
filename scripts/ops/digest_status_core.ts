/** systemd oneshot states: activating is running; ExecCondition skip is not a failure. */
export function digestJobState(result: string, active: string): 'running' | 'failed' | 'skipped' | 'finished' {
  if (active === 'active' || active === 'activating' || active === 'deactivating') return 'running';
  if (active === 'failed') return 'failed';
  if (result === 'exec-condition') return 'skipped';
  if (result === 'success') return 'finished';
  return 'failed';
}
export function validateTelegramResponse(httpOk: boolean, payload: unknown): void {
  if (!httpOk || !payload || typeof payload !== 'object' || (payload as { ok?: boolean }).ok !== true) {
    throw new Error('Telegram did not confirm delivery (HTTP or API failure)');
  }
}
