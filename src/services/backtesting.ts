import { executeToolByName } from '../mcp/router.js';
import { db } from '../db/memory.js';
import { processTradingAlert } from '../db/trading.js';

let pollingInterval: NodeJS.Timeout | null = null;
let isBacktesting = false;
let currentSessionId: string | null = null;
let currentSessionThresholds: { buy: number; sell: number } | null = null;
let currentSessionEndDateMs: number | null = null;
let isReplaying = false;
let replayAbortController: AbortController | null = null;

interface LogEntry { ts: number; line: string; tf: string; }

export async function startBacktesting(ticker: string, startDate: string, configNote?: string, minBuyPoints?: number, minSellPoints?: number, endDate?: string) {
    if (isBacktesting) {
        await stopBacktesting();
    }

    currentSessionId = `BT_${Date.now()}`;
    currentSessionThresholds = { buy: minBuyPoints || 5, sell: minSellPoints || 5 };
    currentSessionEndDateMs = endDate ? new Date(endDate).getTime() : null;
    
    console.log(`[BACKTESTING] Starting session ${currentSessionId} for ${ticker} from ${startDate} to ${endDate || 'now'}. Thresholds: B:${currentSessionThresholds.buy} S:${currentSessionThresholds.sell}`);
    isBacktesting = true;

    try {
        // ... (existing code)
        console.log('[BACKTESTING] Launching/Verifying TradingView with CDP...');
        const launchResult = await executeToolByName('tv_launch', { kill_existing: false });
        console.log('[BACKTESTING] tv_launch result:', launchResult);
        
        // Wait a bit for TV to be ready
        await new Promise(r => setTimeout(r, 5000));

        // 1. Set symbol
        console.log(`[BACKTESTING] Setting symbol to ${ticker}...`);
        await executeToolByName('chart_set_symbol', { symbol: ticker });
        
        // 2. Set timeframe to 3M
        console.log('[BACKTESTING] Setting timeframe to 3...');
        await executeToolByName('chart_set_timeframe', { timeframe: '3' });

        // 3. Start replay at date
        console.log(`[BACKTESTING] Starting replay at ${startDate}...`);
        await executeToolByName('replay_start', { date: startDate });

        // Wait for indicator and chart to fully load before autoplay
        console.log('[BACKTESTING] Waiting 10s for indicator to load...');
        await new Promise(r => setTimeout(r, 10000));

        // 4. Update status in DB
        if (db) {
            await db.collection('app_settings').doc('backtesting_status').set({
                active: true,
                ticker,
                startDate,
                endDate: endDate || null,
                sessionId: currentSessionId,
                configNote,
                minBuyPoints: currentSessionThresholds.buy,
                minSellPoints: currentSessionThresholds.sell,
                lastUpdate: Date.now()
            });

            // Registrar la sesión en una colección histórica
            await db.collection('backtesting_sessions').doc(currentSessionId).set({
                id: currentSessionId,
                ticker,
                startDate,
                endDate: endDate || null,
                configNote,
                minBuyPoints: currentSessionThresholds.buy,
                minSellPoints: currentSessionThresholds.sell,
                timestamp: Date.now(),
                status: 'running'
            });
        }

        // 5. Start polling console EARLY to catch initial SYNC_ZONES
        console.log('[BACKTESTING] Starting polling to catch initial SYNC_ZONES...');
        startPolling();
        
        // Wait 4 seconds for the initial sync to be processed by Jarvis before moving the market
        await new Promise(r => setTimeout(r, 4000));

        // 6. Start autoplay at 1x
        console.log('[BACKTESTING] Starting autoplay...');
        await executeToolByName('replay_autoplay', { speed: 1000 });

        return { success: true };
    } catch (err: any) {
        console.error('[BACKTESTING] Error starting:', err.message);
        isBacktesting = false;
        currentSessionId = null;
        return { success: false, error: err.message };
    }
}

