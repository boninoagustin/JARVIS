import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config } from '../config.js';

// --- INTERFACES DEL RADAR JSON ---
interface RadarZone {
    dir: 'BUY' | 'SELL';
    top: number;
    btm: number;
    lvl: string;
    medal?: string;
}

interface RadarState {
    lastSyncDate: string | null; // Para reiniciar el mapa cada día (ej: '2026-03-24')
    zones: RadarZone[];          // El gran mapa de cajas superpuestas
    activeLocks: string[];       // Candados para evitar spam (ej: 'BUY_1.1550_1.1500')
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

    // Extracción segura del prefijo y ticker sin romper un posible JSON
    const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
    const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());

    if (parts.length < 2) return;

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1].replace(/"/g, '');
    const upperText = alertText.toUpperCase();

    // Determinar dirección del gatillo
    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('ALCISTA') || upperText.includes('COMPRA')) {
        currentDirection = 'BUY';
    } else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('BAJISTA') || upperText.includes('VENTA')) {
        currentDirection = 'SELL';
    }

    const docRef = db.collection('radar_states').doc(ticker);
    const todayStr = new Date().toISOString().split('T')[0]; // Fecha actual YYYY-MM-DD

    try {
        await db.runTransaction(async (transaction) => {
            const docSnap = await transaction.get(docRef);
            let state: RadarState = docSnap.exists ? (docSnap.data() as RadarState) : emptyState();

            // =========================================================================
            // 📡 MOTOR 1: SINCRONIZACIÓN DE MAPA (JSON)
            // =========================================================================
            if (prefix === 'SYNC_ZONES') {
                if (!alertText.includes('Payload:')) return;

                const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
                try {
                    const parsedZones = JSON.parse(payloadStr) as RadarZone[];

                    // Si es un día nuevo, borramos el mapa de ayer. Si es el mismo día, sumamos (4H + 1H + 30M)
                    if (state.lastSyncDate !== todayStr) {
                        state.zones = [];
                        state.activeLocks = [];
                        state.lastSyncDate = todayStr;
                        console.log(`[RADAR] 🔄 Nuevo día detectado. Limpiando memoria para ${ticker}`);
                    }

                    state.zones.push(...parsedZones);
                    console.log(`[RADAR] 📦 ${parsedZones.length} zonas agregadas. Total en memoria: ${state.zones.length}`);

                    // Notificamos que el radar se actualizó con este fragmento
                    await sendTelegramAlert(`🗺️ *RADAR ACTUALIZADO | ${ticker}*\n✅ Se sumaron ${parsedZones.length} zonas nuevas al mapa.\n🤖 *JARVIS en línea. Esperando cruces.*`);

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

                // Escaneamos todo el mapa para ver dónde estamos parados
                for (const zone of state.zones) {
                    if (currentPrice <= zone.top && currentPrice >= zone.btm) {
                        const lockKey = `${zone.dir}_${zone.top}_${zone.btm}`;
                        currentInsideLocks.push(lockKey);

                        // Si esta zona no tenía el candado puesto, es una invasión nueva!
                        if (!state.activeLocks.includes(lockKey)) {
                            hasNewInvasion = true;
                            invadedDir = zone.dir === 'BUY' ? 'Alcista (Soporte)' : 'Bajista (Resistencia)';
                        }
                    }
                }

                // Actualizamos los candados (lo que suelta automáticamente las zonas que el precio abandonó)
                state.activeLocks = currentInsideLocks;

                if (hasNewInvasion) {
                    console.log(`[RADAR] 📍 Invasión de zona detectada en ${ticker} a precio ${currentPrice}`);
                    await sendTelegramAlert(`📍 *INVASIÓN DE ZONA MACRO | ${ticker}*\n\n📉 *Precio Actual:* ${currentPrice}\n🚨 *Atención:* El precio acaba de entrar en un *Order Block Macro ${invadedDir}*.\n\n🧠 *Acción:* Zona de interés alcanzada en GPS. Preparate para setups locales.`);
                }
            }

            // =========================================================================
            // 🎯 MOTOR 3: GATILLOS Y CRUCE DE CONFLUENCIAS (15M REALTIME)
            // =========================================================================
            else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP' || prefix === 'MASTER_ZONE' || prefix === 'LOCAL_CRT' || prefix === 'PO3_LIVE') {
                if (!currentDirection) return;

                // Identificamos exactamente qué tipo de gatillo acaba de saltar
                const triggerName = prefix === 'PO3_LIVE' ? 'Setup NY PO3 (Barrido Londres)' :
                    prefix.includes('SWEEP') || prefix.includes('CRT') ? 'Sweep / Trampa' : 'Order Block Invocado';

                const dirText = currentDirection === 'BUY' ? 'COMPRA' : 'VENTA';

                // PREGUNTA 1: ¿Estamos ADENTRO de una caja macro con esta misma dirección? (GOD TIER)
                const isGodTier = state.activeLocks.some(lock => lock.startsWith(currentDirection as string));

                // PREGUNTA 2: Si no estamos adentro, ¿Al menos el mapa general tiene zonas de esta dirección? (CONTINUACIÓN)
                const hasMacroAlignment = state.zones.some(zone => zone.dir === currentDirection);

                let message = '';
                let alertLevel: 'GOD' | 'CONT' | null = null;

                if (isGodTier) {
                    alertLevel = 'GOD';
                    message = `🔥 *ALERTA GOD TIER | ${ticker} | ${dirText}*\n\n🎯 *Gatillo:* ${triggerName} en 15M\n📦 *Superposición:* DENTRO del bloque Macro (${dirText})\n🧭 *Contexto:* Alineado con Fuerte Order Flow.\n\n🧠 *Acción:* Máxima probabilidad. Abrí 5M y buscá tu Engulfing/CHoCH.`;
                } else if (hasMacroAlignment) {
                    alertLevel = 'CONT';
                    message = `🛤️ *CONTINUACIÓN TENDENCIA | ${ticker} | ${dirText}*\n\n🎯 *Gatillo:* ${triggerName} en 15M\n🧭 *Contexto:* A favor del mapa Macro (${dirText}).\n⚠️ *Nota:* Apoya la tendencia mayor.\n\n🧠 *Acción:* Trade válido de continuación. Revisá 5M para entrar.`;
                }

                if (alertLevel) {
                    console.log(`[RADAR] 🚀 Cruce validado. Disparando Alerta ${alertLevel} en ${ticker}`);
                    if (alertLevel === 'GOD') {
                        await sendTelegramAlert(message);
                    } else {
                        // Las de continuación las mandamos con captura
                        await enqueueScreenshotRequest(ticker, message);
                    }
                } else {
                    console.log(`[RADAR] ⚠️ Gatillo ${triggerName} en ${ticker} ignorado por estar contra el mapa Macro.`);
                }
            }

            // Guardamos el nuevo estado en la base de datos
            transaction.set(docRef, state);
        });
    } catch (e: any) {
        console.error(`[RADAR] Error crítico en Firebase:`, e.message);
    }
}