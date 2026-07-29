import fs from 'fs';
import { parse } from 'csv-parse';

async function main() {
    const records = [];
    const parser = fs.createReadStream('/home/bon/Descargas/JARVIS/logs/history/history_M15.csv').pipe(parse({ columns: true, cast: true }));
    for await (const row of parser) {
        records.push({
            timestamp: Number(row.timestamp),
            low: Number(row.low),
        });
    }

    let minLow = Infinity;
    let minTs = 0;
    for (let i = 0; i < records.length; i++) {
        const c = records[i];
        if (c.timestamp >= 1784257200000 && c.timestamp <= 1784266200000) {
            if (c.low < minLow) {
                minLow = c.low;
                minTs = c.timestamp;
            }
        }
    }
    console.log(`Min Low between 1784257200000 and 1784266200000: ${minLow} at ${minTs}`);
}
main();
