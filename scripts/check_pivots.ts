import fs from 'fs';
import { parse } from 'csv-parse';
import { PivotEngine } from '../src/engine/smc/modules/pivots.js';

async function main() {
    const records = [];
    const parser = fs.createReadStream('/home/bon/Descargas/JARVIS/logs/history/history_M15.csv').pipe(parse({ columns: true, cast: true }));
    for await (const row of parser) {
        records.push({
            timestamp: Number(row.timestamp),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume) || 0
        });
    }

    let pivots = new PivotEngine(6, 6);
    let lastPH = null;
    for (let i = 0; i < records.length; i++) {
        const c = records[i];
        const p = pivots.nextCandle(c);
        if (p && p.type === 'High') {
            lastPH = p;
        }
        if (c.timestamp === 1784266200000) {
            console.log(`At 1784266200000, last PH was at ${lastPH?.timestamp} with High=${lastPH?.high}`);
        }
    }
}
main();
