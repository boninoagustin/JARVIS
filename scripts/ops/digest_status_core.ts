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
/** Evidence that the weekly selection actually evaluated the pool (not silently skipped). */
export function summarizeSelection(summary: unknown): { line: string; complete: boolean; warning: string | null } {
  const s = (summary ?? {}) as { status?: string; counts?: Record<string, number> };
  const c = s.counts ?? {};
  const evaluated = Number(c.evaluated) || 0;
  const skipped = Number(c.skipped) || 0;
  const failed = Number(c.failed) || 0;
  const line = `🔬 Selección semanal: ${evaluated} evaluados · ${skipped} omitidos · ${failed} fallidos (${s.status || 'sin resumen'})`;
  if (s.status === 'failed' || failed > 0) {
    return { line, complete: false, warning: `Selección con ${failed} fallido(s) o estado ${s.status}` };
  }
  if (evaluated === 0 && skipped > 0) {
    return { line, complete: false, warning: `Selección sin evaluaciones reales (${skipped} omitidos) — posible regresión de frescura` };
  }
  return { line, complete: true, warning: null };
}
