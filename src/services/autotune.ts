import admin from 'firebase-admin';

// ---------------------------------------------------------
// JARVIS-OS: Auto-Tune Engine (Fase 2 - Machine Learning Roadmap)
// ---------------------------------------------------------
// Este motor está diseñado para correr cada 15/30 días.
// Extrae el historial reciente (e.g. 45 días) de Firebase y aplica
// algoritmos de optimización para encontrar los mejores parámetros
// (SL_buffer, minScore, gatillos) por sesión y por activo, sin
// caer en el sobre-ajuste (overfitting).
// ---------------------------------------------------------

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
        // 2. Extraer el historial de la base de datos
        // NOTA: Para una simulación real necesitamos no solo el trade_journal,
        // sino todas las alertas (trading_incoming o radar_states) para probar 
        // qué hubiera pasado si el límite de score fuera más bajo o más alto.
        
        console.log("⏳ Descargando datos de Firestore...");
        
        const journalSnap = await db.collection('trade_journal')
            .where('timestamp', '>=', startDateMs)
            .get();
            
        console.log(`✅ Se encontraron ${journalSnap.size} operaciones en el historial de ${windowDays} días.`);
        
        // TODO: Extraer las señales en bruto (raw signals) si se guardan, 
        // para simular combinaciones que no fueron ejecutadas originalmente.
        
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
        const assetConfigs: Record<string, any> = {};
        
        for (const [ticker, assetTrades] of Object.entries(tradesByTicker)) {
            console.log(`\n🔎 Analizando Activo: ${ticker} con ${assetTrades.length} operaciones`);
            
            // Separar por dirección
            const buys = assetTrades.filter(t => t.direction === 'BUY');
            const sells = assetTrades.filter(t => t.direction === 'SELL');
            
            const optimalBuyPoints = optimizeMinScore(buys);
            const optimalSellPoints = optimizeMinScore(sells);
            
            console.log(`   🔸 Optimal minPointsForBuy: ${optimalBuyPoints}`);
            console.log(`   🔸 Optimal minPointsForSell: ${optimalSellPoints}`);
            
            // Analizar por sesión
            const sessions: Record<string, any> = {};
            const tradesBySession: Record<string, any[]> = {};
            assetTrades.forEach(t => {
                const s = t.session || 'UNKNOWN';
                if (!tradesBySession[s]) tradesBySession[s] = [];
                tradesBySession[s].push(t);
            });

            for (const [session, sessionTrades] of Object.entries(tradesBySession)) {
                if (session === 'UNKNOWN') continue;
                
                // Calcular racha de perdidas
                const maxBuyLosses = optimizeConsecutiveLosses(sessionTrades.filter(t => t.direction === 'BUY'));
                const maxSellLosses = optimizeConsecutiveLosses(sessionTrades.filter(t => t.direction === 'SELL'));
                
                console.log(`   🔹 Sesión ${session} -> maxBuyLosses: ${maxBuyLosses || 'KEE'}, maxSellLosses: ${maxSellLosses || 'KEEP'}`);
                
                sessions[session] = {};
                if (maxBuyLosses !== undefined) sessions[session].maxBuyLosses = maxBuyLosses;
                if (maxSellLosses !== undefined) sessions[session].maxSellLosses = maxSellLosses;
            }
            
            assetConfigs[ticker] = {
                minPointsForBuy: optimalBuyPoints,
                minPointsForSell: optimalSellPoints,
                sessions: Object.keys(sessions).length > 0 ? sessions : undefined
            };
        }
        
        // 5. Escribir configuraciones optimizadas
        console.log("\n💾 Escribiendo nuevas configuraciones en Firestore...");
        for (const [ticker, config] of Object.entries(assetConfigs)) {
            // Eliminamos undefined del objeto base para no pisar si está vacío
            const cleanConfig = Object.fromEntries(Object.entries(config).filter(([_, v]) => v !== undefined));
            if (Object.keys(cleanConfig).length > 0) {
                await db.collection('asset_configs').doc(ticker).set(cleanConfig, { merge: true });
            }
        }
        
        console.log("\n✅ AUTO-TUNE FINALIZADO CON ÉXITO.");
        console.log("Próximamente: Escritura de la nueva configuración en Firebase (app_settings/bot_config)");
        
    } catch (error) {
        console.error("❌ Error en Auto-Tune:", error);
    }
}

import { fileURLToPath } from 'url';
import fs from 'fs';

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
    const serviceAccount = JSON.parse(fs.readFileSync(new URL('../../firebase-key.json', import.meta.url), 'utf8'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    
    runAutoTune().then(() => process.exit(0));
}

// ---------------------------------------------------------
// FUNCIONES AUXILIARES DE OPTIMIZACIÓN
// ---------------------------------------------------------
function optimizeMinScore(trades: any[]) {
    // Buscar umbral ampliado entre 3 y 8
    let bestScore = 5; // Default
    let bestPnL = -Infinity;
    let bestWinRate = 0;
    
    for (const testScore of [3, 4, 5, 6, 7, 8]) {
        const filtered = trades.filter(t => t.points >= testScore);
        if (filtered.length < 3) continue; // Muestra muy chica
        
        const winRate = filtered.filter(t => t.result === 'WIN').length / filtered.length;
        
        // Calculamos PnL. Si no hay pnl guardado, estimamos con un R:R base de 2:1
        const pnl = filtered.reduce((sum, t) => sum + (t.pnl !== undefined ? t.pnl : (t.result === 'WIN' ? 2 : -1)), 0);
        
        // Criterio de Sensibilidad Refinada tras 15 días:
        // Preferimos PnL absoluto, pero en caso de empate buscamos mayor Win Rate.
        // Se reduce el filtro de Win Rate a 40% para dar lugar a estrategias de alto R:R (e.g. OTE)
        if (winRate >= 0.40) {
            if (pnl > bestPnL || (pnl === bestPnL && winRate > bestWinRate)) {
                bestPnL = pnl;
                bestWinRate = winRate;
                bestScore = testScore;
            }
        }
    }
    
    return bestPnL !== -Infinity ? bestScore : 5;
}

function optimizeConsecutiveLosses(trades: any[]) {
    const wins = trades.filter(t => t.result === 'WIN').length;
    const total = trades.length;
    if (total < 5) return undefined; // No tocar
    const winRate = wins / total;
    if (winRate < 0.4) return 2;
    if (winRate > 0.6) return 3;
    return undefined; // Dejar la configuración que estaba
}
