/** TimesFM contrafactual A/B: verificación as-of + cobertura del caché de forecasts.
 *
 * Para validar TimesFM honestamente, cada forecast debe poder probar que se generó SIN
 * ver datos posteriores a su vela (as-of). La clave es availableAt (o computedAt) ≤ ts.
 * Los forecasts históricos actuales (forecasts_m5.jsonl) NO llevan availableAt/computedAt,
 * por lo que esta auditoría falla cerrado hasta que se regenere un caché denso y as-of.
 *
 * Sin I/O de Firestore, sin broker, sin escribir config. Sólo lectura + verificación.
 */
import fs from 'node:fs';

export const MIN_TIMESFM_FORECASTS = 30;

export interface AsOfResult { ok: boolean; reason?: string }
/** Forecast as-of: la fecha en que estuvo disponible no puede ser posterior a su vela. */
export function verifyTimesfmAsOf(fc: any): AsOfResult {
  const ts = fc?.ts;
  if (!Number.isSafeInteger(ts) || ts <= 0) return { ok: false, reason: 'ts inválido' };
  const asOf = fc?.availableAt ?? fc?.computedAt;
  if (!Number.isSafeInteger(asOf) || asOf <= 0) return { ok: false, reason: 'sin availableAt/computedAt (as-of no verificable)' };
  if (asOf > ts) return { ok: false, reason: `availableAt (${asOf}) > ts (${ts}) → look-ahead` };
  if (!Array.isArray(fc.q50) || !Array.isArray(fc.q90) || !Array.isArray(fc.q10)
      || fc.q50.length === 0 || fc.q90.length === 0 || fc.q10.length === 0) {
    return { ok: false, reason: 'cuantiles de forecast faltantes' };
  }
  return { ok: true };
}

export interface CacheAudit {
  ok: boolean;
  total: number;
  valid: number;
  reasons: string[];
  /** fracción de triggers cubiertos por un forecast as-of (0..1) */
  coverage: number;
}
/** Audita un caché JSONL de forecasts contra los ts de triggers esperados. */
export function auditTimesfmCache(cachePath: string, triggerTsList: number[]): CacheAudit {
  const forecasts: any[] = [];
  if (fs.existsSync(cachePath)) {
    for (const line of fs.readFileSync(cachePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { forecasts.push(JSON.parse(line)); } catch { /* línea corrupta: skip */ }
    }
  }
  const reasons: string[] = [];
  let valid = 0;
  const validTs = new Set<number>();
  for (const fc of forecasts) {
    const r = verifyTimesfmAsOf(fc);
    if (r.ok) { valid++; validTs.add(fc.ts); } else reasons.push(r.reason!);
  }
  if (valid < MIN_TIMESFM_FORECASTS) reasons.push(`cobertura insuficiente: ${valid}/${MIN_TIMESFM_FORECASTS} forecasts as-of válidos`);
  const covered = triggerTsList.filter(t => validTs.has(t)).length;
  const coverage = triggerTsList.length ? covered / triggerTsList.length : 0;
  if (coverage < 1) reasons.push(`cobertura de triggers: ${covered}/${triggerTsList.length} con forecast as-of`);
  return { ok: reasons.length === 0, total: forecasts.length, valid, reasons, coverage };
}

/** Lee los ts de un JSONL de triggers (triggers_m5.jsonl). */
export function readTriggerTs(path: string): number[] {
  if (!fs.existsSync(path)) return [];
  const out: number[] = [];
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (Number.isSafeInteger(o.ts)) out.push(o.ts);
    } catch { /* skip */ }
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const ticker = (process.argv[2] || 'EURUSD').toUpperCase();
  const base = `/opt/JARVIS/logs/${ticker.toLowerCase()}/forecasts`;
  const triggers = readTriggerTs(`${base}/triggers_m5.jsonl`);
  const audit = auditTimesfmCache(`${base}/forecasts_m5.jsonl`, triggers);
  console.log(JSON.stringify({ ticker, triggers: triggers.length, ...audit }, null, 2));
  process.exitCode = audit.ok ? 0 : 1;
}
