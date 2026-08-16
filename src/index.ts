import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// Polyfill global fetch BEFORE anything else
import nodeFetch from 'node-fetch';
// @ts-ignore
global.fetch = nodeFetch;

import { bot } from './bot/telegram.js';
import { db } from './db/memory.js';
import { startScreenshotWorker } from './utils/screenshot_worker.js';
import { startCleanupTimer } from './db/cleanup.js';

console.log('[SYSTEM] --- FINAL CLEAN START (Hybrid Cloud Mode) ---');

// 🛡️ Global error handlers: evitar que errores de red (ECONNRESET de cTrader TLS)
// maten al proceso. Sin esto, cada desconexión temporal destruye todo el estado SMC
// acumulado (scores, legs, zonas) y PM2 reinicia desde cero.
process.on('uncaughtException', (err: Error) => {
    console.error(`[SYSTEM] ⚠️ Uncaught Exception (proceso NO muere): ${err.message}`);
    if (err.stack) console.error(err.stack);
});
process.on('unhandledRejection', (reason: any) => {
    console.error(`[SYSTEM] ⚠️ Unhandled Rejection (proceso NO muere):`, reason?.message || reason);
});

async function main() {
    console.log('[DEBUG] Memory check (Firebase)...');

    // Iniciar worker de screenshots y limpieza
    startScreenshotWorker();
    startCleanupTimer();

    // Inicializar WebSocket Server para la Interfaz Jarvis-OS
    import('./services/ws_server.js').then(({ initWebSocketServer }) => {
        initWebSocketServer(8081);
    }).catch(err => console.error('[WS] Error inicializando WebSocket:', err));

    if (!db) {
        console.error('[FATAL] Firebase is disabled or missing credentials. Hybrid Cloud Mode needs Firebase to receive messages.');
        console.warn('[WARN] Sin Firebase. Operando con defaults.');
    }

    try {
        console.log('[TELEGRAM] Fetching bot info...');
        await bot.init();
        console.log(`[SYSTEM] JARVIS is online as @${bot.botInfo.username}`);

        console.log('[TELEGRAM] Starting Firebase Queue Listener...');
        const unsubscribers: (() => void)[] = [];
        
        const cleanupAndExit = () => {
            console.log('[SHUTDOWN] Limpiando listeners de index.ts...');
            unsubscribers.forEach(unsub => unsub());
            process.exit(0);
        };
        process.on('SIGTERM', cleanupAndExit);
        process.on('SIGINT', cleanupAndExit);
        
        // Emular start()
        console.log('[SYSTEM] --- QUEUE LISTENER ESTABLISHED. Ready for messages ---');

        // Long polling directo a Telegram (sin webhook ni proxy Vercel)
        bot.start({
            onStart: () => console.log('[TELEGRAM] Long polling activo (directo a api.telegram.org)'),
        }).catch((err: any) => console.error('[TELEGRAM] Long polling error:', err.message));

        unsubscribers.push(db.collection('telegram_incoming')
            .where('status', '==', 'pending')
            .onSnapshot(async (snapshot: any) => {
                for (const change of snapshot.docChanges()) {
                    if (change.type === 'added') {
                        const docId = change.doc.id;
                        const update = change.doc.data().update;
                        
                        try {
                            // Procesar la actualizacion a traves de Grammy
                            await bot.handleUpdate(update);
                            
                            // Si procesa correctamente, borrar el mensaje de la cola
                            await db?.collection('telegram_incoming').doc(docId).delete();
                        } catch (err: any) {
                            console.error('[LOCAL ERROR] Error procesando update:', err.message);
                            // Marcar como failed para no atascar la cola
                            await db?.collection('telegram_incoming').doc(docId).update({ status: 'failed' });
                        }
                    }
                }
            }, (error: any) => {
                console.error('[FIREBASE] Listener error:', error);
            }));

        // Pre-cargar trading module para activar listeners de config
        const tradingModule = await import('./db/trading.js');
        
        // 🆕 v5.1: Iniciar watchdog de desconexión TradingView
        tradingModule.startWatchdog();

        // 🔌 Pre-conectar a cTrader para eliminar latencia en la primera operación
        import('./services/ctrader.js').then(async ({ connectCTrader, getCTraderStatus, initializeScanner }) => {
            const connected = await connectCTrader();
            const status = getCTraderStatus();
            if (connected) {
                console.log(`[CTRADER] 🟢 Pre-conectado al inicio. Modo: ${status.demo ? 'DEMO' : 'LIVE'}`);
                // Iniciar el escáner SMC de todos los activos y temporalidades en background
                initializeScanner().catch(err => console.error('[CTRADER] Error en initializeScanner:', err));
                // 🌉 Fase 1: conectar el motor SMC nativo con JARVIS (reemplaza alertas de TradingView)
                import('./engine/smc/SMCBridge.js').then(({ initSMCBridge }) =>
                    initSMCBridge().catch(err => console.error('[SMC-BRIDGE] Error iniciando bridge:', err))
                ).catch(err => console.error('[SMC-BRIDGE] Error importando bridge:', err));
            } else if (status.configured) {
                console.warn(`[CTRADER] ⚠️ Configurado pero no se pudo conectar al inicio. Se reintentará en la primera operación.`);
            } else {
                console.log(`[CTRADER] ⏭️ No configurado. Servicio deshabilitado.`);
            }
        }).catch(err => {
            console.warn(`[CTRADER] ⚠️ Error en pre-conexión (no crítico):`, err.message);
        });
        


        console.log('[APP] Resetting backtesting status...');
        await db.collection('app_settings').doc('backtesting_status').set({
            active: false,
            lastUpdate: Date.now()
        }, { merge: true });

        console.log('[APP] Starting Command Listener...');
        unsubscribers.push(db.collection('app_commands')
            .where('status', '==', 'pending')
            .onSnapshot(async (snapshot: any) => {
                for (const change of snapshot.docChanges()) {
                    if (change.type === 'added') {
                        const docId = change.doc.id;
                        const { command, params } = change.doc.data();
                        
                        try {
                            console.log(`[COMMAND] Received: ${command}`);
                            if (command === 'replay_backtesting') {
                                const { replayBacktestingFromFirestore } = await import('./services/backtesting.js');
                                await replayBacktestingFromFirestore(params.sessionId, params.ticker, params.configNote, params.minBuyPoints, params.minSellPoints);
                            } else if (command === 'stop_replay') {
                                const { stopReplay } = await import('./services/backtesting.js');
                                await stopReplay();
                            }
                            
                            await db?.collection('app_commands').doc(docId).delete();
                        } catch (err: any) {
                            console.error(`[COMMAND ERROR] ${command}:`, err.message);
                            await db?.collection('app_commands').doc(docId).update({ status: 'failed' });
                        }
                    }
                }
            }));

        // 📊 Resumen diario unificado — se ejecuta desde trading.ts (scheduleDailySummary a las 18:00 ART)
        // El resumen nocturno (22:00 ART) fue eliminado para evitar mensajes duplicados.
        console.log(`[JOURNAL] Daily summary is handled by trading.ts watchdog at 18:00 ART.`);

        // Finnhub Fundamentals Update
        const fetchFundamentals = async () => {
            try {
                const { updateFundamentals } = await import('./services/finnhub.js');
                await updateFundamentals();
            } catch (e: any) {
                console.error('[FINNHUB] Error updating fundamentals:', e.message);
            }
        };
        
        // Execute immediately, then every 15 minutes (900,000 ms)
        fetchFundamentals();
        setInterval(fetchFundamentals, 900_000);
        console.log(`[FINNHUB] Fundamentals update scheduled every 15 minutes.`);

        // 🧠 Motor Auto-Tune (Fase 2)
        const runAutoTuneScheduler = async () => {
            try {
                const { checkAndRunAutoTune } = await import('./services/autotune.js');
                await checkAndRunAutoTune();
            } catch (e: any) {
                console.error('[AUTO-TUNE] Error scheduling autotune:', e.message);
            }
        };
        // Revisar cada 24 horas (86400000 ms)
        setInterval(runAutoTuneScheduler, 86_400_000);
        // También revisar al iniciar
        setTimeout(runAutoTuneScheduler, 10_000);

        // 💓 Heartbeat de Firebase (Evita desconexiones silenciosas de onSnapshot)
        let lastSnapshotReceivedAt = Date.now();
        
        unsubscribers.push(
            db.collection('app_settings').doc('heartbeat').onSnapshot(() => {
                lastSnapshotReceivedAt = Date.now();
            }, (err: any) => {
                console.error('[FIREBASE] Heartbeat snapshot error:', err);
            })
        );

        let heartbeatFailCount = 0;
        setInterval(() => {
            if (db) {
                db.collection('app_settings').doc('heartbeat').set({
                    lastPing: Date.now(),
                    status: 'online'
                }).catch((err: any) => {
                    heartbeatFailCount++;
                    console.error(`[HEARTBEAT] ❌ Fallo al escribir heartbeat (x${heartbeatFailCount}):`, err?.message ?? err);
                });
            }
            
            // Watchdog: si no recibimos el snapshot del heartbeat en 5 minutos, la conexión gRPC es un zombie.
            if (Date.now() - lastSnapshotReceivedAt > 300_000) {
                console.error('[FIREBASE] 🚨 Zombie connection detected (no heartbeat snapshot in 5m)! Restarting process...');
                process.exit(1); // PM2 lo reiniciará automáticamente
            }
        }, 120_000); // 2 minutos
        console.log(`[FIREBASE] Heartbeat y Watchdog configurados cada 2 min.`);

    } catch (err: any) {
        console.warn(`[TELEGRAM/TRADING] Failed to start listener: ${err.message}`);
    }

    // 🏥 Healthcheck HTTP endpoint (monitoreo local y UptimeRobot)
    // 🔧 Usa SO_REUSEADDR para evitar EADDRINUSE tras reinicios del sistema
    import('http').then(({ createServer }) => {
        const server = createServer((_req, res) => {
            const now = Date.now();
            const status = {
                online: true,
                uptime: Math.round(process.uptime()),
                activeTrades: 0, // se actualiza abajo
                lastPing: 0,
            };
            // Import dinámico para leer estado desde trading module
            import('./db/trading.js').then(tm => {
                status.activeTrades = (tm as any).getActiveTradeCount?.() ?? 0;
                status.lastPing = (tm as any).getLastPingTime?.() ?? 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status));
            }).catch(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status));
            });
        });

        let healthRetries = 0;
        const MAX_HEALTH_RETRIES = 3;

        server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                if (healthRetries < MAX_HEALTH_RETRIES) {
                    healthRetries++;
                    console.warn(`[HEALTH] ⚠️ Port 3691 in use — retry ${healthRetries}/${MAX_HEALTH_RETRIES} in 5s...`);
                    setTimeout(() => {
                        server.close();
                        server.listen({ port: 3691, reuseAddr: true });
                    }, 5000);
                } else {
                    console.warn(`[HEALTH] ⚠️ Port 3691 busy after ${MAX_HEALTH_RETRIES} retries. Healthcheck DISABLED (non-critical).`);
                }
            } else {
                console.error(`[HEALTH] ❌ Server error:`, err.message);
            }
        });

        server.listen({ port: 3691, reuseAddr: true }, () => {
            console.log('[HEALTH] HTTP server on port 3691');
        });
    });
}

main();
