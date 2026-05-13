import { db } from '../src/db/memory.js';

async function main() {
    if (!db) { console.log('❌ DB no inicializada'); process.exit(1); }

    const tickers = ['US100', 'BTCUSD'];
    const now = Date.now();

    for (const ticker of tickers) {
        console.log(`\n${'═'.repeat(70)}`);
        console.log(`📊 DIAGNÓSTICO: ${ticker}`);
        console.log(`${'═'.repeat(70)}`);

        // 1. Radar State
        const radarDoc = await db.collection('radar_states').doc(ticker).get();
        const radar: any = radarDoc.exists ? radarDoc.data() : null;

        if (!radar) {
            console.log(`  ❌ Sin estado radar en Firebase`);
            continue;
        }

        // Score Buy
        const buyAge = radar.scoreBuy?.lastUpdate ? Math.round((now - radar.scoreBuy.lastUpdate) / 60000) : Infinity;
        console.log(`  🟢 SCORE BUY:  ${radar.scoreBuy?.points ?? 0} pts | ${radar.scoreBuy?.events?.length ?? 0} eventos | última actualización: ${buyAge}min`);
        if (radar.scoreBuy?.events?.length) {
            for (const e of radar.scoreBuy.events) console.log(`      └─ ${e}`);
        }

        // Score Sell
        const sellAge = radar.scoreSell?.lastUpdate ? Math.round((now - radar.scoreSell.lastUpdate) / 60000) : Infinity;
        console.log(`  🔴 SCORE SELL: ${radar.scoreSell?.points ?? 0} pts | ${radar.scoreSell?.events?.length ?? 0} eventos | última actualización: ${sellAge}min`);
        if (radar.scoreSell?.events?.length) {
            for (const e of radar.scoreSell.events) console.log(`      └─ ${e}`);
        }

        // Zones
        console.log(`  🗺️  ZONAS ACTIVAS: ${radar.zones?.length ?? 0}`);
        const byTf: Record<string, number> = {};
        if (radar.zones) {
            for (const z of radar.zones) {
                byTf[z.tf || '?'] = (byTf[z.tf || '?'] || 0) + 1;
            }
            for (const [tf, count] of Object.entries(byTf)) {
                console.log(`      ${tf}: ${count} zonas`);
            }
            // Mostrar 3 mejores zonas por TF
            for (const tf of ['240', '60', '15', '3']) {
                const tfZones = radar.zones.filter((z: any) => z.tf === tf);
                if (tfZones.length === 0) continue;
                const top = tfZones.sort((a: any, b: any) => (b.score || 0) - (a.score || 0)).slice(0, 3);
                for (const z of top) {
                    const scoreLabel = z.score !== undefined ? ` [${z.score}/10]` : '';
                    console.log(`      ${z.dir} ${z.medal || 'OB'}${scoreLabel}: ${z.btm?.toFixed(5)} → ${z.top?.toFixed(5)}`);
                }
            }
        }

        // Market Bias
        console.log(`  🧭 MARKET BIAS:`);
        for (const tf of ['240', '60', '15', '3']) {
            const bias = radar.marketBias?.[tf] || '?';
            const icon = bias === 'BUY' ? '🟢' : bias === 'SELL' ? '🔴' : '⚪';
            console.log(`      ${icon} ${tf === '240' ? '4H' : tf === '60' ? '1H' : tf === '15' ? '15M' : '3M'}: ${bias}`);
        }

        // Impulse Legs
        const buyLeg = radar.activeImpulseBuy;
        const sellLeg = radar.activeImpulseSell;
        if (buyLeg) {
            const legAge = buyLeg.createdAt ? Math.round((now - buyLeg.createdAt) / 60000) : 0;
            const range = buyLeg.extreme && buyLeg.origin ? Math.abs(buyLeg.extreme - buyLeg.origin) : 0;
            const oteLow = buyLeg.dir === 'BUY' ? buyLeg.extreme - (range * 0.79) : buyLeg.extreme + (range * 0.50);
            const oteHigh = buyLeg.dir === 'BUY' ? buyLeg.extreme - (range * 0.50) : buyLeg.extreme + (range * 0.79);
            console.log(`  🦵 IMPULSE BUY (${legAge}min):`);
            console.log(`      Origin: ${buyLeg.origin?.toFixed(5)} | Extreme: ${buyLeg.extreme?.toFixed(5)}`);
            console.log(`      Rango: ${range.toFixed(5)} | OTE: ${oteLow?.toFixed(5)} → ${oteHigh?.toFixed(5)}`);
            console.log(`      Validado: ${buyLeg.isValidated ? '✅' : '❌'} | OTE scored: ${buyLeg.oteScored ? '✅' : '❌'}`);
            console.log(`      Puntos: ${buyLeg.chochPoints ?? 0}`);
        }
        if (sellLeg) {
            const legAge = sellLeg.createdAt ? Math.round((now - sellLeg.createdAt) / 60000) : 0;
            const range = sellLeg.extreme && sellLeg.origin ? Math.abs(sellLeg.extreme - sellLeg.origin) : 0;
            const oteLow = sellLeg.dir === 'SELL' ? sellLeg.extreme + (range * 0.50) : sellLeg.extreme - (range * 0.79);
            const oteHigh = sellLeg.dir === 'SELL' ? sellLeg.extreme + (range * 0.79) : sellLeg.extreme - (range * 0.50);
            console.log(`  🦵 IMPULSE SELL (${legAge}min):`);
            console.log(`      Origin: ${sellLeg.origin?.toFixed(5)} | Extreme: ${sellLeg.extreme?.toFixed(5)}`);
            console.log(`      Rango: ${range.toFixed(5)} | OTE: ${oteLow?.toFixed(5)} → ${oteHigh?.toFixed(5)}`);
            console.log(`      Validado: ${sellLeg.isValidated ? '✅' : '❌'} | OTE scored: ${sellLeg.oteScored ? '✅' : '❌'}`);
            console.log(`      Puntos: ${sellLeg.chochPoints ?? 0}`);
        }
        if (!buyLeg && !sellLeg) console.log(`  🦵 Sin impulse legs activos`);

        // Last Price
        console.log(`  💵 Last Price: ${radar.lastPrice ?? 'N/A'}`);
        console.log(`  🕐 Last Sniper Alert: ${radar.lastSniperAlert ? new Date(radar.lastSniperAlert).toISOString() : 'Nunca'}`);
        console.log(`  🕐 Last Sync: ${radar.lastSyncDate || 'Nunca'}`);

        // Active Trades
        const tradesSnap = await db.collection('active_trades').where('ticker', '==', ticker).get();
        if (!tradesSnap.empty) {
            console.log(`  📈 TRADES ACTIVOS: ${tradesSnap.size}`);
            for (const doc of tradesSnap.docs) {
                const t = doc.data();
                const age = Math.round((now - t.timestamp) / 60000);
                console.log(`      #${t.tradeId}: ${t.direction} @ ${t.entryPrice?.toFixed(5)} | TP1: ${t.tp1Hit ? '✅' : '⏳'} | TP2: ${t.tp2Hit ? '✅' : '⏳'} | ${age}min`);
            }
        } else {
            console.log(`  📈 Sin trades activos`);
        }
    }

    // Resumen global
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 RESUMEN GLOBAL`);
    console.log(`${'═'.repeat(70)}`);

    // Trading incoming pendientes
    const incomingSnap = await db.collection('trading_incoming').where('status', '==', 'pending').get();
    console.log(`  📨 Alertas pendientes: ${incomingSnap.size}`);

    // Config
    const configDoc = await db.collection('app_settings').doc('bot_config').get();
    if (configDoc.exists) {
        const cfg = configDoc.data() || {};
        console.log(`  ⚙️  Configuración:`);
        console.log(`      minPointsBuy: ${cfg.minPointsForBuy} | minPointsSell: ${cfg.minPointsForSell}`);
        console.log(`      sniperCooldownMs: ${cfg.sniperCooldownMs}ms (${Math.round(cfg.sniperCooldownMs / 1000)}s)`);
        console.log(`      baseRiskPercentage: ${cfg.baseRiskPercentage}%`);
    }

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
