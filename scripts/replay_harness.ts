import fs from 'fs';
import path from 'path';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';
import { OHLCV } from '../src/engine/smc/types.js';

const PINE_LOGS_DIR = path.join(process.cwd(), 'logs', 'eurusd', 'Nueva carpeta');

// 🆕 v2: comparación por TIPO DE EVENTO con ventana temporal ±1 vela.
// La v1 exigía strings idénticos (imposible: el feed de TV ≠ feed de cTrader)
// y excluía ZONE_* solo del lado del engine, inflando las diferencias.

const TARGETS = [
    { tfStr: '15', preset: 'Forex - 3. Balanceado', periodStr: 'M15', windowMs: 15 * 60_000 },
    { tfStr: '60', preset: 'Forex - 3. Balanceado', periodStr: 'H1', windowMs: 60 * 60_000 },
    { tfStr: '240', preset: 'Forex - 3. Balanceado', periodStr: 'H4', windowMs: 240 * 60_000 },
    { tfStr: 'D', preset: 'Forex - 3. Balanceado', periodStr: 'D1', windowMs: 24 * 3600_000 }
];

interface NormEvent { ts: number; prefix: string; dir: string; }

// Prefijos que el engine no puede emitir todavía (gaps conocidos, no bugs)
const KNOWN_GAPS = new Set(['SWEEP_BROKEN', 'DIV_BROKEN', 'EVENTO_SWEEP_TL']);

function enginePrefix(ev: any): string | null {
    switch (ev.type) {
        case 'EVENT_CHOCH': return 'EVENTO_CHOCH';
        case 'EVENT_BOS': return 'EVENTO_BOS';
        case 'EVENT_SWEEP': return ev.sweepType === 'LIQ_GRAB' ? 'LIQ_GRAB' : 'EVENTO_SWEEP';
        case 'EVENT_DIVERGENCE': return 'EVENTO_SMC_DIV';
        case 'ZONE_TOUCHED': return 'ZONE_TOUCHED';
        case 'ZONE_BROKEN': return 'ZONE_BROKEN';
        default: return null; // EVENT_OB_CREATED / EVENT_IFVG_CREATED no se loguean en Pine
    }
}

