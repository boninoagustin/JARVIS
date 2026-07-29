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
        const state = engine.getState();
        const prevLength = state.activeOBs.length;
        engine.nextCandle(c);
        const newState = engine.getState();
        const newLength = newState.activeOBs.length;
        
        if (newLength > prevLength) {
            // Find newly added ones
            for (const ob of newState.activeOBs) {
                if (!state.activeOBs.find(o => o.timestamp === ob.timestamp && o.bottom === ob.bottom)) {
                    if (Math.abs(ob.top - 1.14392) < 0.0001 || Math.abs(ob.bottom - 1.1439) < 0.0005) {
                        console.log(`[${c.timestamp}] OB CREATED: ${ob.direction} T=${ob.top} B=${ob.bottom} (CandleTS: ${ob.timestamp})`);
                    }
                }
            }
        }
    }
}
main();
