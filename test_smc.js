import fs from 'fs';
import { parse } from 'csv-parse';
import { SMCEngine } from './src/engine/smc/SMCEngine.js';
async function main() {
    const records = [];
    const parser = fs.createReadStream('/home/bon/Descargas/JARVIS/logs/history/history_M15.csv').pipe(parse({ columns: ['timestamp', 'open', 'high', 'low', 'close', 'volume'], cast: true }));
    for await (const row of parser) {
        records.push({
            timestamp: Number(row.timestamp),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume)
        });
    }
    const engine = new SMCEngine('Forex - 3. Balanceado', '15m');
    engine.setHTFContext('SELL', 'SELL');
    for (let i = 0; i < records.length; i++) {
        const c = records[i];
        if (Number.isNaN(c.timestamp))
            continue; // skip header if parsed wrong
        engine.nextCandle(c);
        if (c.timestamp === 1784268900000) {
            console.log(`ZONES AT 1784268900000:`);
            const zones = engine.orderBlocks.activeOBs;
            console.log(JSON.stringify(zones, null, 2));
            break;
        }
    }
}
main();
