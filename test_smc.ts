import { SMCEngine } from './src/engine/smc/SMCEngine.js';
import { OHLCV } from './src/engine/smc/types.js';

console.log("=== INICIANDO PRUEBA UNITARIA DEL MOTOR SMC ===");

// 1. Crear el motor
const engine = new SMCEngine('Forex - 3. Balanceado');

// 2. Crear datos de prueba (Velas OHLCV)
// Haremos una tendencia alcista, luego un pequeño pullback, 
// luego un rompimiento fuerte hacia arriba (BOS + OB + FVG)
let timestamp = 1700000000000;
const candles: OHLCV[] = [];

function addCandle(open: number, high: number, low: number, close: number, volume: number) {
    candles.push({ timestamp, open, high, low, close, volume });
    timestamp += 60000; // 1 minuto
}

// Tendencia Alcista inicial (Velas 1 a 6)
addCandle(1.000, 1.010, 0.995, 1.008, 100);
addCandle(1.008, 1.015, 1.005, 1.013, 110);
addCandle(1.013, 1.020, 1.010, 1.018, 120);
addCandle(1.018, 1.025, 1.015, 1.022, 115); // Swing High Potencial
addCandle(1.022, 1.028, 1.020, 1.025, 105); 
addCandle(1.025, 1.030, 1.022, 1.028, 110);

// Pullback bajista (Velas 7 a 12) para confirmar el Pivot High anterior
addCandle(1.028, 1.030, 1.015, 1.018, 90); 
addCandle(1.018, 1.020, 1.010, 1.012, 85);
addCandle(1.012, 1.015, 1.005, 1.008, 95); 
addCandle(1.008, 1.010, 1.000, 1.002, 100); // Swing Low Potencial
addCandle(1.002, 1.005, 0.998, 1.000, 90);
addCandle(1.000, 1.008, 0.999, 1.005, 95);

// Desplazamiento alcista fuerte (Velas 13 a 17) para confirmar el Pivot Low y romper estructura
addCandle(1.005, 1.015, 1.002, 1.012, 150); // Empieza el impulso
addCandle(1.012, 1.025, 1.010, 1.022, 200); 
addCandle(1.022, 1.040, 1.020, 1.038, 300); // Vela fuerte de desplazamiento (Rompe el máximo 1.030 -> BOS)
addCandle(1.038, 1.045, 1.035, 1.040, 250); // Sigue subiendo, deja FVG
addCandle(1.040, 1.050, 1.038, 1.048, 200); 

// Extra velas para asentar
for(let i=0; i<5; i++) {
    addCandle(1.048, 1.050, 1.045, 1.049, 100);
}

// 3. Procesar las velas en el motor e imprimir resultados
console.log(`Procesando ${candles.length} velas...`);

candles.forEach((candle, index) => {
    const events = engine.nextCandle(candle);
    
    if (events.length > 0) {
        console.log(`\n[Vela ${index + 1}] Eventos disparados:`);
        events.forEach(evt => {
            if (evt.type === 'EVENT_BOS') {
                console.log(` ✅ BOS Detectado: ${evt.direction} en precio ${evt.price.toFixed(4)}`);
            } else if (evt.type === 'EVENT_OB_CREATED') {
                console.log(` 🧱 Order Block Detectado: ${evt.ob.direction} | Rango: ${evt.ob.bottom.toFixed(4)} - ${evt.ob.top.toFixed(4)} | Score: ${evt.ob.score}`);
            } else if (evt.type === 'EVENT_SWEEP') {
                console.log(` 🧹 Sweep de liquidez: ${evt.direction} tipo ${evt.sweepType} en precio ${evt.price.toFixed(4)}`);
            }
        });
    }
});

// 4. Imprimir estado final matemático
const state = engine.getState();
console.log("\n=== ESTADO FINAL DEL MOTOR ===");
console.log(`Tendencia Actual: ${state.currentTrend}`);
console.log(`Pivots Altos detectados: ${state.pivotsHigh.length}`);
console.log(`Pivots Bajos detectados: ${state.pivotsLow.length}`);
console.log(`Order Blocks activos (Soportes/Resistencias): ${state.activeOBs.length}`);
console.log(`FVGs (Imbalances) activos: ${state.activeFVGs.length}`);

console.log("\nPrueba completada con éxito. ✔️");
