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

async function main() {
    console.log('[DEBUG] Memory check (Firebase)...');

    // Iniciar worker de screenshots y limpieza
    startScreenshotWorker();
    startCleanupTimer();

    if (!db) {
        console.error('[FATAL] Firebase is disabled or missing credentials. Hybrid Cloud Mode needs Firebase to receive messages.');
        process.exit(1);
    }

    try {
        console.log('[TELEGRAM] Fetching bot info via Vercel proxy...');
        await bot.init();
        console.log(`[SYSTEM] JARVIS is online as @${bot.botInfo.username}`);

        console.log('[TELEGRAM] Starting Firebase Queue Listener...');
        
        // Emular start()
        console.log('[SYSTEM] --- QUEUE LISTENER ESTABLISHED. Ready for messages ---');

        db.collection('telegram_incoming')
            .where('status', '==', 'pending')
            .onSnapshot(async (snapshot) => {
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
            }, (error) => {
                console.error('[FIREBASE] Listener error:', error);
            });

        // Pre-cargar trading module para activar listeners de config
        const tradingModule = await import('./db/trading.js');
        
        // 🆕 v5.1: Iniciar watchdog de desconexión TradingView
        tradingModule.startWatchdog();
        
        console.log('[TRADING] Starting Firebase Queue Listener...');
        db.collection('trading_incoming')
            .where('status', '==', 'pending')
            .onSnapshot(async (snapshot) => {
                for (const change of snapshot.docChanges()) {
                    if (change.type === 'added') {
                        const docId = change.doc.id;
                        const alertText = change.doc.data().alertText;
                        
                        try {
                            const { processTradingAlert } = await import('./db/trading.js');
                            await processTradingAlert(alertText);
                            
                            // Si procesa correctamente, borrar el mensaje de la cola
                            await db?.collection('trading_incoming').doc(docId).delete();
                        } catch (err: any) {
                            console.error('[LOCAL TRADING ERROR] Error procesando update:', err.message);
                            // Marcar como failed para no atascar la cola
                            await db?.collection('trading_incoming').doc(docId).update({ status: 'failed' });
                        }
                    }
                }
            }, (error) => {
                console.error('[FIREBASE TRADING] Listener error:', error);
            });

        console.log('[APP] Resetting backtesting status...');
        await db.collection('app_settings').doc('backtesting_status').set({
            active: false,
            lastUpdate: Date.now()
        }, { merge: true });

        console.log('[APP] Starting Command Listener...');
        db.collection('app_commands')
            .where('status', '==', 'pending')
            .onSnapshot(async (snapshot) => {
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
            });

        // Daily Journal Review — sends at 22:00 Argentina time
        const REVIEW_HOUR = 22; // 10 PM
        let lastReviewDate = '';
        setInterval(async () => {
            const now = new Date();
            const argTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
            const todayStr = argTime.toISOString().split('T')[0];
            
            if (argTime.getHours() === REVIEW_HOUR && lastReviewDate !== todayStr) {
                lastReviewDate = todayStr;
                try {
                    const { sendDailyReview } = await import('./services/journal.js');
                    await sendDailyReview();
                    console.log('[JOURNAL] Daily review sent.');
                } catch (e: any) {
                    console.error('[JOURNAL] Daily review error:', e.message);
                }
            }
        }, 60_000); // Check every minute
        console.log(`[JOURNAL] Daily review scheduled at ${REVIEW_HOUR}:00 (Argentina time).`);

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
