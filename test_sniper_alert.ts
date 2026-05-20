/**
 * Test script: Simulates sending a FRANCOTIRADOR (Sniper) alert to Telegram.
 * This replicates the exact message format from trading.ts triggerOte block.
 */
import { config } from './src/config.js';
import { Bot } from 'grammy';

const testBot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    client: {
        buildUrl: (root, token, method) => {
            const proxyUrl = 'https://jarvis-seven-kappa.vercel.app/api/proxy';
            return `${proxyUrl}?method=${method}`;
        }
    }
});

async function main() {
    // Simulate FRANCOTIRADOR alert message (same format as trading.ts lines 1441-1459)
    const ticker = 'BTCUSD';
    const direction = 'SELL';
    const dirText = '🔴 SELL';
    const points = 22;
    const events = ['💎_GOD_ZONE_4H', '🎯_Silver_Bullet_1H', 'OB_Gold_15'];
    const entryPrice = 76550;
    const stopLoss = '77362.29';
    const tp1 = '76874.55';
    const tp2 = '76545.43';

    const confluenceReport = `📊 <b>Reporte de Confluencia:</b>\n` +
        `• Zona GOD 4H: TOP=77200 BTM=76400\n` +
        `• Silver Bullet 1H: TOP=76900 BTM=76600\n` +
        `• OB Gold 15m: TOP=76700 BTM=76500\n\n`;

    let msg = `🔥 <b>ALERTA FRANCOTIRADOR OTE | ${ticker} | ${dirText}</b>\n\n`;
    msg += confluenceReport;
    msg += `🎯 <b>Puntaje Total:</b> ${points} Puntos\n`;
    msg += `🧱 <b>Confluencias:</b> ${events.join(', ')}\n\n`;
    msg += `🧠 <b>Jarvis:</b> Llegada a zona OTE confirmada. Operar con riesgo estándar (1%).\n\n`;
    msg += `📐 <b>Niveles de Ejecución (GATILLO):</b>\n`;
    msg += `🎯 Precio de Entrada: OTE Actual\n`;
    msg += `🛑 Stop Loss Sugerido: ${stopLoss}\n`;
    msg += `💰 Take Profit 1 (Interno): ${tp1}\n`;
    msg += `🚀 Take Profit 2 (Externo): ${tp2}\n`;

    // Simulate Kronos annotation
    msg += `\n\n🤖 <b>Kronos AI:</b> 🟢 CONFIRMADO\n🔮 Predicción promedio a 20 velas: 76200.50 (BEARISH)`;

    console.log(`[TEST] Mensaje FRANCOTIRADOR (${msg.length} chars)`);
    console.log(`[TEST] Enviando a ${config.TELEGRAM_ALLOWED_USER_IDS.length} usuario(s): [${config.TELEGRAM_ALLOWED_USER_IDS.join(', ')}]`);
    console.log('---');
    console.log(msg);
    console.log('---');

    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            console.log(`[TEST] Enviando HTML a userId=${userId}...`);
            await testBot.api.sendMessage(userId, msg, { parse_mode: 'HTML' });
            console.log(`[TEST] ✅ Enviado exitosamente a ${userId}`);
        } catch (err: any) {
            console.error(`[TEST] ❌ Error HTML (${userId}):`, err.message);
            // Fallback a texto plano
            const safeText = msg.replace(/<[^>]*>?/gm, '');
            try {
                await testBot.api.sendMessage(userId, safeText);
                console.log(`[TEST] ✅ Fallback (plano) enviado a ${userId}`);
            } catch (e: any) {
                console.error(`[TEST] ❌ Fallback también falló (${userId}):`, e.message);
            }
        }
    }

    console.log('[TEST] ✅ Test completado');
}

main().catch(e => console.error('[TEST FATAL]', e));
