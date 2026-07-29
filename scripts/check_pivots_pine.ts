import fs from 'fs';
import { parse } from 'csv-parse';

async function main() {
    const records = [];
    const parser = fs.createReadStream('/home/bon/Descargas/JARVIS/logs/history/history_M15.csv').pipe(parse({ columns: true, cast: true }));
    for await (const row of parser) {
        records.push({
            timestamp: Number(row.timestamp),
            high: Number(row.high),
            low: Number(row.low),
        });
    }

    const L = 6;
    for (let i = L; i < records.length - L; i++) {
        const c = records[i];
        let isHigh = true;
        for (let j = 1; j <= L; j++) {
            if (records[i-j].high > c.high) isHigh = false;
        }
        for (let j = 1; j <= L; j++) {
            if (records[i+j].high >= c.high) isHigh = false;
        }
        if (isHigh && c.timestamp >= 1784250000000 && c.timestamp <= 1784268900000) {
            console.log(`PINE PIVOT HIGH at ${c.timestamp}: ${c.high}`);
        }
    }
}
main();
