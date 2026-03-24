import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

// --- INTERFACES DEL RADAR JSON ---
interface RadarZone {
    tf?: string; // Temporalidad de origen (ej: '60', '240')
    dir: 'BUY' | 'SELL';
    top: number;
    btm: number;
    lvl: string;
    medal?: string;
}

interface RadarState {
    lastSyncDate: string | null;
    zones: RadarZone[];
    activeLocks: string[];
    lastPrice: number | null;
}

const emptyState = (): RadarState => ({
    lastSyncDate: null,
    zones: [],
    activeLocks: [],
    lastPrice: null
});

async function sendTelegramAlert(message: string) {
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (err: any) {
            console.error(`[TRADING] Error enviando alerta a ${userId}:`, err.message);
        }
    }
}

async function enqueueScreenshotRequest(ticker: string, message: string) {
    if (!db) return;
    const requestRef = db.collection('screenshot_requests').doc();
    await requestRef.set({
        ticker,
        message,
        status: 'pending',
        timestamp: Date.now()
    });
}

export async function processTradingAlert(alertText: string) {
    if (!db) {
        console.error('[TRADING] Base de datos no inicializada.');
        return;
    }

    const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
    const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());

    if (parts.length < 2) return;

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1].replace(/"/g, '');
    const upperText = alertText.toUpperCase();

    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('ALCISTA') || upperText.includes('COMPRA')) {
        currentDirection = 'BUY';
    } else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('BAJISTA') || upperText.includes('VENTA')) {
        currentDirection = 'SELL';
    }

    const docRef = db.collection('radar_states').doc(ticker);
    const todayStr = new Date().toISOString().split('T')[0];

    try {
        await db.runTransaction(async (transaction) => {
            const docSnap = await transaction.get(docRef);
            let state: RadarState = docSnap.exists ? (docSnap.data() as RadarState) : emptyState();

            // =========================================================================
            // 📡 MOTOR 1: SINCRONIZACIÓN DE MAPA EN VIVO
            // =========================================================================
            if (prefix === 'SYNC_ZONES') {
                if (!alertText.includes('Payload:')) return;

                // Extraemos el TF (ej: 240, 60, 30)
                const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
                const sourceTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
                const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();

                try {
                    const parsedZones = JSON.parse(payloadStr) as RadarZone[];
                    parsedZones.forEach(z => z.tf = sourceTf);

                    if (state.lastSyncDate !== todayStr) {
                        state.zones = [];
                        state.activeLocks = [];
                        state.lastSyncDate = todayStr;
                        console.log(`[RADAR] 🔄 Nuevo día. Limpiando memoria para ${ticker}`);
                    }

                    // Magia: Borramos SOLO las cajas viejas de esta temporalidad específica
                    state.zones = state.zones.filter(z => z.tf !== sourceTf);

                    // Inyectamos las cajas frescas
                    state.zones.push(...parsedZones);
                    console.log(`[RADAR] 📦 Mapa de ${sourceTf}M actualizado. Total de zonas: ${state.zones.length}`);

                } catch (e) {
                    console.error(`[RADAR] Error parseando JSON de zonas:`, e);
                }
            }

            // =========================================================================
            // 📍 MOTOR 2: RASTREO POR GPS (PING PRICE)
            // =========================================================================
            else if (prefix === 'PING_PRICE') {
                const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
                if (!priceMatch) return;

                const currentPrice = parseFloat(priceMatch[1]);
                state.lastPrice = currentPrice;

                const currentInsideLocks: string[] = [];
                let hasNewInvasion = false;
                let invadedDir = '';

                for (const zone of state.zones) {
                    if (currentPrice <= zone.top && currentPrice >= zone.btm) {
                        const lockKey = `${zone.dir}_${zone.top}_${zone.btm}`;
                        currentInsideLocks.push(lockKey);

                        if (!state.activeLocks.includes(lockKey)) {
                            hasNewInvasion = true;
                            invadedDir = zone.dir === 'BUY' ? 'Alcista (Soporte)' : 'Bajista (Resistencia)';
                        }
                    }
                }

                state.activeLocks = currentInsideLocks;

                if (hasNewInvasion) {
                    console.log(`[RADAR] 📍 Invasión de zona en ${ticker} a precio ${currentPrice}`);
                    await sendTelegramAlert(`📍 *INVASIÓN DE ZONA MACRO | ${ticker}*\n\n📉 *Precio Actual:* ${currentPrice}\n🚨 *Atención:* El precio entró en un *Order Block Macro ${invadedDir}*.\n\n🧠 *Acción:* Preparate para setups locales.`);
                }
            }

            // =========================================================================
            // 🎯 MOTOR 3: GATILLOS Y CRUCE DE CONFLUENCIAS (CON ESCUDO)
            // =========================================================================
            else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP' || prefix === 'MASTER_ZONE' || prefix === 'LOCAL_CRT' || prefix === 'PO3_LIVE') {
                if (!currentDirection) return;

                const triggerName = prefix === 'PO3_LIVE' ? 'Setup NY PO3 (Barrido Londres)' :
                    prefix.includes('SWEEP') || prefix.includes('CRT') ? 'Sweep / Trampa' : 'Order Block Invocado';
                const dirText = currentDirection === 'BUY' ? 'COMPRA' : 'VENTA';
                const oppositeDirection = currentDirection === 'BUY' ? 'SELL' : 'BUY';

                const isInsideOppositeMacro = state.activeLocks.some(lock => lock.startsWith(oppositeDirection));

                if (isInsideOppositeMacro) {
                    console.log(`[RADAR] 🛡️ ESCUDO: Gatillo de ${dirText} bloqueado en ${ticker}. Piso/Techo contrario detectado.`);
                    transaction.set(docRef, state);
                    return;
                }

                const isGodTier = state.activeLocks.some(lock => lock.startsWith(currentDirection as string));
                const hasMacroAlignment = state.zones.some(zone => zone.dir === currentDirection);

                let message = '';
                let alertLevel: 'GOD' | 'CONT' | null = null;

                if (isGodTier) {
                    alertLevel = 'GOD';
                    message = `🔥 *ALERTA GOD TIER | ${ticker} | ${dirText}*\n\n🎯 *Gatillo:* ${triggerName} en 15M\n📦 *Superposición:* DENTRO del bloque Macro (${dirText})\n🧭 *Contexto:* Alineado con Fuerte Order Flow.\n\n🧠 *Acción:* Máxima probabilidad. Abrí 5M y buscá tu Engulfing/CHoCH.`;
                } else if (hasMacroAlignment) {
                    alertLevel = 'CONT';
                    message = `🛤️ *CONTINUACIÓN TENDENCIA | ${ticker} | ${dirText}*\n\n🎯 *Gatillo:* ${triggerName} en 15M\n🧭 *Contexto:* A favor del mapa Macro (${dirText}).\n\n🧠 *Acción:* Trade válido de continuación. Revisá 5M para entrar.`;
                }

                if (alertLevel) {
                    console.log(`[RADAR] 🚀 Cruce validado. Disparando Alerta ${alertLevel} en ${ticker}`);
                    if (alertLevel === 'GOD') {
                        await sendTelegramAlert(message);
                    } else {
                        await enqueueScreenshotRequest(ticker, message);
                    }
                } else {
                    console.log(`[RADAR] ⚠️ Gatillo ${triggerName} en ${ticker} ignorado por estar contra el mapa Macro.`);
                }
            }

            transaction.set(docRef, state);
        });
    } catch (e: any) {
        console.error(`[RADAR] Error crítico en Firebase:`, e.message);
    }
}