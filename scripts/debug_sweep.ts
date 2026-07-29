import fs from 'fs';
import { OHLCV } from '../src/engine/smc/types';
import { SMCEngine } from '../src/engine/smc/SMCEngine';

const ohlcvText = fs.readFileSync('logs/pine-logs-Exportador OHLCV Gratis_be777.csv', 'utf8');
const lines = ohlcvText.split('\n').slice(1);

const engine = new SMCEngine('H1');
engine.setPreset({ 
    risk_level: 3, 
    str_bars: 10, // H1 usually has 10
    atr_length: 10,
    ob_vol_multiplier: 1.5,
    fvg_min_atr: 0.5
}); // Assuming default preset

for (const line of lines) {
    if (!line.trim()) continue;
    const [dateStr, _, open, high, low, close, vol] = line.split(/[|,]/).map(s => s.trim());
    const ts = new Date(dateStr).getTime();
    
    const candle: OHLCV = {
        timestamp: ts,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(vol)
    };
    
    const events = engine.nextCandle(candle);
    const dateLocal = new Date(dateStr).toISOString();
    
    if (dateLocal.includes('2026-02-01T22:00:00.000Z') || dateLocal.includes('2026-02-01T21:00:00.000Z')) {
        console.log(`\nCANDLE: ${dateLocal}`);
        console.log(`Candle OHLC: O:${open} H:${high} L:${low} C:${close}`);
        console.log(`Levels: `, (engine as any).liquidity.activeLevels.map((l: any) => ({ price: l.price, type: l.type })));
        console.log(`Macro Levels: `, (engine as any).liquidity.macroLevels.map((l: any) => ({ price: l.price, type: l.type, source: l.source })));
        console.log(`Events: `, events.filter((e: any) => e.type === 'EVENT_SWEEP'));
        console.log(`Pivots: `, engine.getState().pivotsLow.slice(-3).map(p => ({ price: p.price, broken: p.isBroken, ts: new Date(p.timestamp).toISOString() })));
    }
}
