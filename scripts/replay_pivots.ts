import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { PivotEngine } from '../src/engine/smc/modules/pivots.js';
import { SMCPreset } from '../src/engine/smc/types.js';

interface OHLCV {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface NormEvent {
    ts: number;
    prefix: string;
    dir?: string;
}

const KNOWN_GAPS = new Set<string>([]);

const TARGETS = [
    { periodStr: '15 Minutos', tfStr: '15', windowMs: 15 * 60 * 1000, strBars: 5 },
    { periodStr: '1 Hora', tfStr: '60', windowMs: 60 * 60 * 1000, strBars: 5 },
    { periodStr: '4 Horas', tfStr: '240', windowMs: 4 * 60 * 60 * 1000, strBars: 6 }, // 4H usa 6 en el preset agresivo? Asumimos 5 por defecto
    { periodStr: 'Diario', tfStr: 'D', windowMs: 24 * 60 * 60 * 1000, strBars: 10 }
];

function loadTvHistory(tfStr: string): OHLCV[] {
    const logsDir = path.join(process.cwd(), 'logs');
    const files = fs.readdirSync(logsDir).filter(f => f.startsWith('pine-logs-Exportador'));
    let selectedFile: string | null = null;

    for (const file of files) {
        const fullPath = path.join(logsDir, file);
        const data = fs.readFileSync(fullPath, 'utf-8').split('\n');
        let t1 = 0, t2 = 0;
        for (const line of data) {
            if (line.includes('OHLCV |')) {
                const dateStr = line.split(',')[0];
                const ts = new Date(dateStr).getTime();
                if (!t1) t1 = ts;
                else if (!t2) {
                    t2 = ts;
                    break;
                }
            }
        }

        if (t1 && t2) {
            const diffMins = Math.round((t2 - t1) / 60000);
            let detectedTf = '';
            if (diffMins <= 20) detectedTf = '15';
            else if (diffMins <= 70) detectedTf = '60';
            else if (diffMins <= 300) detectedTf = '240';
            else detectedTf = 'D';

            if (detectedTf === tfStr) {
                selectedFile = fullPath;
                break;
            }
        }
    }

    if (!selectedFile) {
        return [];
    }

    console.log(`  TV OHLCV: ${path.basename(selectedFile)}`);
    const data = fs.readFileSync(selectedFile, 'utf-8').split('\n');
    const candles: OHLCV[] = [];

    for (const row of data) {
        if (!row.includes('OHLCV |')) continue;
        const [dateStr, ...rest] = row.split(',');
        let msg = rest.join(',').trim();
        if (msg.startsWith('"') && msg.endsWith('"')) {
            msg = msg.substring(1, msg.length - 1).replace(/""/g, '"');
        }

        const parts = msg.split('|').map(s => s.trim());
        if (parts.length >= 6) {
            candles.push({
                timestamp: new Date(dateStr).getTime(),
                open: parseFloat(parts[1]),
                high: parseFloat(parts[2]),
                low: parseFloat(parts[3]),
                close: parseFloat(parts[4]),
                volume: parseFloat(parts[5])
            });
        }
    }

    candles.sort((a, b) => a.timestamp - b.timestamp);
    return candles;
}

function loadPineLogsForTF(tfStr: string): NormEvent[] {
    const dir = path.join('logs', 'pivotes');
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(f => f.startsWith('pine-logs-SMC Master'));
    let selectedFile: string | null = null;
    
    // El formato en la carpeta es pine-logs-SMC Master_15M.csv, pine-logs-SMC Master_1H.csv, etc.
    let searchStr = '_' + tfStr;
    if (tfStr === '15') searchStr = '_15M';
    if (tfStr === '60') searchStr = '_1H';
    if (tfStr === '240') searchStr = '_4H';
    if (tfStr === 'D') searchStr = '_D';

    for (const f of files) {
        if (f.includes(searchStr)) {
            selectedFile = path.join(dir, f);
            break;
        }
    }

    const events: NormEvent[] = [];
    if (!selectedFile) return events;

    console.log(`  Pine logs: ${path.basename(selectedFile)}`);
    const data = fs.readFileSync(selectedFile, 'utf-8');

    for (const row of data.split('\n')) {
        const firstComma = row.indexOf(',');
        if (firstComma === -1) continue;

        const tsStr = row.substring(0, firstComma).trim();
        const msg = row.substring(firstComma + 1).trim();

        if (tsStr === 'Fecha') continue; // Header

        const ts = new Date(tsStr).getTime();
        if (Number.isNaN(ts)) continue;
        
        let prefix = '';
        if (msg.includes('PIVOT | HIGH')) {
            prefix = 'PIVOT_HIGH';
        } else if (msg.includes('PIVOT | LOW')) {
            prefix = 'PIVOT_LOW';
        } else {
            continue;
        }

        events.push({ ts, prefix });
    }
    events.sort((a, b) => a.ts - b.ts);
    return events;
}

async function runHarness() {
    let totalRecall: number[] = [];
    let totalPrecision: number[] = [];

    for (const target of TARGETS) {
        console.log(`\n==========================================`);
        console.log(`🚀 REPLAY PIVOTS: ${target.periodStr} (TF: ${target.tfStr})`);
        console.log(`==========================================`);

        const candles = loadTvHistory(target.tfStr);
        let pineEvents = loadPineLogsForTF(target.tfStr);

        if (candles.length === 0) { console.warn(`Sin velas para ${target.periodStr}. Skip.`); continue; }
        if (pineEvents.length === 0) { console.warn(`Sin logs Pine para TF ${target.tfStr}. Skip.`); continue; }

        // Start from April 30th for 15m, and Jan 1 for others (as user mentioned)
        const WARMUP_CANDLES = 100; // Only need leftLen+rightLen
        const startEvalTs = candles[Math.min(WARMUP_CANDLES, candles.length - 1)].timestamp;
        
        pineEvents = pineEvents.filter(e => e.ts >= startEvalTs);

        // PineScript uses dyn_str_bars depending on timeframe
        let strBars = target.strBars;
        if (target.tfStr === '15') strBars = 6;
        if (target.tfStr === '60') strBars = 8;
        if (target.tfStr === '240') strBars = 10;
        if (target.tfStr === 'D') strBars = 12;
        
        // Instanciar el PivotEngine
        const engine = new PivotEngine(strBars, strBars);
        const engineEvents: NormEvent[] = [];
        
        for (const candle of candles) {
            const pivot = engine.nextCandle(candle);
            if (pivot) {
                // TradingView evaluates at the close of the bar, assigning the open time of the NEXT bar to `time`.
                // In PivotEngine, the pivot is confirmed exactly when `candle` is processed.
                // `candle` is (rightLen + 1) candles ahead of the pivot. This matches PineScript's `time` on confirmation!
                engineEvents.push({ 
                    ts: candle.timestamp, 
                    prefix: pivot.type === 'High' ? 'PIVOT_HIGH' : 'PIVOT_LOW' 
                });
            }
        }

        const engineEventsEval = engineEvents.filter(e => e.ts >= startEvalTs);

        // Matching
        const engineMatched = new Array(engineEventsEval.length).fill(false);
        const perType: Record<string, { pine: number; engine: number; matched: number }> = {};

        const bucket = (p: string) => (perType[p] ??= { pine: 0, engine: 0, matched: 0 });
        for (const e of pineEvents) bucket(e.prefix).pine++;
        for (const e of engineEventsEval) bucket(e.prefix).engine++;

        const missSamples: Record<string, string[]> = {};

        for (const pe of pineEvents) {
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let i = 0; i < engineEventsEval.length; i++) {
                const ee = engineEventsEval[i];
                if (engineMatched[i] || ee.prefix !== pe.prefix) continue;

                const timeDiff = pe.ts - ee.ts;
                const dist = Math.abs(timeDiff);

                if (dist === 0 && dist < bestDist) { // Pivots MUST match exactly in time
                    bestDist = dist;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0) {
                engineMatched[bestIdx] = true;
                bucket(pe.prefix).matched++;
            } else {
                (missSamples[pe.prefix] ??= []).push(new Date(pe.ts).toISOString());
            }
        }

        // Reporte por tipo
        console.log(`\n  ${'TIPO'.padEnd(18)} ${'PINE'.padStart(6)} ${'ENGINE'.padStart(7)} ${'MATCH'.padStart(6)} ${'RECALL'.padStart(8)} ${'PRECISION'.padStart(10)}`);
        let sumPine = 0, sumEngine = 0, sumMatch = 0;
        const allPrefixes = [...Object.keys(perType)].sort();
        for (const p of allPrefixes) {
            const t = perType[p];
            const recall = t.pine > 0 ? t.matched / t.pine : 0;
            const precision = t.engine > 0 ? t.matched / t.engine : 0;
            console.log(`  ${p.padEnd(18)} ${String(t.pine).padStart(6)} ${String(t.engine).padStart(7)} ${String(t.matched).padStart(6)} ${(recall * 100).toFixed(1).padStart(6)}% ${(precision * 100).toFixed(1).padStart(8)}%`);
            sumPine += t.pine; sumMatch += t.matched;
            sumEngine += t.engine;
        }

        const overallRecall = sumPine > 0 ? sumMatch / sumPine : 0;
        const overallPrecision = sumEngine > 0 ? sumMatch / sumEngine : 0;
        console.log(`  ${'─'.repeat(60)}`);
        console.log(`  TOTAL                 Pine=${sumPine} Engine=${sumEngine} Match=${sumMatch} Recall=${(overallRecall * 100).toFixed(1)}% Precision=${(overallPrecision * 100).toFixed(1)}%`);
        totalRecall.push(overallRecall);
        totalPrecision.push(overallPrecision);

        // Muestras de misses
        for (const [p, samples] of Object.entries(missSamples)) {
            console.log(`  🔍 Misses ${p} (${samples.length}): ${samples.slice(0, 3).join(', ')}...`);
        }
        
        // Log engine false positives (engine logs that were not matched to any Pine log)
        const falsePositives = engineEventsEval.filter((_, i) => !engineMatched[i]);
        if (falsePositives.length > 0) {
             const limitedFP = falsePositives.slice(0, 3).map(e => new Date(e.ts).toISOString());
             console.log(`  ❌ Falsos Positivos (${falsePositives.length}): ${limitedFP.join(', ')}...`);
        }
    }

    console.log(`\n==========================================`);
    console.log(`📊 RESUMEN GLOBAL DE PIVOTS`);
    console.log(`==========================================`);
    const avgR = totalRecall.reduce((a, b) => a + b, 0) / totalRecall.length;
    const avgP = totalPrecision.reduce((a, b) => a + b, 0) / totalPrecision.length;
    console.log(`Recall promedio:    ${(avgR * 100).toFixed(1)}%`);
    console.log(`Precision promedio: ${(avgP * 100).toFixed(1)}%`);
}

runHarness().catch(console.error);
