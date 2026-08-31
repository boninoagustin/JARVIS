// smoke_bt.ts — backtest de humo post-cambio (buffer de fricción en BE)
// Correr: npx tsx scripts/smoke_bt.ts EURUSD
import { runBacktest, prepareEntries } from '../jarvis-os/src/services/backtestEngine';
import fs from 'fs';
import path from 'path';

const ticker = (process.argv[2] || 'EURUSD').toUpperCase();

async function main() {
    const dir = path.join('/opt/JARVIS', 'logs', ticker.toLowerCase(), 'history_exported');
    const logs = new Map<string, string[]>();
    for (const tf of ['M15', 'M5']) {
        const f = path.join(dir, `pine-logs-SMC Master_${tf}.csv`);
        if (!fs.existsSync(f)) continue;
        logs.set(tf, fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().length > 0));
    }
    if (logs.size === 0) { console.log('sin CSVs'); return; }

    const config: any = {
        ticker,
        minBuyPoints: 4, minSellPoints: 4,
        sessions: {
            LONDON: { choch15m: { enabled: true, minScore: 8 }, bos15m: { enabled: true, minScore: 8 }, choch5m: { enabled: true, minScore: 8 }, bos5m: { enabled: true, minScore: 8 } },
            NY: { choch15m: { enabled: true, minScore: 8 }, bos15m: { enabled: true, minScore: 8 }, choch5m: { enabled: true, minScore: 8 }, bos5m: { enabled: true, minScore: 8 } },
            ASIA: { choch15m: { enabled: true, minScore: 8 }, bos15m: { enabled: true, minScore: 8 }, choch5m: { enabled: true, minScore: 8 }, bos5m: { enabled: true, minScore: 8 } },
            OFF: { choch15m: { enabled: true, minScore: 8 }, bos15m: { enabled: true, minScore: 8 }, choch5m: { enabled: true, minScore: 8 }, bos5m: { enabled: true, minScore: 8 } },
        },
        sessionFilter: ['LONDON', 'NY', 'ASIA', 'OFF'],
        minimal_roi: { "0": 0.015, "30": 0.005, "60": 0 },
        slAfterTp1: 'breakeven',
        tp15BeEnabled: true,
        atrTrailEnabled: true,
        structuralTrailEnabled: true,
    };

    const prepared = await prepareEntries(logs);
    const res: any = runBacktest(logs, config, undefined, prepared);
    const trades: any[] = res.trades ?? [];
    console.log(`\n${ticker}: ${trades.length} trades | netR=${(res.metrics?.netR ?? res.metrics?.pnlR ?? '?')}`);

    // Verificar BE con buffer: SL != entry exacto en los trades que aplicaron roiDecay breakeven o cerraron BE
    const bes = trades.filter((t: any) => Math.abs(t.rMultiple ?? 1) < 0.02 && t.slPrice !== undefined);
    const examples = bes.slice(0, 5).map((t: any) => ({
        dir: t.direction, entry: t.entryPrice, sl: t.slPrice,
        diffPips: Math.abs(t.slPrice - t.entryPrice) / 0.0001,
    }));
    console.log('BE trades:', bes.length, '| ejemplos entry→sl:', JSON.stringify(examples, null, 1));
    if (bes.length > 0 && bes.every((t: any) => t.slPrice !== t.entryPrice)) {
        console.log('✅ buffer aplicado: ningún SL de BE quedó clavado en el entry');
    } else if (bes.length > 0) {
        console.log('⚠️ hay SL de BE exactamente en el entry — revisar');
    } else {
        console.log('(sin trades BE en esta corrida — no concluyente)');
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
