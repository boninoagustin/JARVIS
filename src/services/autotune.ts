import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import fs from 'fs';

// ---------------------------------------------------------
// JARVIS-OS: Auto-Tune Engine (Fase 2 - Machine Learning Roadmap)
// ---------------------------------------------------------
// Este motor está diseñado para correr cada 15/30 días.
// Extrae el historial reciente (e.g. 45 días) de Firebase y aplica
// algoritmos de optimización para encontrar los mejores parámetros.
// Ahora funciona en modo "Recomendación" guardando reportes
// para ser aprobados en JARVIS-OS.
// ---------------------------------------------------------

interface MetricSet {
    score: number;
    pnl: number;
    winRate: number;
    tradeCount: number;
    profitFactor: number;
    maxDrawdown: number;
    expectancy: number;
}

interface OptimizeScoreResult {
    old: MetricSet;
    new: MetricSet;
}

interface OptimizeLossesResult {
    oldLimit: number | undefined;
    newLimit: number | undefined;
    winRate: number;
}

function identifyTrigger(trade: any): string {
    const isChoch = trade.isChochEntry || false;
    const events = trade.events || [];
    const tf = trade.tf ? trade.tf.toLowerCase() : '5m';
    const isOte = events.some((e: string) => e.includes('OTE'));
    const isBos = events.some((e: string) => e.includes('BOS'));
    
    if (!isChoch && !isBos) return 'unknown';

    if (isOte) {
        if (isChoch) return `oteChoch${tf}`;
        if (isBos) return `oteBos${tf}`;
    } else {
        if (isChoch) return `choch${tf}`;
        if (isBos) return `bos${tf}`;
    }
    
    return 'unknown';
}

