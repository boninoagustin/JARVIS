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
        
        // 3. (Mock) Bucle de Optimización por Sesión y Activo
        const assets = ['US100', 'XAUUSD'];
        const sessions = ['LONDON', 'NY', 'ASIA'];

        for (const asset of assets) {
            console.log(`\n🔎 Analizando Activo: ${asset}`);
            for (const session of sessions) {
                console.log(`   🔸 Optimizando sesión: ${session}`);
                // Aquí implementaremos la búsqueda en el espacio de parámetros (Grid Search o Algoritmo Genético)
                // - SL Buffer
                // - TP2 Target
                // - Min Score
                // - Max Loss
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