function loadTvHistory(tfStr: string): OHLCV[] {
    const filenameMap: Record<string, string> = { '15': 'OHLCV_M15.csv', '60': 'OHLCV_H1.csv', '240': 'OHLCV_H4.csv', 'D': 'OHLCV_D1.csv' };
    const selectedFile = path.join(PINE_LOGS_DIR, filenameMap[tfStr]);
    
    if (!fs.existsSync(selectedFile)) {
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
    const filenameMap: Record<string, string> = { '15': 'SMC_M15.csv', '60': 'SMC_H1.csv', '240': 'SMC_H4.csv', 'D': 'SMC_D1.csv' };
    const selectedFile = path.join(PINE_LOGS_DIR, filenameMap[tfStr]);

    const events: NormEvent[] = [];
    if (!fs.existsSync(selectedFile)) return events;

    console.log(`  Pine logs: ${path.basename(selectedFile)}`);
    const data = fs.readFileSync(selectedFile, 'utf-8');

    for (const row of data.split('\n')) {
        const firstComma = row.indexOf(',');
        if (firstComma === -1) continue;

        let msg = row.substring(firstComma + 1).trim();
        if (msg.startsWith('"') && msg.endsWith('"')) {
            msg = msg.substring(1, msg.length - 1);
        }
        msg = msg.replace(/""/g, '"');

        // Ignorar mensajes de estado, solo eventos
        if (msg.includes('SYNC_ZONES') || msg.includes('HEARTBEAT') || msg.includes('PING_PRICE')) continue;

        const tsMatch = msg.match(/TS:\s*(\d+)/);
        if (!tsMatch) continue;

        const prefix = msg.split('|')[0].trim();
        const dir = msg.match(/Dir:\s*(BUY|SELL)/i)?.[1]?.toUpperCase() ?? '';
        events.push({ ts: parseInt(tsMatch[1], 10), prefix, dir });
    }
    events.sort((a, b) => a.ts - b.ts);
    return events;
}

async function runHarness() {
    let totalRecall: number[] = [];
    let totalPrecision: number[] = [];

    for (const target of TARGETS) {
        console.log(`\n==========================================`);
        console.log(`🚀 REPLAY: ${target.periodStr} (TF: ${target.tfStr})`);
        console.log(`==========================================`);

        const candles = loadTvHistory(target.tfStr);
        let pineEvents = loadPineLogsForTF(target.tfStr);

        if (candles.length === 0) { console.warn(`Sin velas para ${target.periodStr}. Skip.`); continue; }
        if (pineEvents.length === 0) { console.warn(`Sin logs Pine para TF ${target.tfStr}. Skip.`); continue; }

        // Filtrar eventos de Pine que ocurrieron antes de que el motor "caliente" (500 velas)
        // TradingView provee data histórica oculta a los scripts para precargar pivots.
        // Nuestro engine arranca en frío con la primera vela.
        const WARMUP_CANDLES = 500;
        const startEvalTs = candles[Math.min(WARMUP_CANDLES, candles.length - 1)].timestamp;
        pineEvents = pineEvents.filter(e => e.ts >= startEvalTs);

        // Correr el engine y normalizar sus eventos
        const engine = new SMCEngine(target.preset, target.periodStr);
        const engineEvents: NormEvent[] = [];
        for (const candle of candles) {
            for (const ev of engine.nextCandle(candle)) {
                const prefix = enginePrefix(ev);
                if (!prefix) continue;
                const dir = ev.direction ? (ev.direction === 'Bullish' ? 'BUY' : 'SELL') : '';
                engineEvents.push({ ts: candle.timestamp, prefix, dir });
            }
        }

        const evTypesToEval = new Set(["EVENTO_BOS", "EVENTO_CHOCH", "ZONE_TOUCHED", "ZONE_BROKEN", "EVENTO_SWEEP", "LIQ_GRAB", "EVENTO_SMC_DIV"]);
        const pineEventsEval = pineEvents.filter(e => {
            if (target.tfStr !== '15' && e.ts < new Date('2026-03-01T00:00:00.000Z').getTime()) return false;
            return e.ts >= startEvalTs;
        });

        const engineEventsEval: NormEvent[] = engineEvents.filter(e => {
            if (target.tfStr !== '15' && e.ts < new Date('2026-03-01T00:00:00.000Z').getTime()) return false;
            return evTypesToEval.has(e.prefix) && e.ts >= startEvalTs;
        });

        // Matching greedy por (prefix, dir) dentro de ±1 vela
        const engineMatched = new Array(engineEventsEval.length).fill(false);
        const perType: Record<string, { pine: number; engine: number; matched: number }> = {};

        const bucket = (p: string) => (perType[p] ??= { pine: 0, engine: 0, matched: 0 });
        for (const e of pineEventsEval) bucket(e.prefix).pine++;
        for (const e of engineEventsEval) bucket(e.prefix).engine++;

        const missSamples: Record<string, string[]> = {};

        for (const pe of pineEventsEval) {
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let i = 0; i < engineEventsEval.length; i++) {
                const ee = engineEventsEval[i];
                if (engineMatched[i] || ee.prefix !== pe.prefix) continue;
                if (pe.dir && ee.dir && ee.dir !== pe.dir) continue;
                
                const timeDiff = pe.ts - ee.ts;
                if (ee.prefix === 'EVENTO_SMC_DIV') {
                    // PineScript logs divergence on the confirmation candle (t + strBars)
                    // We allow up to 12 candles of forward offset
                    const maxOffsetMs = target.windowMs * 12;
                    if (timeDiff >= 0 && timeDiff <= maxOffsetMs && timeDiff < bestDist) {
                        bestDist = timeDiff;
                        bestIdx = i;
                    }
                } else {
                    // Standard events (BOS, CHoCH, Sweeps) are logged in real-time or within 1 candle
                    const dist = Math.abs(timeDiff);
                    if (dist <= target.windowMs && dist < bestDist) { 
                        bestDist = dist; 
                        bestIdx = i; 
                    }
                }
            }
            if (bestIdx >= 0) {
                engineMatched[bestIdx] = true;
                bucket(pe.prefix).matched++;
            } else if (!KNOWN_GAPS.has(pe.prefix)) {
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
            const gapTag = KNOWN_GAPS.has(p) ? ' (gap conocido)' : '';
            console.log(`  ${p.padEnd(18)} ${String(t.pine).padStart(6)} ${String(t.engine).padStart(7)} ${String(t.matched).padStart(6)} ${(recall * 100).toFixed(1).padStart(6)}% ${(precision * 100).toFixed(1).padStart(8)}%${gapTag}`);
            if (!KNOWN_GAPS.has(p)) { sumPine += t.pine; sumMatch += t.matched; }
            sumEngine += t.engine;
        }

        const overallRecall = sumPine > 0 ? sumMatch / sumPine : 0;
        const overallPrecision = sumEngine > 0 ? sumMatch / sumEngine : 0;
        console.log(`  ${'─'.repeat(60)}`);
        console.log(`  TOTAL (sin gaps)      Pine=${sumPine} Engine=${sumEngine} Match=${sumMatch} Recall=${(overallRecall * 100).toFixed(1)}% Precision=${(overallPrecision * 100).toFixed(1)}%`);
        totalRecall.push(overallRecall);
        totalPrecision.push(overallPrecision);

        // Muestras de misses para inspección
        for (const [p, samples] of Object.entries(missSamples)) {
            console.log(`  🔍 Misses ${p} (${samples.length}): ${samples.slice(0, 3).join(', ')}...`);
        }
        
        const logPath = path.join(PINE_LOGS_DIR, `Engine_SMC_${target.periodStr}.csv`);
        fs.writeFileSync(logPath, engineEventsEval.map(e => `${new Date(e.ts).toISOString()},${e.prefix},${e.dir}`).join('\n'));
        console.log(`  Guardado: ${logPath}`);
    }

    console.log(`\n==========================================`);
    console.log(`📊 RESUMEN GLOBAL`);
    console.log(`==========================================`);
    const avgR = totalRecall.reduce((a, b) => a + b, 0) / totalRecall.length;
    const avgP = totalPrecision.reduce((a, b) => a + b, 0) / totalPrecision.length;
    console.log(`Recall promedio (¿cuánto del Pine detecta el engine?):    ${(avgR * 100).toFixed(1)}%`);
    console.log(`Precision promedio (¿cuánto del engine es señal real?): ${(avgP * 100).toFixed(1)}%`);
}

runHarness().catch(console.error);
