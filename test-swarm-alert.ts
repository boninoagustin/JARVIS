import { analyzeInvestmentSwarm } from './src/services/investment.js';
import { evaluateWithKronos } from './src/services/kronos.js';

async function main() {
    console.log("Generando reporte para BTCUSD BUY...");
    
    let kronosResult = { trend: null, isConfirmed: false, details: 'Simulación de Kronos' };
    try {
        kronosResult = await evaluateWithKronos('BTCUSD', 'BUY');
    } catch(e) {}

    let kronosAnnotation = '';
    if (kronosResult.trend === null) {
        kronosAnnotation = `\n\n🤖 *Kronos AI:* ${kronosResult.details}`;
    } else {
        const icon = kronosResult.isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA';
        kronosAnnotation = `\n\n🤖 *Kronos AI:* ${icon}\n${kronosResult.details}`;
    }

    const swarmResult = await analyzeInvestmentSwarm('BTCUSD', 'BUY', 1000);

    const confluenceReport = `🗺️ *Contexto Macro:*\n🟢 4H: BUY\n🟢 1H: BUY\n⚪ 15M: NEUTRAL\n🟢 Gatillo 5M: BUY\n\n`;

    let msg = `🔥 *ALERTA FRANCOTIRADOR A+ | BTCUSD | COMPRA*\n\n`;
    msg += confluenceReport;
    msg += `🎯 *Puntaje Total:* 8 Puntos\n`;
    msg += `🧱 *Confluencias Apiladas:* RECHAZO_OB, MANIPULACION_ASIA + CHoCH_5M\n\n`;
    msg += `🧠 *Análisis de Jarvis:* Gatillo en 5M activado con alineación brutal. Tocamos zonas pesadas y barrieron liquidez. Probabilidad altísima. Operar con riesgo estándar.`;
    msg += kronosAnnotation;

    msg += `\n\n👔 *Comité de Inversión (Swarm):*\n${swarmResult}`;

    console.log("\n================ ALERTA DE TELEGRAM ================\n");
    console.log(msg);
    console.log("\n====================================================\n");
}

main().catch(console.error);
