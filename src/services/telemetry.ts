// Telemetría permanente de gatillos (Plan B — ago-2026)
// Contadores EN VIVO por ticker×sesión×gatillo: embudo de señales, entradas directas,
// esperas de OTE, ejecuciones OTE y muertes OTE por filtro (los filtros hardcodeados de
// AlphaModel que el optimizador dominical NO ve).
// Flush incremental cada 10 min a Firestore `trigger_telemetry/{YYYY-MM-DD}` (merge aditivo,
// sobrevive restarts). El reporte dominical (scripts/trigger_parity_report.ts) compara
// esta realidad con el backtest del optimizador.
//
// ⚠️ IMPORTANTE: db se importa en forma PEREZOSA (dentro de flushTelemetry) porque
// AlphaModel (que importa este módulo) se re-exporta al FRONTEND (jarvis-os backtest).
// Un import estático de db/memory → firebase-admin arrastraba firebase-admin al bundle del
// navegador y rompía el dashboard (pantalla negra, ago-2026). El navegador nunca llama a
// flushTelemetry, así que el import dinámico jamás se dispara ahí.

export interface OteDeadCounts {
    chochContrario: number;
    inalcanzable: number;
    rr075: number;
    minScore: number;
    opuesta: number;
    otra: number;
}

export interface TriggerTelemetryBucket {
    signals: number;
    directEntries: number;
    oteWaits: number;
    oteExecutions: number;
    oteDead: OteDeadCounts;
}

const zeroDead = (): OteDeadCounts => ({ chochContrario: 0, inalcanzable: 0, rr075: 0, minScore: 0, opuesta: 0, otra: 0 });
const zeroBucket = (): TriggerTelemetryBucket => ({ signals: 0, directEntries: 0, oteWaits: 0, oteExecutions: 0, oteDead: zeroDead() });

// RAM = delta desde el último flush; el total del día vive en Firestore.
const counters = new Map<string, TriggerTelemetryBucket>();

function key(ticker: string, session: string, trigger: string): string {
    return `${String(ticker).toUpperCase()}|${String(session || 'UNKNOWN').toUpperCase()}|${trigger}`;
}

function bucket(k: string): TriggerTelemetryBucket {
    let b = counters.get(k);
    if (!b) { b = zeroBucket(); counters.set(k, b); }
    return b;
}

export const telemetry = {
    signal: (ticker: string, session: string, trigger: string) => { bucket(key(ticker, session, trigger)).signals++; },
    directEntry: (ticker: string, session: string, trigger: string) => { bucket(key(ticker, session, trigger)).directEntries++; },
    oteWait: (ticker: string, session: string, trigger: string) => { bucket(key(ticker, session, trigger)).oteWaits++; },
    oteExec: (ticker: string, session: string, trigger: string) => { bucket(key(ticker, session, trigger)).oteExecutions++; },
    oteDeath: (ticker: string, session: string, trigger: string, reason: keyof OteDeadCounts) => {
        const d = bucket(key(ticker, session, trigger)).oteDead;
        if (d[reason] !== undefined) d[reason]++; else d.otra++;
    },
};

export async function flushTelemetry(): Promise<void> {
    if (counters.size === 0) return;
    const day = new Date().toISOString().slice(0, 10);
    try {
        // import perezoso: ver nota al inicio del archivo (browser-safe)
        const { db } = await import('../db/memory.js');
        const ref = db.collection('trigger_telemetry').doc(day);
        const snap = await ref.get();
        const existing = (snap.exists ? snap.data() : {}) || {};
        const merged: Record<string, TriggerTelemetryBucket> = {};
        const allKeys = new Set([...Object.keys(existing), ...counters.keys()]);
        for (const k of allKeys) {
            const e: any = existing[k] || zeroBucket();
            const c = counters.get(k) || zeroBucket();
            merged[k] = {
                signals: (e.signals || 0) + c.signals,
                directEntries: (e.directEntries || 0) + c.directEntries,
                oteWaits: (e.oteWaits || 0) + c.oteWaits,
                oteExecutions: (e.oteExecutions || 0) + c.oteExecutions,
                oteDead: {
                    chochContrario: (e.oteDead?.chochContrario || 0) + c.oteDead.chochContrario,
                    inalcanzable: (e.oteDead?.inalcanzable || 0) + c.oteDead.inalcanzable,
                    rr075: (e.oteDead?.rr075 || 0) + c.oteDead.rr075,
                    minScore: (e.oteDead?.minScore || 0) + c.oteDead.minScore,
                    opuesta: (e.oteDead?.opuesta || 0) + c.oteDead.opuesta,
                    otra: (e.oteDead?.otra || 0) + c.oteDead.otra,
                },
            };
        }
        await ref.set(merged);
        counters.clear();
    } catch (e: any) {
        console.warn('[TELEMETRY] flush falló:', e.message);
    }
}

export function scheduleTelemetryFlush(): void {
    setInterval(() => { flushTelemetry().catch(() => { }); }, 10 * 60 * 1000);
    setTimeout(() => { flushTelemetry().catch(() => { }); }, 60 * 1000); // primer flush tras arrancar
    console.log('[TELEMETRY] Contadores de gatillos ACTIVOS (flush cada 10 min → trigger_telemetry).');
}