export async function runAutoTune() {
    console.log("=========================================");
    console.log("🤖 INICIANDO JARVIS AUTO-TUNE ENGINE");
    console.log("=========================================");

    if (!admin.apps.length) {
        console.error("Firebase no está inicializado. Saliendo...");
        return;
    }

    const db = admin.firestore();
    
    // 1. Definir la ventana de tiempo (ej. últimos 45 días)
    const windowDays = 45;
    const now = Date.now();
    const startDateMs = now - (windowDays * 24 * 60 * 60 * 1000);
    
    console.log(`📅 Ventana de análisis: Últimos ${windowDays} días`);

    try {
        console.log("⏳ Descargando datos de Firestore...");
        
        // Cargar config actual
        const configsSnap = await db.collection('asset_configs').get();
        const currentConfigs: Record<string, any> = {};
        configsSnap.forEach(doc => {
            currentConfigs[doc.id] = doc.data();
        });

        const journalSnap = await db.collection('trade_journal')
            .where('timestamp', '>=', startDateMs)
            .get();
            
        console.log(`✅ Se encontraron ${journalSnap.size} operaciones en el historial de ${windowDays} días.`);
        
        // 3. Agrupar trades por Activo
        const tradesByTicker: Record<string, any[]> = {};
        journalSnap.forEach(doc => {
            const data = doc.data();
            if (data.mode !== 'backtesting' && data.result) { // Solo trades reales cerrados
                if (!tradesByTicker[data.ticker]) tradesByTicker[data.ticker] = [];
                tradesByTicker[data.ticker].push(data);
            }
        });

        // 4. Bucle de Optimización por Activo
        const reports: Record<string, any> = {};
        
        for (const [ticker, assetTrades] of Object.entries(tradesByTicker)) {
            console.log(`\n🔎 Analizando Activo: ${ticker} con ${assetTrades.length} operaciones`);
            const currentConfig = currentConfigs[ticker] || {};
            
            const sessionReports: Record<string, any> = {};
            const tradesBySession: Record<string, any[]> = {};
            
            // Agrupar por sesión
            assetTrades.forEach(t => {
                const s = t.session || 'UNKNOWN';
                if (s === 'UNKNOWN') return;
                if (!tradesBySession[s]) tradesBySession[s] = [];
                tradesBySession[s].push(t);
            });

            for (const [session, sessionTrades] of Object.entries(tradesBySession)) {
                const oldSessionConf = currentConfig.sessions?.[session] || {};
                const sessionData: any = {};
                
                // 1. Optimizar Filtros Anti-Bias (Losses) a nivel sesión
                const buyLossesResult = optimizeConsecutiveLosses(sessionTrades.filter(t => t.direction === 'BUY'), oldSessionConf.maxBuyLosses);
                const sellLossesResult = optimizeConsecutiveLosses(sessionTrades.filter(t => t.direction === 'SELL'), oldSessionConf.maxSellLosses);
                
                if (buyLossesResult.newLimit !== undefined || sellLossesResult.newLimit !== undefined || oldSessionConf.maxBuyLosses || oldSessionConf.maxSellLosses) {
                    sessionData.limits = {
                        buyLosses: buyLossesResult,
                        sellLosses: sellLossesResult
                    };
                }

                // 2. Agrupar trades de la sesión por gatillo (setup)
                const tradesByTrigger: Record<string, any[]> = {};
                sessionTrades.forEach(t => {
                    const triggerKey = identifyTrigger(t);
                    if (triggerKey === 'unknown') return;
                    if (!tradesByTrigger[triggerKey]) tradesByTrigger[triggerKey] = [];
                    tradesByTrigger[triggerKey].push(t);
                });

                // 3. Optimizar Score Mínimo por gatillo y dirección
                const triggersData: Record<string, any> = {};
                for (const [trigger, triggerTrades] of Object.entries(tradesByTrigger)) {
                    const triggerConf = oldSessionConf[trigger] || {};
                    const oldBuyScore = triggerConf.minScoreBuy ?? triggerConf.minScore ?? currentConfig.minPointsForBuy ?? 5;
                    const oldSellScore = triggerConf.minScoreSell ?? triggerConf.minScore ?? currentConfig.minPointsForSell ?? 5;

                    const buys = triggerTrades.filter(t => t.direction === 'BUY');
                    const sells = triggerTrades.filter(t => t.direction === 'SELL');
                    
                    const buyResult = optimizeMinScore(buys, oldBuyScore);
                    const sellResult = optimizeMinScore(sells, oldSellScore);

                    // Guardamos si hay datos relevantes (al menos se simuló algo válido)
                    if (buyResult.new.tradeCount >= 3 || sellResult.new.tradeCount >= 3) {
                        triggersData[trigger] = {
                            buy: buyResult,
                            sell: sellResult
                        };
                        
                        console.log(`   🔸 [${session}][${trigger}] Buy Score: ${oldBuyScore} -> ${buyResult.new.score} (PnL: ${buyResult.new.pnl})`);
                        console.log(`   🔸 [${session}][${trigger}] Sell Score: ${oldSellScore} -> ${sellResult.new.score} (PnL: ${sellResult.new.pnl})`);
                    }
                }

                if (Object.keys(triggersData).length > 0) {
                    sessionData.triggers = triggersData;
                }

                if (Object.keys(sessionData).length > 0) {
                    sessionReports[session] = sessionData;
                }
            }
            
            reports[ticker] = {
                timestamp: Date.now(),
                ticker: ticker,
                sessions: Object.keys(sessionReports).length > 0 ? sessionReports : undefined
            };
        }
        
        // 5. Escribir reportes de optimización para ser revisados
        console.log("\n💾 Escribiendo reportes de recomendación en Firestore (autotune_reports)...");
        for (const [ticker, report] of Object.entries(reports)) {
            // Eliminamos undefined del objeto base para no pisar si está vacío
            const cleanReport = JSON.parse(JSON.stringify(report)); // quick deep clean of undefined
            await db.collection('autotune_reports').doc(ticker).set(cleanReport);
        }
        
        console.log("\n✅ AUTO-TUNE FINALIZADO CON ÉXITO.");
        console.log("Los reportes están listos para ser revisados y aprobados en JARVIS-OS.");
        
    } catch (error) {
        console.error("❌ Error en Auto-Tune:", error);
    }
}

