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
                else if (!t2) { t2 = ts; break; }
            }
        }
        if (t1 && t2) {
            const diffMins = Math.round((t2 - t1) / 60000);
            let detectedTf = '';
            if (diffMins <= 20) detectedTf = '15';
            else if (diffMins <= 70) detectedTf = '60';
            else if (diffMins <= 300) detectedTf = '240';
            else detectedTf = 'D';
            if (detectedTf === tfStr) { selectedFile = fullPath; break; }
        }
    }
    if (!selectedFile) return [];
    
    console.log(`  TV OHLCV: ${path.basename(selectedFile)}`);
    const data = fs.readFileSync(selectedFile, 'utf-8').split('\n');
    const candles: OHLCV[] = [];
    for (const row of data) {
        if (!row.includes('OHLCV |')) continue;
        const [dateStr, ...rest] = row.split(',');
        let msg = rest.join(',').trim();
        if (msg.startsWith('"')) msg = msg.substring(1, msg.length - 1).replace(/""/g, '"');
        const parts = msg.split('|').map(s => s.trim());
        if (parts.length >= 6) {
            candles.push({
                timestamp: new Date(dateStr).getTime(),
                open: parseFloat(parts[1]), high: parseFloat(parts[2]),
                low: parseFloat(parts[3]), close: parseFloat(parts[4]), volume: parseFloat(parts[5])
            });
        }
    }
    return candles.sort((a, b) => a.timestamp - b.timestamp);
}

function loadPineLogsForTF(tfStr: string) {
    const dir = path.join('logs', 'estructura');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('pine-logs-SMC Master 5.2_'));
    let selectedFile: string | null = null;
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

    if (!selectedFile) return [];
    
    console.log(`  Pine logs: ${path.basename(selectedFile)}`);
    const data = fs.readFileSync(selectedFile, 'utf-8').split('\n');
    const events: { ts: number, prefix: string, dir: string }[] = [];
    
    for (const row of data) {
        const firstComma = row.indexOf(',');
        if (firstComma === -1) continue;
        const tsStr = row.substring(0, firstComma).trim();
        if (tsStr === 'Fecha') continue;
        
        const msg = row.substring(firstComma + 1).trim();
        const ts = new Date(tsStr).getTime();
        if (Number.isNaN(ts)) continue;
        
        if (msg.includes('EVENTO_BOS | BULLISH')) events.push({ ts, prefix: 'EVENTO_BOS', dir: 'BULLISH' });
        else if (msg.includes('EVENTO_BOS | BEARISH')) events.push({ ts, prefix: 'EVENTO_BOS', dir: 'BEARISH' });
        else if (msg.includes('EVENTO_CHOCH | BULLISH')) events.push({ ts, prefix: 'EVENTO_CHOCH', dir: 'BULLISH' });
        else if (msg.includes('EVENTO_CHOCH | BEARISH')) events.push({ ts, prefix: 'EVENTO_CHOCH', dir: 'BEARISH' });
    }
    
    return events.sort((a, b) => a.ts - b.ts);
}

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
    confirm_close: true
};

