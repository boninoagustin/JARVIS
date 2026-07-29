import fs from 'fs';
import { parse } from 'csv-parse';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';

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

    let engine = new SMCEngine('Forex - 3. Balanceado', '15');
    
    for (let i = 0; i < records.length; i++) {
        const c = records[i];
        engine.nextCandle(c);
        
        if (c.timestamp === 1784266200000 || c.timestamp === 1784267100000 || c.timestamp === 1784268000000 || c.timestamp === 1784268900000) {
            console.log(`[${c.timestamp}] Z-Up: ${(engine as any).lastZScoreUp}, Z-Dn: ${(engine as any).lastZScoreDn}`);
        }
    }
}
main();
