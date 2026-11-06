/**
 * H07 (auditoría 2026-11-05): un documento de `detection_health` sólo es consumible si
 * tiene fecha y es reciente. Sin esto las propuestas (roster/allocator/shutdown) podían
 * decidir sobre un health de hace semanas y la cadena quedaba "verde" con datos viejos.
 */
export const HEALTH_MAX_AGE_MS = 8 * 864e5;

export function isHealthFresh(
    h: { evaluatedAt?: unknown } | null | undefined,
    nowMs: number = Date.now(),
    maxAgeMs: number = HEALTH_MAX_AGE_MS,
): boolean {
    const t = typeof h?.evaluatedAt === 'string' ? Date.parse(h.evaluatedAt) : NaN;
    if (!Number.isFinite(t)) return false;
    if (t > nowMs + 60_000) return false;          // fecha futura = dato inválido
    return nowMs - t <= maxAgeMs;
}
