import fs from 'fs';
import path from 'path';
import { PivotEngine } from '../src/engine/smc/modules/pivots.js';

const target = { periodStr: '15 Minutos', tfStr: '15', windowMs: 15 * 60 * 1000, strBars: 5 };

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
            if (diffMins <= 20 && tfStr === '15') selectedFile = fullPath;
        }
    }
    const data = fs.readFileSync(selectedFile!, 'utf-8').split('\n');
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

const candles = loadTvHistory('15');
const engine = new PivotEngine(5, 5);

console.log("Looking for price 1.17244...");
for (const candle of candles) {
    if (candle.low === 1.17244) {
        console.log(`Candle with low 1.17244 is at: ${new Date(candle.timestamp).toISOString()}`);
    }
    const pivot = engine.nextCandle(candle);
    if (pivot && pivot.price === 1.17244) {
        console.log(`Pivot detected! Confirmed at candle: ${new Date(candle.timestamp).toISOString()}`);
        console.log(`Pivot originally happened at: ${new Date(pivot.timestamp).toISOString()}`);
        break;
    }
}
