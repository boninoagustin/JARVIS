import fs from 'fs';
import path from 'path';
import { PivotEngine } from '../src/engine/smc/modules/pivots.js';

const TARGETS = [
    { tfStr: '60', windowMs: 60 * 60 * 1000 },
    { tfStr: '240', windowMs: 4 * 60 * 60 * 1000 },
    { tfStr: 'D', windowMs: 24 * 60 * 60 * 1000 }
];

// ... (loadTvHistory and loadPineLogsForTF copied from replay_pivots.ts) ...
function loadTvHistory(tfStr: string) {
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
    const data = fs.readFileSync(selectedFile, 'utf-8').split('\n');
    const candles: any[] = [];
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
                low: parseFloat(parts[3]), close: parseFloat(parts[4])
            });
        }
    }
    return candles.sort((a, b) => a.timestamp - b.timestamp);
}

function loadPineLogsForTF(tfStr: string) {
    const dir = path.join('logs', 'pivotes');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('pine-logs-SMC Master'));
    let selectedFile: string | null = null;
    let searchStr = '_' + tfStr;
    if (tfStr === '15') searchStr = '_15M';
    if (tfStr === '60') searchStr = '_1H';
    if (tfStr === '240') searchStr = '_4H';
    if (tfStr === 'D') searchStr = '_D';
    for (const f of files) { if (f.includes(searchStr)) { selectedFile = path.join(dir, f); break; } }
    if (!selectedFile) return [];
    const data = fs.readFileSync(selectedFile, 'utf-8').split('\n');
    const events: any[] = [];
    for (const row of data) {
        const firstComma = row.indexOf(',');
        if (firstComma === -1) continue;
        const tsStr = row.substring(0, firstComma).trim();
        if (tsStr === 'Fecha') continue;
        const msg = row.substring(firstComma + 1).trim();
        const ts = new Date(tsStr).getTime();
        if (Number.isNaN(ts)) continue;
        if (msg.includes('PIVOT | HIGH')) events.push({ ts, prefix: 'PIVOT_HIGH' });
        else if (msg.includes('PIVOT | LOW')) events.push({ ts, prefix: 'PIVOT_LOW' });
    }
    return events.sort((a, b) => a.ts - b.ts);
}

for (const target of TARGETS) {
    console.log(`Testing TF ${target.tfStr}`);
    const candles = loadTvHistory(target.tfStr);
    let pineEvents = loadPineLogsForTF(target.tfStr);
    const startEvalTs = candles[Math.min(100, candles.length - 1)].timestamp;
    pineEvents = pineEvents.filter((e: any) => e.ts >= startEvalTs);

    for (let strBars = 2; strBars <= 20; strBars++) {
        const engine = new PivotEngine(strBars, strBars);
        const engineEvents: any[] = [];
        for (const candle of candles) {
            const pivot = engine.nextCandle(candle);
            if (pivot) {
                const pineLogTs = pivot.timestamp + ((strBars + 1) * target.windowMs);
                engineEvents.push({ ts: pineLogTs, prefix: pivot.type === 'High' ? 'PIVOT_HIGH' : 'PIVOT_LOW' });
            }
        }
        
        let matched = 0;
        for (const pe of pineEvents) {
            for (let i = 0; i < engineEvents.length; i++) {
                if (engineEvents[i].prefix === pe.prefix && engineEvents[i].ts === pe.ts) {
                    matched++;
                    break;
                }
            }
        }
        if (matched > 0) {
            console.log(`  strBars ${strBars} -> Matches: ${matched} / ${pineEvents.length} (${(matched/pineEvents.length*100).toFixed(1)}%)`);
        }
    }
}