export async function stopBacktesting() {
    console.log(`[BACKTESTING] Stopping session ${currentSessionId}`);
    
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }

    // 🆕 Detener replay de logs si está activo
    if (isReplaying && replayAbortController) {
        replayAbortController.abort();
        isReplaying = false;
        replayAbortController = null;
    }

    try {
        try {
            await executeToolByName('replay_stop', {});
        } catch (e) {
            console.log('[BACKTESTING] replay_stop skipped or failed:', e);
        }
        
        if (db) {
            // Siempre reseteamos el estado general, sin importar si había ID en memoria
            await db.collection('app_settings').doc('backtesting_status').set({
                active: false,
                replaying: false,
                lastUpdate: Date.now()
            }, { merge: true });

            if (currentSessionId) {
                await db.collection('backtesting_sessions').doc(currentSessionId).set({
                    status: 'completed',
                    endTime: Date.now()
                }, { merge: true });
            }
        }
        
        isBacktesting = false;
        // Keep currentSessionId for a moment to let polling finish if needed, or null it
        // currentSessionId = null; 
        
        return { success: true };
    } catch (err: any) {
        console.error('[BACKTESTING] Error stopping:', err.message);
        return { success: false, error: err.message };
    }
}

export function getCurrentSessionId() {
    return currentSessionId;
}

export function getCurrentSessionThresholds() {
    return currentSessionThresholds;
}

export function getIsReplaying() {
    return isReplaying;
}

// =========================================================================
// 🆕 v5.1: REPLAY DE LOGS MULTI-TF (Backtesting Offline sin plan de pago TV)
// =========================================================================
// Flujo: Usuario corre Bar Replay en 3M, 15M, 1H, 4H por separado,
// descarga los logs de Pine Editor, los sube a JARVIS-OS.
// Jarvis los intercala por timestamp y procesa en orden cronológico.
// =========================================================================
export async function replayUploadedLogs(
    logs: Map<string, string[]>,
    ticker: string,
    configNote?: string,
    minBuyPoints?: number,
    minSellPoints?: number,
    speedMs: number = 1000
) {
    if (isBacktesting || isReplaying) {
        await stopBacktesting();
    }

    isReplaying = true;
    replayAbortController = new AbortController();
    const signal = replayAbortController.signal;

    currentSessionId = `BT_REPLAY_${Date.now()}`;
    currentSessionThresholds = { buy: minBuyPoints || 5, sell: minSellPoints || 5 };

    console.log(`[REPLAY] Starting session ${currentSessionId} for ${ticker}. ${logs.size} TFs loaded. Speed: ${speedMs}ms.`);

    // 1. Parsear todas las líneas con timestamp de los 4 archivos
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

    // 2. Ordenar CRONOLÓGICAMENTE (intercalando todos los TFs)
    allEntries.sort((a, b) => a.ts - b.ts);

    console.log(`[REPLAY] ${allEntries.length} eventos totales de ${logs.size} temporalidades.`);
    console.log(`[REPLAY] Rango: ${new Date(allEntries[0]?.ts || 0).toISOString()} → ${new Date(allEntries[allEntries.length - 1]?.ts || 0).toISOString()}`);

    // 3. Registrar sesión en DB
    if (db) {
        await db.collection('app_settings').doc('backtesting_status').set({
            active: false, // no es backtesting en vivo con TV
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
            startDate: new Date(allEntries[0]?.ts || Date.now()).toISOString().split('T')[0],
            endDate: new Date(allEntries[allEntries.length - 1]?.ts || Date.now()).toISOString().split('T')[0],
            configNote: configNote || `Replay multi-TF (${logs.size} TFs)`,
            minBuyPoints: currentSessionThresholds.buy,
            minSellPoints: currentSessionThresholds.sell,
            timestamp: Date.now(),
            status: 'running',
            mode: 'replay',
            totalEvents: allEntries.length
        });
    }

    try {
        // 4. Reproducir en orden cronológico, respetando gaps temporales
        let lastTs = allEntries[0]?.ts || 0;
        let processed = 0;
        let skippedNoTs = 0;
        const startWallClock = Date.now();

        for (const entry of allEntries) {
            if (signal.aborted) {
                console.log(`[REPLAY] Aborted by user at event ${processed}/${allEntries.length}`);
                break;
            }

            if (entry.ts === 0) {
                skippedNoTs++;
                continue;
            }

            // Respetar gap temporal (comprimido por speedMs)
            const gap = entry.ts - lastTs;
            if (gap > 0 && gap < 86400000) { // solo esperar gaps < 24h
                const waitMs = Math.min(gap / speedMs, 5000); // cap a 5s máximo
                if (waitMs > 10) {
                    await new Promise(r => setTimeout(r, waitMs));
                }
            }

            // Enviar al motor de trading como si viniera de Firebase
            await processTradingAlert(entry.line);

            lastTs = entry.ts;
            processed++;

            // Log cada 100 eventos
            if (processed % 100 === 0) {
                const elapsed = Date.now() - startWallClock;
                const rate = Math.round(processed / (elapsed / 1000));
                console.log(`[REPLAY] Progreso: ${processed}/${allEntries.length} (${rate} ev/s) | Último TS: ${new Date(entry.ts).toISOString()}`);
            }
        }

        const totalTime = Date.now() - startWallClock;
        console.log(`[REPLAY] ✅ Completado: ${processed} eventos en ${(totalTime / 1000).toFixed(1)}s (${skippedNoTs} sin TS ignorados).`);

        // 5. Actualizar sesión como completada
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

        return { success: true, processed, skippedNoTs, totalEvents: allEntries.length };

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

// 🆕 v5.1: Lee los logs guardados en Firestore y lanza el replay
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
                    console.log(`[REPLAY] ✓ ${tf}: ${data.lines.length} líneas cargadas`);
                }
            } else {
                console.log(`[REPLAY] ✗ ${tf}: sin datos (no se subió este TF)`);
            }
        } catch (e: any) {
            console.log(`[REPLAY] ✗ ${tf}: error al cargar (${e.message})`);
        }
    }

    if (logs.size === 0) {
        return { success: false, error: 'No se encontraron logs en Firestore para esta sesión' };
    }

    return replayUploadedLogs(logs, ticker, configNote, minBuyPoints, minSellPoints);
}

