import fs from 'fs';
import path from 'path';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';
import { OHLCV, SMCEvents } from '../src/engine/smc/types.js';

const TARGETS = [
    { tfStr: '15', windowMs: 15 * 60 * 1000 },
    { tfStr: '60', windowMs: 60 * 60 * 1000 },
    { tfStr: '240', windowMs: 4 * 60 * 60 * 1000 },
    { tfStr: 'D', windowMs: 24 * 60 * 60 * 1000 }
];

const CANDLE_FILES: Record<string, string> = {
    '15M': 'logs/eurusd/history/history_M15.csv',
    '1H':  'logs/eurusd/history/history_H1.csv',
    '4H':  'logs/eurusd/history/history_H4.csv',
    'D':   'logs/eurusd/history/history_D1.csv'
};

const SWEEP_FILES: Record<string, string> = {
    '15M': 'logs/estructura/pine-logs-SMC Master 5.2_15M.csv',
    '1H': 'logs/estructura/pine-logs-SMC Master 5.2_1H.csv',
    '4H': 'logs/estructura/pine-logs-SMC Master 5.2_4H.csv',
    'D': 'logs/estructura/pine-logs-SMC Master 5.2_D.csv',
};

const PRESET_ULTRA_AGRESIVO = {
    risk_level: 3,
    strict_sweeps: false,
    require_fvg_after_ob: false,
    choch_requires_sweep: false,
    bos_requires_sweep: false,
    choch_requires_mom: false,
    bos_requires_mom: false,
    use_body_for_ob: true,
    min_ob_body_pct: 0.1,
    fvg_min_atr_mult: 0.0,
    displ_atr_mult: 0.0,
    vol_climax_mult: 1.5,
    rsi_extreme: 30,
    zscore_thresh: 1.5,
    confirm_close: true,
    crt_3candle_model: true,
    crt_close_inside: false,
    min_sweep_wick_pct: 0.5
};

async function main() {
    let totalPine = 0;
    let totalEngine = 0;
    let totalMatches = 0;

    for (const [tfStr, candleFile] of Object.entries(CANDLE_FILES)) {
        if (!fs.existsSync(candleFile)) {
            console.error(`Missing candle file for ${tfStr}`);
            continue;
        }
        
        const cLines = fs.readFileSync(candleFile, 'utf-8').split('\n');
        const candles: OHLCV[] = [];
        const isHistory = candleFile.includes('/history/');
        for (const line of cLines) {
            if (line.trim() === '' || line.startsWith('timestamp')) continue;
            
            if (isHistory) {
                const parts = line.split(',');
                candles.push({
                    timestamp: parseInt(parts[0], 10),
                    open: parseFloat(parts[1]),
                    high: parseFloat(parts[2]),
                    low: parseFloat(parts[3]),
                    close: parseFloat(parts[4]),
                    volume: parseFloat(parts[5] || '0')
                });
            } else {
                if (!line.includes('OHLCV |')) continue;
                const parts = line.split(',');
                const dateStr = parts[0];
                const dataParts = parts[1].split('|').map(s => s.trim());
                candles.push({
                    timestamp: new Date(dateStr).getTime(),
                    open: parseFloat(dataParts[1]),
                    high: parseFloat(dataParts[2]),
                    low: parseFloat(dataParts[3]),
                    close: parseFloat(dataParts[4]),
                    volume: parseFloat(dataParts[5] || '0')
                });
            }
        }
        candles.sort((a, b) => a.timestamp - b.timestamp);

        let pineEvents: { ts: number, prefix: string, dir: string }[] = [];
        const sweepFile = SWEEP_FILES[tfStr];
        if (fs.existsSync(sweepFile)) {
            const eLines = fs.readFileSync(sweepFile, 'utf-8').split('\n');
            for (const line of eLines) {
                if (line.includes('EVENTO_SWEEP')) {
                    const dateStr = line.split(',')[0];
                    const msg = line.split(',')[1] || '';
                    if (msg.includes('BULLISH')) {
                        pineEvents.push({ ts: new Date(dateStr).getTime(), prefix: 'EVENTO_SWEEP', dir: 'BULLISH' });
                    } else if (msg.includes('BEARISH')) {
                        pineEvents.push({ ts: new Date(dateStr).getTime(), prefix: 'EVENTO_SWEEP', dir: 'BEARISH' });
                    }
                }
            }
        }
        pineEvents.sort((a, b) => a.ts - b.ts);

        let periodEnum = tfStr;
        if (tfStr === '60') periodEnum = 'H1';
        if (tfStr === '240') periodEnum = 'H4';
        if (tfStr === 'D') periodEnum = 'D1';

        const engine = new SMCEngine(PRESET_ULTRA_AGRESIVO as any, periodEnum as any);
        let engineEvents: { ts: number, prefix: string, dir: string }[] = [];
        
        for (const candle of candles) {
            const events = engine.nextCandle(candle);
            for (const ev of events) {
                if (ev.type === 'EVENT_SWEEP') {
                    engineEvents.push({ 
                        ts: candle.timestamp, 
                        prefix: 'EVENTO_SWEEP',
                        dir: ev.direction === 'Bullish' ? 'BULLISH' : 'BEARISH'
                    });
                }
            }
        }

        const startEvalTs = candles[Math.min(100, candles.length - 1)]?.timestamp || 0;
        pineEvents = pineEvents.filter(e => e.ts >= startEvalTs);
        
        const firstPineTs = pineEvents.length > 0 ? pineEvents[0].ts : 0;
        engineEvents = engineEvents.filter(ee => ee.ts >= firstPineTs);
        
        let matches = 0;
        let missed = [];
        let falsePositives = [];

        for (const pe of pineEvents) {
            const idx = engineEvents.findIndex(ee => Math.abs(ee.ts - pe.ts) <= 60000 && ee.prefix === pe.prefix && ee.dir === pe.dir);
            if (idx !== -1) {
                matches++;
                engineEvents.splice(idx, 1); // remove found
            } else {
                missed.push(pe);
            }
        }
        
        falsePositives = [...engineEvents];
        
        totalPine += pineEvents.length;
        totalEngine += (matches + falsePositives.length);
        totalMatches += matches;

        console.log(`\n=== RESULTS FOR ${tfStr} ===`);
        console.log(`  PINE: ${pineEvents.length} | ENGINE: ${matches + falsePositives.length} | MATCH: ${matches}`);
        const recall = pineEvents.length ? (matches / pineEvents.length) * 100 : 0;
        const precision = (matches + falsePositives.length) ? (matches / (matches + falsePositives.length)) * 100 : 0;
        console.log(`  RECALL: ${recall.toFixed(1)}% | PRECISION: ${precision.toFixed(1)}%`);

        if (missed.length > 0) {
            console.log(`  🔍 Missed: ${missed.length}`);
            missed.slice(0, 5).forEach(m => console.log(`     ${new Date(m.ts).toISOString()} ${m.prefix} ${m.dir}`));
        }
        if (falsePositives.length > 0) {
            console.log(`  ❌ False Positives: ${falsePositives.length}`);
            falsePositives.slice(0, 5).forEach(fp => console.log(`     ${new Date(fp.ts).toISOString()} ${fp.prefix} ${fp.dir}`));
        }
    }
}

main().catch(console.error);
