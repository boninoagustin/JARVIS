import fs from 'fs';
import { parse } from 'csv-parse';

async function main() {
    const records = [];
    const parser = fs.createReadStream('/home/bon/Descargas/JARVIS/logs/history/history_M15.csv').pipe(parse({ columns: true, cast: true }));
    for await (const row of parser) {
        records.push({
            timestamp: Number(row.timestamp),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close)
        });
    }

    const t1 = 1784257200000;
    const t2 = 1784266200000;
    const idx1 = records.findIndex(r => r.timestamp === t1);
    const idx2 = records.findIndex(r => r.timestamp === t2);
    
    let minLow = Infinity;
    let minTs = 0;
    for (let idx = idx1; idx <= idx2; idx++) {
        if (records[idx].low < minLow) {
            minLow = records[idx].low;
            minTs = records[idx].timestamp;
        }
    }
    console.log(`Lowest Low between ${t1} and ${t2} is ${minLow} at ${minTs}`);
}
main();
