import fs from 'fs';
function parseOHLCV(line: string, tf: string, windowMs: number): any {
    const p = line.split(',');
    if (p.length < 2) return null;
    const timestamp = new Date(p[0]).getTime();
    if (isNaN(timestamp)) return null;
    const parts = p[1].split(' | ');
    if (parts.length < 5) return null;
    return {
        timestamp,
        date: new Date(timestamp).toISOString(),
        open: parseFloat(parts[1]),
        high: parseFloat(parts[2]),
        low: parseFloat(parts[3]),
        close: parseFloat(parts[4]),
        volume: parseFloat(parts[5] || '0')
    };
}

const file = fs.readFileSync('logs/pine-logs-Exportador OHLCV Gratis_be777.csv', 'utf-8');
const lines = file.split('\n');

for (let i = 490; i < 520; i++) {
    const candle = parseOHLCV(lines[i], 'H1', 3600000);
    if (candle) console.log(candle.date, 'Low:', candle.low);
}
