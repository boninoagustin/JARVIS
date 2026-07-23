        // =========================================================================
        // EJECUCIÓN OTE FUERA DE LA TRANSACCIÓN
        // =========================================================================
        if (triggerOte && oteData) {
            console.log(`[SNIPER] 🎯 triggerOte=true para ${ticker} ${oteData.direction}. Puntos: ${oteData.points}. Evaluando killswitches...`);
            
            state.lastGatillo = {
                dir: oteData.direction as 'BUY' | 'SELL',
                price: oteData.entryPrice,
                time: nowMs,
                type: oteData.isChochEntry ? 'CHOCH' : 'OTE',
                status: 'EVALUANDO...',
                tf: oteData.tf
            };
            
            state.version = (state.version || 0) + 1;
            state.lastModified = nowMs;
            docRef.set(state, { merge: true }).catch((err: any) => console.error(`[FIREBASE] Error guardando gatillo ${ticker}: ${err.message}`)); // Update status in UI immediately

            const config = getConfigForTicker(ticker, nowMs);
            if (!config.sessionEnabled) {
                console.log(`[RADAR] 🚫 Trading desactivado para ${ticker} en esta sesión (OTE bloqueado)`);
                state.lastGatillo.status = 'BLOCKED_SESSION';
                docRef.set(state).catch(() => {});
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                store.activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                return;
            }

            const isGlobalKilled = await evaluateGlobalKillswitch(nowMs, store, isBacktest);
            if (isGlobalKilled) {
                console.log(`[GLOBAL KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por riesgo global consolidado de la cuenta.`);
                state.lastGatillo.status = 'BLOCKED_GLOBAL';
                docRef.set(state).catch(() => {});
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                store.activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                return;
            }

            if (nowMs < store.streakKillswitchUntil) {
                const remainingMin = Math.round((store.streakKillswitchUntil - nowMs) / 60000);
                console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por racha perdedora (${store.consecutiveLosses} pérdidas). Restan ${remainingMin} min de bloqueo.`);
                state.lastGatillo.status = 'BLOCKED_RACHA';
                docRef.set(state).catch(() => {});
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                store.activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                return;
            }
            if (nowMs < store.vixKillswitchUntil) {
                const remainingMin = Math.round((store.vixKillswitchUntil - nowMs) / 60000);
                console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por VIX>30. Restan ${remainingMin} min de bloqueo.`);
                state.lastGatillo.status = 'BLOCKED_VIX';
                docRef.set(state).catch(() => {});
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                store.activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                return;
            }

            let activeSessionId: string | undefined;
            if (isBacktest) {
                const { getCurrentSessionId } = await import('../services/backtesting.js');
                activeSessionId = getCurrentSessionId() || undefined;
            }

            // 🆕 v7.1: FILTRO DE OPERACIONES SELL POR ACTIVO (Anti-Short Bias)
            // Para activos con sesgo alcista (ej. NAS100), limita la cantidad de SELLs diarios
            // y/o exige un puntaje mínimo más alto para señales bajistas.
            if (oteData.direction === 'SELL') {
                const sellConfig = getConfigForTicker(ticker, nowMs);

                // 🛑 Verificar pérdidas consecutivas (MCL) direccionales por sesión y activo
                const currentSession = getCurrentSession(nowMs);
                const sessionConfig = sellConfig.sessions?.[currentSession];
                if (sessionConfig && sessionConfig.maxSellLosses !== undefined && sessionConfig.maxSellLosses > 0) {
                    const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'SELL', nowMs, isBacktest, activeSessionId);
                    if (currentConsecutiveLosses >= sessionConfig.maxSellLosses) {
                        console.log(`[MCL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${store.consecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas en sesión ${currentSession}.`);
                        state.lastGatillo!.status = 'BLOCKED_MCL_LIMIT';
                        docRef.set(state).catch(() => {});
                        store.activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});

                        sendTelegramAlert(
                            `🚨 <b>[MCL LIMIT]</b> ${ticker} SELL ignorado.\n\n` +
                            `📊 Se alcanzaron <b>${store.consecutiveLosses}/${sessionConfig.maxSellLosses}</b> pérdidas consecutivas de tipo SELL hoy en la sesión <b>${currentSession}</b>.\n` +
                            `💡 <i>Límite de pérdidas consecutivas (maxSellLosses) superado.</i>`
                        ).catch(() => {});
                        return;
                    }
                    console.log(`[MCL LIMIT] ✅ ${ticker} SELL permitido: ${store.consecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas de tipo SELL.`);
                }

                // 📊 Verificar límite diario de SELLs
                if (sellConfig.maxSellsPerDay > 0) {
                    const dailySells = await countDailySellsForTicker(ticker, nowMs, isBacktest, activeSessionId);
                    if (dailySells >= sellConfig.maxSellsPerDay) {
                        console.log(`[SELL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${dailySells}/${sellConfig.maxSellsPerDay} SELLs diarios alcanzados.`);
                        state.lastGatillo!.status = 'BLOCKED_SELL_LIMIT';
                        docRef.set(state).catch(() => {});
                        store.activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});

                        sendTelegramAlert(
                            `⚠️ <b>[SELL LIMIT]</b> ${ticker} SELL ignorado.\n\n` +
                            `📊 Ya se ejecutaron <b>${dailySells}/${sellConfig.maxSellsPerDay}</b> operaciones SELL hoy en este activo.\n` +
                            `💡 <i>Configurá maxSellsPerDay en asset_configs para ajustar el límite.</i>`
                        ).catch(() => {});
                        return;
                    }
                    console.log(`[SELL LIMIT] ✅ ${ticker} SELL permitido: ${dailySells}/${sellConfig.maxSellsPerDay} SELLs usados hoy.`);
                }

            }

            // 🆕 v7.2: FILTRO DE OPERACIONES BUY (Anti-Long Bias)
            if (oteData.direction === 'BUY') {
                const buyConfig = getConfigForTicker(ticker, nowMs);

                // 🛑 Verificar pérdidas consecutivas (MCL) direccionales por sesión y activo
                const currentSession = getCurrentSession(nowMs);
                const sessionConfig = buyConfig.sessions?.[currentSession];
                if (sessionConfig && sessionConfig.maxBuyLosses !== undefined && sessionConfig.maxBuyLosses > 0) {
                    const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'BUY', nowMs, isBacktest, activeSessionId);
                    if (currentConsecutiveLosses >= sessionConfig.maxBuyLosses) {
                        console.log(`[MCL LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${store.consecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas en sesión ${currentSession}.`);
                        state.lastGatillo!.status = 'BLOCKED_MCL_LIMIT';
                        docRef.set(state).catch(() => {});
                        store.activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});

                        sendTelegramAlert(
                            `🚨 <b>[MCL LIMIT]</b> ${ticker} BUY ignorado.\n\n` +
                            `📊 Se alcanzaron <b>${store.consecutiveLosses}/${sessionConfig.maxBuyLosses}</b> pérdidas consecutivas de tipo BUY hoy en la sesión <b>${currentSession}</b>.\n` +
                            `💡 <i>Límite de pérdidas consecutivas (maxBuyLosses) superado.</i>`
                        ).catch(() => {});
                        return;
                    }
                    console.log(`[MCL LIMIT] ✅ ${ticker} BUY permitido: ${store.consecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas de tipo BUY.`);
                }

                // 📊 Verificar límite diario de BUYs
                if (buyConfig.maxBuysPerDay > 0) {
                    const dailyBuys = await countDailyBuysForTicker(ticker, nowMs, isBacktest, activeSessionId);
                    if (dailyBuys >= buyConfig.maxBuysPerDay) {
                        console.log(`[BUY LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${dailyBuys}/${buyConfig.maxBuysPerDay} BUYs diarios alcanzados.`);
                        state.lastGatillo!.status = 'BLOCKED_BUY_LIMIT';
                        docRef.set(state).catch(() => {});
                        store.activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});

                        sendTelegramAlert(
                            `⚠️ <b>[BUY LIMIT]</b> ${ticker} BUY ignorado.\n\n` +
                            `📊 Ya se ejecutaron <b>${dailyBuys}/${buyConfig.maxBuysPerDay}</b> operaciones BUY hoy en este activo.\n` +
                            `💡 <i>Configurá maxBuysPerDay en asset_configs para ajustar el límite.</i>`
                        ).catch(() => {});
                        return;
                    }
                    console.log(`[BUY LIMIT] ✅ ${ticker} BUY permitido: ${dailyBuys}/${buyConfig.maxBuysPerDay} BUYs usados hoy.`);
                }

            }
            
            // 🆕 Filtro Anti-Piramidación y Lógica SAR (Stop and Reverse)
            let existingTradeForTicker: ActiveTrade | undefined;
            for (const trade of store.activeTrades.values()) {
                if (trade.ticker === ticker && trade.tradeId !== oteData.tradeId) {
                    existingTradeForTicker = trade;
                    break;
                }
            }

            // 🛡️ Extra check: Si no hay en RAM, revisemos cTrader real para evitar duplicados huérfanos
            let cTraderPos: any;
            if (!isBacktest && !existingTradeForTicker) {
                try {
                    const ctrader = await import('../services/ctrader.js');
                    if (ctrader.isCTraderReady()) {
                        const openPositions = await ctrader.getOpenPositions(ticker);
                        if (openPositions && openPositions.length > 0) {
                            cTraderPos = openPositions[0];
                            const cTraderDir = (cTraderPos.tradeData?.tradeSide || cTraderPos.tradeSide || '').toString().toUpperCase();
                            // Crear un mock de ActiveTrade para aplicar la misma lógica
                            existingTradeForTicker = {
                                tradeId: String(cTraderPos.positionId || cTraderPos.id || 'CTRADER_MOCK'),
                                ticker: ticker,
                                direction: cTraderDir.includes('BUY') ? 'BUY' : 'SELL',
                                entryPrice: cTraderPos.entryPrice || cTraderPos.price || 0,
                                tp1Price: 0, tp2Price: 0, slPrice: 0,
                                tp1Hit: false, tp2Hit: false,
                                score: 0, // Score 0 significa que cualquier señal nueva le ganará en SAR
                                timestamp: Date.now(), isBacktest: isBacktest,
                                ctraderPositionId: String(cTraderPos.positionId || cTraderPos.id)
                            };
                            console.log(`[ANTI-PYRAMID] ⚠️ Trade encontrado en cTrader (huérfano en RAM): ${existingTradeForTicker.direction} posID: ${existingTradeForTicker.ctraderPositionId}`);
                        }
                    }
                } catch (e) {
                    console.error("[ANTI-PYRAMID] Error verificando posiciones cTrader:", e);
                }
            }

            let sarPendingClose: any = null;
            if (existingTradeForTicker) {
                const cleanupPrecreatedTrade = () => {
                    if (oteData && oteData.tradeId) {
                        store.activeTrades.delete(oteData.tradeId);
                        if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                    }
                };

                if (existingTradeForTicker.direction === oteData.direction) {
                    // Mismo sentido -> Bloquear para evitar piramidación
                    console.log(`[ANTI-PYRAMID] ⛔ Señal ${oteData.direction} ignorada para ${ticker}: ya hay una operación activa en la misma dirección.`);
                    cleanupPrecreatedTrade();
                    if (state.lastGatillo) state.lastGatillo.status = 'BLOCKED_ANTIPYRAMID';
                    docRef.set(state).catch(() => {});
                    if (!isBacktest) sendTelegramAlert(`⚠️ <b>SEÑAL IGNORADA</b> | ${ticker}\nSe detectó una nueva señal <b>${oteData.direction}</b>, pero ya hay una operación abierta en la misma dirección. (Anti-Piramidación)`).catch(() => {});
                    return;
                } else {
                    // Dirección Opuesta -> SAR (Stop and Reverse)
                    if (oteData.points > existingTradeForTicker.score) {
                        console.log(`[SAR] 🔄 Reversión Activada (Diferida) para ${ticker}: Nueva señal ${oteData.direction} (Score: ${oteData.points}) supera a la activa (Score: ${existingTradeForTicker.score}).`);
                        sarPendingClose = existingTradeForTicker;
                    } else {
                        // Puntaje menor o igual -> Ignorar la nueva señal
                        console.log(`[SAR] ⛔ Reversión Denegada para ${ticker}: Nueva señal ${oteData.direction} (Score: ${oteData.points}) no supera a la activa (Score: ${existingTradeForTicker.score}).`);
                        cleanupPrecreatedTrade();
                        if (state.lastGatillo) state.lastGatillo.status = 'BLOCKED_SAR_DENIED';
                        docRef.set(state).catch(() => {});
                        if (!isBacktest) sendTelegramAlert(`⚠️ <b>SEÑAL DESCARTADA</b> | ${ticker}\n\nSe detectó una señal <b>${oteData.direction}</b> (Puntaje: ${oteData.points}), pero se mantiene la operación <b>${existingTradeForTicker.direction}</b> actual porque tiene mayor o igual convicción (Puntaje: ${existingTradeForTicker.score}).`).catch(() => {});
                        return;
                    }
                }
            }

            const fingerprint = `OTE_${ticker}_${oteData.direction}_${oteData.tp1}`;
            console.log(`[SNIPER] 🔍 Verificando duplicado: ${fingerprint}`);
            if (!isDuplicate(fingerprint, nowMs)) {
                
                state.lastGatillo.status = 'PROCESANDO...';
                docRef.set(state).catch(() => {});

                let kronosAnnotation = '';
                let kronosVerdict: string = 'SKIP';
                let swarmAnnotation = '';
                let swarmConsensus: string = 'SKIP';
                let sessionId: string | undefined;

                if (isBacktest) {
                    const { getCurrentSessionId } = await import('../services/backtesting.js');
                    sessionId = getCurrentSessionId() || undefined;
                } else {
                        let kronosRawDetails = '';
                    // Kronos AI local (LSTM, sin quota externa)
                    try {
                        const { evaluateWithKronos } = await import('../services/kronos.js');
                        const kRes = await evaluateWithKronos(
                            ticker, 
                            oteData.direction as 'BUY' | 'SELL',
                            Number(oteData.entryPrice),
                            Number(oteData.stopLoss),
                            Number(oteData.tp1)
                        );
                        kronosVerdict = (kRes as any).isConfirmed ? 'CONFIRMED' : 'DIVERGENCE';
                        kronosRawDetails = (kRes as any).rawDetails || (kRes as any).details || '';
                        kronosAnnotation = (kRes as any).trend === null 
                            ? `\n\n🤖 <b>Kronos AI:</b> ${(kRes as any).details}`
                            : `\n\n🤖 <b>Kronos AI:</b> ${(kRes as any).isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA'}\n${(kRes as any).details}`;
                    } catch { kronosVerdict = 'ERROR'; }

                    // 🐝 Enjambre de IA (solo si Kronos CONFIRMA y puntaje ≥ 8)
                    if (kronosVerdict === 'CONFIRMED' && oteData.points >= 8) {
                        try {
                            const fetch = (await import('node-fetch')).default;
                            const swarmRes = await fetch('http://127.0.0.1:8001/api/analyze-trade', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    ticker,
                                    direction: oteData.direction,
                                    entryPrice: oteData.entryPrice,
                                    stopLoss: parseFloat(oteData.stopLoss),
                                    tp1Price: parseFloat(oteData.tp1),
                                    tp2Price: oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : undefined,
                                    points: oteData.points,
                                    events: oteData.events || [],
                                    confluenceReport: oteData.confluenceReport || '',
                                    marketBias: oteData.marketBias || {},
                                    consecutiveLosses: store.consecutiveLosses,
                                    winRate: 0,
                                    kronosVerdict: kronosVerdict,
                                    kronosDetails: kronosRawDetails
                                }),
                                signal: AbortSignal.timeout(8000) // ⚡ Reducido de 15s a 8s para scalping
                            });
                            if (swarmRes.ok) {
                                const swarm = await swarmRes.json() as any;
                                swarmConsensus = swarm.decision === 'EJECUTAR' ? 'APPROVED' : 'REJECTED';
                                const voteCount = swarm.votes?.filter((v: any) => v.decision === 'APROBADO').length || 0;
                                const totalVotes = swarm.votes?.length || 0;
                                swarmAnnotation = `\n\n🗳️ <b>Votación Multi-IA (DeepSeek):</b> ${swarmConsensus === 'APPROVED' ? '🟢 APROBADO' : '🔴 RECHAZADO'} (${voteCount}/${totalVotes})\n`;
                                if (swarm.votes) {
                                    for (const v of swarm.votes) {
                                        const icon = v.decision === 'APROBADO' ? '✅' : '❌';
                                        swarmAnnotation += `${icon} <b>${v.agent}:</b> ${v.decision === 'APROBADO' ? 'APPROVE' : 'REJECT'} — ${v.reason.split('\n')[0].substring(0, 120)}\n`;
                                    }
                                }
                                swarmAnnotation += `⚖️ <b>Juez:</b> ${swarm.summary || 'Sin resumen'}`;
                            }
                        } catch (swarmErr: any) {
                            swarmConsensus = 'ERROR';
                            console.log(`[SWARM] AI Bridge no disponible: ${swarmErr.message}`);
                        }
                    }
                }

                const isChoch = oteData.events?.some((e: string) => e.includes('CHoCH🚀'));
                const isBos = oteData.events?.some((e: string) => e.includes('BOS🔨'));
                const breakType = isChoch ? 'CHoCH' : isBos ? 'BOS' : 'SMC';
                const entryTypeLabel = oteData.isChochEntry 
                    ? (isBos ? 'BOS Directo' : 'CHoCH Directo') 
                    : `OTE (basado en ${breakType})`;

                let headerLabel = 'OTE';
                if (oteData.isChochEntry) {
                    headerLabel = isBos ? 'BOS DIRECTO' : 'CHOCH DIRECTO';
                } else {
                    headerLabel = `OTE (${breakType})`;
                }

                let msg = `${isBacktest ? "🧪 <b>BACKTESTING</b> | " : "🔥 "}<b>ALERTA FRANCOTIRADOR ${headerLabel} | ${ticker} | ${oteData.dirText}</b>\n\n`;
                msg += (oteData.confluenceReport || '').trim() + '\n\n';
                msg += `🎯 <b>Tipo de Entrada:</b> ${entryTypeLabel}\n`;
                msg += `🎯 <b>Puntaje Total:</b> ${oteData.points} Puntos\n`;
                msg += `🧱 <b>Confluencias:</b> ${oteData.events?.join(', ')}\n\n`;

                const config = getConfigForTicker(ticker, nowMs);
                let avisoRiesgo = oteData.points >= 8
                    ? `Operar con riesgo estándar (${config.baseRiskPercentage}%).`
                    : `Setup de puntaje medio. Riesgo reducido (${config.baseRiskPercentage / 2}%).`;

                const jarvisNote = oteData.isChochEntry
                    ? `Gatillo de entrada directa por ${isBos ? 'BOS' : 'CHoCH'} confirmado. ${avisoRiesgo}`
                    : `Llegada a zona OTE confirmada. ${avisoRiesgo}`;
                msg += `🧠 <b>Jarvis:</b> ${jarvisNote}\n\n`;
                msg += `📐 <b>Niveles de Ejecución (GATILLO):</b>\n`;
                msg += `🎯 Precio de Entrada: ${oteData.entryPrice}\n`;
                msg += `🛑 Stop Loss Sugerido: ${oteData.stopLoss}\n`;
                msg += `💰 Take Profit 1 (Interno): ${oteData.tp1}\n`;
                msg += `🚀 Take Profit 2 (Externo): ${oteData.tp2}\n`;

                msg += kronosAnnotation;
                msg += swarmAnnotation;

                console.log(`[SNIPER] 📨 Mensaje FRANCOTIRADOR construido para ${ticker} (${msg.length} chars). isBacktest=${isBacktest}`);

                const journalId = await logTrade({
                    ticker, direction: oteData.direction as 'BUY' | 'SELL',
                    grade: oteData.points >= 8 ? 'A+' : 'B', points: oteData.points, events: oteData.events,
                    macroContext: oteData.marketBias,
                    kronosVerdict: isBacktest ? 'SKIP_BT' : kronosVerdict,
                    mixtureConsensus: swarmConsensus,
                    timestamp: nowMs,
                    mode: isBacktest ? 'backtesting' : 'live',
                    sessionId,
                    entryPrice: oteData.entryPrice, 
                    tp1Price: parseFloat(oteData.tp1),
                    tp2Price: oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : undefined,
                    slPrice: parseFloat(oteData.stopLoss),
                    isChochEntry: oteData.isChochEntry,
                    // 🧠 MACHINE LEARNING FEATURES (Fase 1)
                    hourOfDay: new Date(nowMs).getHours(),
                    dayOfWeek: new Date(nowMs).getDay(),
                    session: getCurrentSession(nowMs),
                    bias4H: state.marketBias['240'] === oteData.direction ? 'ALIGNED' : state.marketBias['240'] === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
                    bias1H: state.marketBias['60'] === oteData.direction ? 'ALIGNED' : state.marketBias['60'] === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
                    vwapDistance: (oteData.events.includes('VWAP_Premium') || oteData.events.includes('VWAP_Discount')) ? 1 : 0,
                    tf: oteData.tf
                }).catch(() => 'ERR');
                
                // 🧠 REGISTRO EN ACTIVE TRADES SI ES ENTRADA DIRECTA (isChochEntry: true)
                let activeTrade = store.activeTrades.get(oteData.tradeId);
                if (!activeTrade) {
                    activeTrade = {
                        tradeId: oteData.tradeId,
                        ticker,
                        direction: oteData.direction as 'BUY' | 'SELL',
                        entryPrice: oteData.entryPrice,
                        tp1Price: parseFloat(oteData.tp1),
                        tp2Price: oteData.tp2 && oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : oteData.entryPrice * 1.5,
                        slPrice: parseFloat(oteData.stopLoss),
                        tp1Hit: false,
                        tp2Hit: false,
                        slHalfwayHit: false,
                        score: oteData.points || 0,
                        timestamp: nowMs, isBacktest: isBacktest
                    };
                    store.activeTrades.set(oteData.tradeId, activeTrade);
                    if (db) db.collection('active_trades').doc(oteData.tradeId).set(activeTrade).catch(() => {});
                    console.log(`[SNIPER] 💾 Registrado trade activo DIRECTO para ${ticker} #${oteData.tradeId}`);
                }

                if (journalId && journalId !== 'ERR' && journalId !== 'N/A') {
                    activeTrade.journalId = journalId;
                    // 💾 Actualizar el journalId en Firebase
                    if (db) db.collection('active_trades').doc(oteData.tradeId).update({ journalId }).catch(() => {});
                }

                // 🤖 cTrader: Send trade with confirmation buttons (semi-automatic mode)
                if (!isBacktest) {
                    try {
                        const { config: globalConfig } = await import('../config.js');
                        const { sendTradeConfirmation } = await import('../services/ctrader_confirmation.js');
                        const ctraderConfigured = !!(globalConfig.CTRADER_CLIENT_ID && globalConfig.CTRADER_ACCESS_TOKEN);
                        
                        if (ctraderConfigured) {
                            const recheckKillswitchesBeforeExecution = async (): Promise<string | null> => {
                                const nowLive = Date.now();
                                const cfg = getConfigForTicker(ticker, nowLive);
                                if (!cfg.sessionEnabled) return 'BLOCKED_SESSION';
                                if (store.globalKillswitches['GLOBAL_SYSTEM'] || store.globalKillswitches[ticker]) return 'BLOCKED_KILLSWITCH';
                                if (await evaluateGlobalKillswitch(nowLive, store, isBacktest)) return 'BLOCKED_GLOBAL';
                                if (nowLive < store.streakKillswitchUntil) return 'BLOCKED_RACHA';
                                if (nowLive < store.vixKillswitchUntil) return 'BLOCKED_VIX';
                                return null;
                            };

                            const blockedBy = await recheckKillswitchesBeforeExecution();
                            if (blockedBy) {
                                console.log(`[KILLSWITCH] ⛔ TOCTOU Prevención: Ejecución bloqueada por ${blockedBy} para ${ticker}`);
                                if (state.lastGatillo) state.lastGatillo.status = blockedBy;
                                docRef.set(state).catch(() => {});
                                store.activeTrades.delete(oteData.tradeId);
                                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
                                return;
                            }

                            if (store.dynamicBotConfig.autoTrading) {
                                // 🚀 MODO AUTOMÁTICO: Ejecutar directamente
                                const { executeMarketOrder } = await import('../services/ctrader.js');
                                console.log(`[SNIPER] 🤖 Modo AUTO activado. Ejecutando ${ticker} inmediatamente...`);
                                
                                const result = await executeMarketOrder({
                                    ticker,
                                    direction: oteData.direction as 'BUY' | 'SELL',
                                    entryPrice: oteData.entryPrice,
                                    slPrice: parseFloat(oteData.stopLoss),
                                    tp1Price: parseFloat(oteData.tp1),
                                    tp2Price: oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : undefined,
                                    tradeId: oteData.tradeId,
                                });

                                if (result.success && result.positionId) {
                                    if (sarPendingClose) {
                                        try {
                                            if (sarPendingClose.ctraderPositionId) {
                                                const ctrader = await import('../services/ctrader.js');
                                                await ctrader.closePosition(sarPendingClose.ctraderPositionId);
                                            }
                                            store.activeTrades.delete(sarPendingClose.tradeId);
                                            if (db) db.collection('active_trades').doc(sarPendingClose.tradeId).delete().catch(() => {});
                                            if (sarPendingClose.journalId) recordResult(sarPendingClose.journalId, 'REVERSAL').catch(() => {});
                                        } catch (e) {
                                            console.error('[SAR] Error cierre diferido automático:', e);
                                        }
                                    }

                                    updateTradePositionId(oteData.tradeId, result.positionId);
                                    if (db && journalId) {
                                        db.collection('trade_journal').doc(journalId).update({
                                            ctraderPositionId: result.positionId,
                                            ctraderLots: result.lots,
                                            ctraderExecutedPrice: result.executedPrice,
                                            ctraderStatus: 'EXECUTED',
                                            ctraderDemo: globalConfig.CTRADER_DEMO,
                                        }).catch(() => {});
                                    }
                                    const successMsg = `🚀 <b>AUTO-EJECUCIÓN EXITOSA</b>\n\n${msg}\n\n✅ <b>Ejecutado a:</b> ${result.executedPrice}\n🆔 <b>posID:</b> ${result.positionId}`;
                                    await sendTelegramAlert(successMsg);
                                } else {
                                    const errorMsg = `❌ <b>ERROR AUTO-EJECUCIÓN</b>\n\n${msg}\n\n⚠️ Error: ${result.error}`;
                                    await sendTelegramAlert(errorMsg);
                                }
                            } else {
                                // ⏸️ MODO SEMI-AUTOMÁTICO: Enviar alerta WITH cTrader execution buttons
                                await sendTradeConfirmation({
                                    tradeId: oteData.tradeId,
                                    ticker,
                                    direction: oteData.direction as 'BUY' | 'SELL',
                                    dirText: oteData.dirText,
                                    entryPrice: oteData.entryPrice,
                                    slPrice: parseFloat(oteData.stopLoss),
                                    tp1Price: parseFloat(oteData.tp1),
                                    tp2Price: oteData.tp2 !== 'Buscando DOL macro...' ? parseFloat(oteData.tp2) : undefined,
                                    points: oteData.points,
                                    grade: oteData.points >= 8 ? 'A+' : 'B',
                                    events: oteData.events || [],
                                    confluenceReport: oteData.confluenceReport || '',
                                    kronosVerdict: kronosVerdict,
                                    swarmConsensus: swarmConsensus,
                                    alertMessage: msg,
                                    journalId: typeof journalId === 'string' ? journalId : undefined,
                                    isChochEntry: oteData.isChochEntry,
                                    sarPendingClose,
                                });
                                console.log(`[SNIPER] ✅ Alerta FRANCOTIRADOR + botones cTrader enviada para ${ticker}`);
                            }
                        } else {
                            // cTrader not configured — send normal alert (original behavior)
                            await sendTelegramAlert(msg);
                            console.log(`[SNIPER] ✅ Alerta FRANCOTIRADOR enviada (sin cTrader) para ${ticker}`);
                        }
                    } catch (teleErr: any) {
                        // Fallback to normal alert if confirmation system fails
                        console.error(`[SNIPER] ⚠️ Error en sistema de confirmación, enviando alerta normal:`, teleErr.message);
                        try { await sendTelegramAlert(msg); } catch {}
                    }
                } else {
                    console.log(`[SNIPER] ⏭️ Modo backtest — alerta FRANCOTIRADOR NO enviada a Telegram`);
                }
                
                state.lastGatillo.status = 'ENVIADO';
                docRef.set(state).catch(() => {});
            } else {
                console.log(`[SNIPER] ⚠️ DUPLICADO bloqueado: ${fingerprint}`);
                state.lastGatillo.status = 'DUPLICADO';
                docRef.set(state).catch(() => {});
                
                // Limpiar si se pre-creó en evaluateImpulse (para OTE)
                store.activeTrades.delete(oteData.tradeId);
                if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
            }
        }
