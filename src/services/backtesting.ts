// =========================================================================
// v5.2: BACKTESTING POR LOGS MULTI-TF (Offline)
// Flujo: Usuario corre Bar Replay en TradingView en 3M/15M/1H/4H,
// descarga los logs del Pine Editor, los sube a JARVIS-OS.
// Jarvis intercala por timestamp y reproduce en orden cronológico.
// =========================================================================
import { db } from '../db/memory.js';
import { processTradingAlert } from '../db/trading.js';

let currentSessionId: string | null = null;
let currentSessionThresholds: { buy: number; sell: number } | null = null;
let isReplaying = false;
let replayAbortController: AbortController | null = null;

interface LogEntry { ts: number; line: string; tf: string; }

// =========================================================================
// REPLAY DE LOGS (núcleo del sistema)
// =========================================================================
export async function replayUploadedLogs(
    logs: Map<string, string[]>,
    ticker: string,
    configNote?: string,
    minBuyPoints?: number,
    minSellPoints?: number,
    speedMs: number = 1000
) {
    if (isReplaying) {
        await stopReplay();
    }

    isReplaying = true;
    replayAbortController = new AbortController();
    const signal = replayAbortController.signal;

    currentSessionId = `BT_${Date.now()}`;
    currentSessionThresholds = { buy: minBuyPoints || 5, sell: minSellPoints || 5 };

    console.log(`[REPLAY] Iniciando sesión ${currentSessionId} | ${ticker} | ${logs.size} TFs | Speed: ${speedMs}ms`);
    console.log(`[REPLAY] Thresholds: BUY≥${currentSessionThresholds.buy} SELL≥${currentSessionThresholds.sell}`);

    // 1. Parsear todas las líneas con timestamp de los archivos
    let allEntries: LogEntry[] = [];

    for (const [tf, lines] of logs.entries()) {
        for (const line of lines) {
            const tsMatch = line.match(/TS:\s*(\d+)/i);
            allEntries.push({
                ts: tsMatch ? parseInt(tsMatch[1], 10) : 0,
                line,
                tf
            });
        }
    }

    // 2. Ordenar CRONOLÓGICAMENTE (intercala todos los TFs)
    allEntries.sort((a, b) => a.ts - b.ts);

    const validEntries = allEntries.filter(e => e.ts > 0);
    console.log(`[REPLAY] ${validEntries.length} eventos válidos de ${allEntries.length} totales.`);
    if (validEntries.length > 0) {
        console.log(`[REPLAY] Rango: ${new Date(validEntries[0].ts).toISOString()} → ${new Date(validEntries[validEntries.length - 1].ts).toISOString()}`);
    }

    // 3. Registrar sesión en DB
    if (db) {
        await db.collection('app_settings').doc('backtesting_status').set({
            replaying: true,
            ticker,
            sessionId: currentSessionId,
            configNote,
            minBuyPoints: currentSessionThresholds.buy,
            minSellPoints: currentSessionThresholds.sell,
            lastUpdate: Date.now()
        });

        await db.collection('backtesting_sessions').doc(currentSessionId).set({
            id: currentSessionId,
            ticker,
            startDate: validEntries.length > 0 ? new Date(validEntries[0].ts).toISOString().split('T')[0] : 'N/A',
            endDate: validEntries.length > 0 ? new Date(validEntries[validEntries.length - 1].ts).toISOString().split('T')[0] : 'N/A',
            configNote: configNote || `Replay multi-TF (${logs.size} TFs)`,
            minBuyPoints: currentSessionThresholds.buy,
            minSellPoints: currentSessionThresholds.sell,
            timestamp: Date.now(),
            status: 'running',
            mode: 'replay',
            totalEvents: validEntries.length,
            tfCount: logs.size
        });
    }

    try {
        // 4. 🔮 FASE PRE-SYNC: procesar SYNC_ZONES de TODOS los TFs primero
        //    Esto arma el mapa de zonas ANTES de que lleguen los PINGs de 3M.
        //    Sin esto, Jarvis empieza sin zonas y no detecta nada las primeras horas.
        const syncEntries = validEntries.filter(e => e.line.includes('SYNC_ZONES'));
        const nonSyncEntries = validEntries.filter(e => !e.line.includes('SYNC_ZONES'));
        
        console.log(`[REPLAY] 🔮 Pre-sync: ${syncEntries.length} SYNC_ZONES a procesar primero (${nonSyncEntries.length} resto)`);
        
        // Procesar SYNC_ZONES instantáneamente (sin esperar gaps)
        for (const entry of syncEntries) {
            if (signal.aborted) break;
            await processTradingAlert(entry.line);
        }
        console.log(`[REPLAY] 🔮 Pre-sync completado. Mapa de zonas inicializado.`);

        // 5. REPRODUCIR el resto cronológicamente
        let lastTs = validEntries[0]?.ts || 0;
        let processed = syncEntries.length;
        const skippedNoTs = allEntries.length - validEntries.length;
        const startWallClock = Date.now();

        // Reordenar: los SYNC_ZONES ya procesados se saltean
        const remainingEntries = allEntries
            .filter(e => e.ts > 0 && !e.line.includes('SYNC_ZONES'))
            .sort((a, b) => a.ts - b.ts);

        for (const entry of remainingEntries) {
            if (signal.aborted) {
                console.log(`[REPLAY] ⏹ Abortado por usuario (${processed}/${validEntries.length})`);
                break;
            }

            const gap = entry.ts - lastTs;
            if (gap > 0 && gap < 86400000) {
                const waitMs = Math.min(gap / speedMs, 5000);
                if (waitMs > 10) {
                    await new Promise(r => setTimeout(r, waitMs));
                }
            }

            await processTradingAlert(entry.line);

            lastTs = entry.ts;
            processed++;

            if (processed % 100 === 0) {
                const elapsed = Date.now() - startWallClock;
                const rate = Math.round(processed / (elapsed / 1000));
                console.log(`[REPLAY] ${processed}/${validEntries.length} (${rate} ev/s) | TS: ${new Date(entry.ts).toISOString()}`);
            }
        }

        const totalTime = Date.now() - startWallClock;
        console.log(`[REPLAY] ✅ ${processed} eventos en ${(totalTime / 1000).toFixed(1)}s (${skippedNoTs} sin TS)`);

        if (db) {
            await db.collection('backtesting_sessions').doc(currentSessionId).set({
                status: 'completed',
                endTime: Date.now(),
                processedEvents: processed,
                skippedNoTs
            }, { merge: true });

            await db.collection('app_settings').doc('backtesting_status').set({
                replaying: false,
                lastUpdate: Date.now()
            }, { merge: true });
        }

        return { success: true, processed, skippedNoTs, totalEvents: validEntries.length };

    } catch (err: any) {
        console.error('[REPLAY] Error:', err.message);
        if (db) {
            await db.collection('backtesting_sessions').doc(currentSessionId).set({
                status: 'failed',
                endTime: Date.now(),
                error: err.message
            }, { merge: true });
        }
        return { success: false, error: err.message };
    } finally {
        isReplaying = false;
        replayAbortController = null;
    }
}

