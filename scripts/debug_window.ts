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
    console.log(`Loaded ${records.length} candles.`);

    let engine = new SMCEngine('Forex - 3. Balanceado', '15');

    for (let i = 0; i < records.length; i++) {
        const c = records[i];
        const events = engine.nextCandle(c);
        
        for (const ev of events) {
            if (ev.type === 'EVENT_CHOCH' && ev.direction === 'Bullish' && Math.abs(ev.price - 1.14418) < 0.0001) {
                console.log(`\n--- CHOCH BUY AT 1.14418 (candle TS=${c.timestamp}) ---`);
                console.log(`OriginTs: ${ev.originTs}`);
                console.log(`ExtremeTs: ${ev.extremeTs}`);
                
                // Find window
                const originCandle = engine.orderBlocks.history.find(hc => hc.timestamp === ev.originTs);
                if (originCandle) {
                    console.log(`Origin Candle: O=${originCandle.open} H=${originCandle.high} L=${originCandle.low} C=${originCandle.close}`);
                } else {
                    console.log(`Origin Candle not found in history!`);
                }
                
                // Find the OB loop
                const breakIdx = engine.orderBlocks.history.findIndex(hc => hc.timestamp === c.timestamp);
                const extremeIdx = engine.orderBlocks.history.findIndex(hc => hc.timestamp === ev.originTs);
                
                console.log(`BreakIdx: ${breakIdx}, ExtremeIdx (Origin): ${extremeIdx}`);
                const searchStart = Math.max(0, extremeIdx - 5);
                for (let j = extremeIdx; j >= searchStart; j--) {
                    const hc = engine.orderBlocks.history[j];
                    const isOpposite = hc.close < hc.open;
                    console.log(`OB cand cand[${j}]: TS=${hc.timestamp} O=${hc.open} C=${hc.close} Vol=${hc.volume} isOpposite=${isOpposite}`);
                }
            }
        }
    }
}
main();