// ---------------------------------------------------------
// FUNCIONES DE AGENDAMIENTO PARA EL INDEX
// ---------------------------------------------------------
export async function checkAndRunAutoTune() {
    if (!admin.apps.length) return;
    const db = admin.firestore();
    try {
        const docRef = db.collection('app_settings').doc('autotune_status');
        const docSnap = await docRef.get();
        const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        
        let lastRun = 0;
        if (docSnap.exists) {
            lastRun = docSnap.data()?.lastRun || 0;
        }

        if (now - lastRun >= FIFTEEN_DAYS_MS) {
            console.log('[AUTO-TUNE] Han pasado 15 días. Iniciando optimización automática...');
            // Registramos de antemano para evitar colisiones si hay mútiples workers
            await docRef.set({ lastRun: now, status: 'running' }, { merge: true });
            
            await runAutoTune();
            
            await docRef.set({ status: 'idle', lastRun: Date.now() }, { merge: true });
            console.log('[AUTO-TUNE] Finalizado. Próxima corrida en 15 días.');
        } else {
            const nextRunDays = ((lastRun + FIFTEEN_DAYS_MS - now) / (1000 * 60 * 60 * 24)).toFixed(1);
            console.log(`[AUTO-TUNE] Próxima optimización automática programada en ${nextRunDays} días.`);
        }
    } catch (err: any) {
        console.error('[AUTO-TUNE] Error revisando el agendador:', err.message);
    }
}

// Permitir ejecutar el script directamente desde la consola
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    // Inicializar firebase localmente para pruebas si se corre suelto
    const serviceAccount = JSON.parse(fs.readFileSync(new URL('../../service-account.json', import.meta.url), 'utf8'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    
    runAutoTune().then(() => process.exit(0));
}

// ---------------------------------------------------------
// FUNCIONES AUXILIARES DE OPTIMIZACIÓN
// ---------------------------------------------------------
function getMetricsForScore(trades: any[], score: number): MetricSet {
    const filtered = trades.filter(t => t.points >= score);
    if (filtered.length === 0) return { score, pnl: 0, winRate: 0, tradeCount: 0, profitFactor: 0, maxDrawdown: 0, expectancy: 0 };
    
    // Ordenar cronológicamente para el Max Drawdown
    filtered.sort((a, b) => a.timestamp - b.timestamp);

    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    
    let runningPnL = 0;
    let peakPnL = 0;
    let maxDrawdown = 0;

    for (const t of filtered) {
        const tradePnL = t.pnl !== undefined ? t.pnl : (t.result === 'WIN' ? 2 : -1);
        runningPnL += tradePnL;
        
        if (runningPnL > peakPnL) peakPnL = runningPnL;
        const currentDrawdown = peakPnL - runningPnL;
        if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

        if (tradePnL > 0) {
            wins++;
            grossProfit += tradePnL;
        } else {
            losses++;
            grossLoss += Math.abs(tradePnL);
        }
    }

    const tradeCount = filtered.length;
    const winRate = wins / tradeCount;
    const pnl = runningPnL;
    const profitFactor = grossLoss === 0 ? grossProfit : grossProfit / grossLoss;
    const expectancy = pnl / tradeCount;

    return { 
        score,
        pnl: Number(pnl.toFixed(2)), 
        winRate, 
        tradeCount, 
        profitFactor: Number(profitFactor.toFixed(2)), 
        maxDrawdown: Number(maxDrawdown.toFixed(2)), 
        expectancy: Number(expectancy.toFixed(2)) 
    };
}

function optimizeMinScore(trades: any[], currentScore: number): OptimizeScoreResult {
    const oldMetrics = getMetricsForScore(trades, currentScore);

    let bestMetrics = oldMetrics;
    
    for (const testScore of [3, 4, 5, 6, 7, 8]) {
        const testMetrics = getMetricsForScore(trades, testScore);
        
        // Filtramos resultados estadísticamente irrelevantes o malos
        if (testMetrics.tradeCount < 3) continue;
        
        if (testMetrics.winRate >= 0.40) {
            if (testMetrics.pnl > bestMetrics.pnl || (testMetrics.pnl === bestMetrics.pnl && testMetrics.winRate > bestMetrics.winRate)) {
                bestMetrics = testMetrics;
            }
        }
    }
    
    return {
        old: oldMetrics,
        new: bestMetrics
    };
}

function optimizeConsecutiveLosses(trades: any[], currentLimit: number | undefined): OptimizeLossesResult {
    const wins = trades.filter(t => t.result === 'WIN').length;
    const total = trades.length;
    const winRate = total > 0 ? wins / total : 0;
    
    let newLimit = currentLimit;
    if (total >= 5) {
        if (winRate < 0.4) newLimit = 2;
        else if (winRate > 0.6) newLimit = 3;
    }
    
    return {
        oldLimit: currentLimit,
        newLimit,
        winRate
    };
}