async function main() {
    let totalPine = 0;
    let totalEngine = 0;
    let totalMatch = 0;

    for (const target of TARGETS) {
        console.log(`\n==========================================`);
        console.log(`🚀 REPLAY STRUCTURE: TF ${target.tfStr}`);
        console.log(`==========================================`);

        const candles = loadTvHistory(target.tfStr);
        if (candles.length === 0) continue;
        let pineEvents = loadPineLogsForTF(target.tfStr);
        if (pineEvents.length === 0) continue;

        const startEvalTs = candles[Math.min(100, candles.length - 1)].timestamp;
        pineEvents = pineEvents.filter(e => e.ts >= startEvalTs);

        let periodEnum = 'M15';
        if (target.tfStr === '60') periodEnum = 'H1';
        if (target.tfStr === '240') periodEnum = 'H4';
        if (target.tfStr === 'D') periodEnum = 'D1';

        const engine = new SMCEngine(PRESET_ULTRA_AGRESIVO as any, periodEnum as any);
        let engineEvents: { ts: number, prefix: string, dir: string }[] = [];
        
        let prevCandleTs = 0;
        for (const candle of candles) {
            const events = engine.nextCandle(candle);
            for (const ev of events) {
                if (ev.type === 'EVENT_BOS' || ev.type === 'EVENT_CHOCH') {
                    engineEvents.push({ 
                        ts: candle.timestamp, 
                        prefix: ev.type === 'EVENT_BOS' ? 'EVENTO_BOS' : 'EVENTO_CHOCH',
                        dir: ev.direction === 'Bullish' ? 'BULLISH' : 'BEARISH'
                    });
                }
            }
        }
        
        // Matching Logic
        let matched = 0;
        let missed: { ts: number, prefix: string, dir: string }[] = [];
        let falsePositives: { ts: number, prefix: string, dir: string }[] = [];
        
        for (const pe of pineEvents) {
            // Pine events are timestamped on the open of the candle immediately following the break.
            // Our Engine evaluates on `candle`, and logs `candle.timestamp`.
            // Because TradingView assigns the open of the next candle, they might be offset by 1 TF exactly!
            // Let's just allow an offset of up to 2 * windowMs.
            let found = false;
            for (let i = 0; i < engineEvents.length; i++) {
                const ee = engineEvents[i];
                if (ee.prefix === pe.prefix && ee.dir === pe.dir) {
                    const diff = Math.abs(ee.ts - pe.ts);
                    if (diff <= target.windowMs * 2) {
                        found = true;
                        matched++;
                        // Remove to avoid double matching
                        engineEvents.splice(i, 1);
                        break;
                    }
                }
            }
            if (!found) missed.push(pe);
        }
        
        // Filter engineEvents that occurred before the first Pine event,
        // because PineScript might have started logging later due to 'log_start'
        const firstPineTs = pineEvents.length > 0 ? pineEvents[0].ts : 0;
        engineEvents = engineEvents.filter(ee => ee.ts >= firstPineTs);
        
        falsePositives = [...engineEvents];
        
        totalPine += pineEvents.length;
        totalEngine += (matched + falsePositives.length);
        totalMatch += matched;
        
        const recall = pineEvents.length > 0 ? (matched / pineEvents.length) * 100 : 0;
        const precision = (matched + falsePositives.length) > 0 ? (matched / (matched + falsePositives.length)) * 100 : 0;
        
        console.log(`  PINE: ${pineEvents.length} | ENGINE: ${matched + falsePositives.length} | MATCH: ${matched}`);
        console.log(`  RECALL: ${recall.toFixed(1)}% | PRECISION: ${precision.toFixed(1)}%`);
        
        if (missed.length > 0) {
            console.log(`  🔍 Missed: ${missed.length}`);
            missed.slice(0, 5).forEach(m => console.log(`     ${new Date(m.ts).toISOString()} ${m.prefix} ${m.dir}`));
        }
        
        if (falsePositives.length > 0) {
            console.log(`  ❌ False Positives: ${falsePositives.length}`);
            falsePositives.slice(0, 5).forEach(m => console.log(`     ${new Date(m.ts).toISOString()} ${m.prefix} ${m.dir}`));
        }
    }
    
    console.log(`\n==========================================`);
    console.log(`📊 GLOBAL STRUCTURE PARITY`);
    console.log(`==========================================`);
    const globalRecall = totalPine > 0 ? (totalMatch / totalPine) * 100 : 0;
    const globalPrecision = totalEngine > 0 ? (totalMatch / totalEngine) * 100 : 0;
    console.log(`TOTAL Pine=${totalPine} Engine=${totalEngine} Match=${totalMatch}`);
    console.log(`Global Recall:    ${globalRecall.toFixed(1)}%`);
    console.log(`Global Precision: ${globalPrecision.toFixed(1)}%`);
}
main();