// =========================================================================
// CARGA DESDE FIRESTORE
// =========================================================================
export async function replayBacktestingFromFirestore(
    sessionId: string,
    ticker: string,
    configNote?: string,
    minBuyPoints?: number,
    minSellPoints?: number
) {
    if (!db) return { success: false, error: 'Firestore no disponible' };

    console.log(`[REPLAY] Cargando logs desde Firestore para sesión ${sessionId}...`);

    const logs = new Map<string, string[]>();
    const tfs = ['3', '15', '60', '240'];

    for (const tf of tfs) {
        try {
            const docSnap = await db.collection('backtesting_logs').doc(`${sessionId}_${tf}`).get();
            if (docSnap.exists) {
                const data = docSnap.data();
                if (data && Array.isArray(data.lines)) {
                    logs.set(tf, data.lines);
                    console.log(`[REPLAY] ✓ ${tf}: ${data.lines.length} líneas`);
                }
            } else {
                console.log(`[REPLAY] ✗ ${tf}: sin datos`);
            }
        } catch (e: any) {
            console.log(`[REPLAY] ✗ ${tf}: error (${e.message})`);
        }
    }

    if (logs.size === 0) {
        return { success: false, error: 'No se encontraron logs para esta sesión' };
    }

    return replayUploadedLogs(logs, ticker, configNote, minBuyPoints, minSellPoints);
}

// =========================================================================
// CONTROL
// =========================================================================
export async function stopReplay() {
    if (replayAbortController) {
        replayAbortController.abort();
        replayAbortController = null;
    }
    isReplaying = false;
    if (db) {
        await db.collection('app_settings').doc('backtesting_status').set({
            replaying: false,
            lastUpdate: Date.now()
        }, { merge: true });
        if (currentSessionId) {
            await db.collection('backtesting_sessions').doc(currentSessionId).set({
                status: 'stopped',
                endTime: Date.now()
            }, { merge: true });
        }
    }
    return { success: true };
}

export function getCurrentSessionId() { return currentSessionId; }
export function getCurrentSessionThresholds() { return currentSessionThresholds; }
export function getIsReplaying() { return isReplaying; }