function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    
    let lastSeenLogs: string[] = [];

    pollingInterval = setInterval(async () => {
        if (!isBacktesting) return;

        try {
            // Get console output (assuming it returns a string with multiple lines)
            // We need to find the indicator name. The user mentioned smc_master_5.1
            const consoleOutput = await executeToolByName('pine_get_console', { study_filter: 'SMC_Master_5.1' });
            
            if (!consoleOutput || consoleOutput.startsWith('Error')) return;

            let parsed;
            try {
                parsed = JSON.parse(consoleOutput);
            } catch (e: any) {
                // If it's not JSON, it might just be empty text
                return;
            }

            if (!parsed.success || !parsed.entries) return;

            const logs = parsed.entries.map((e: any) => e.message);
            
            for (const line of logs) {
                if (!lastSeenLogs.includes(line)) {
                    console.log(`[BACKTESTING] New log detected: ${line}`);
                    await processTradingAlert(line);
                    lastSeenLogs.push(line);
                    
                    if (currentSessionEndDateMs) {
                        const tsMatch = line.match(/TS:\s*([0-9]+)/i);
                        if (tsMatch) {
                            const tsMs = parseInt(tsMatch[1], 10);
                            if (tsMs >= currentSessionEndDateMs) {
                                console.log(`[BACKTESTING] End date reached (${new Date(tsMs).toISOString()}). Stopping backtesting.`);
                                stopBacktesting(); // Non-blocking to let interval clear itself safely
                                break;
                            }
                        }
                    }
                }
            }

            // Keep cache reasonable
            if (lastSeenLogs.length > 100) {
                lastSeenLogs = lastSeenLogs.slice(-50);
            }

        } catch (err: any) {
            console.error('[BACKTESTING] Polling error:', err.message);
        }
    }, 2000); // Poll every 2 seconds
}
