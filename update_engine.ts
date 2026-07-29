import * as fs from 'fs';

let content = fs.readFileSync('src/engine/smc/SMCEngine.ts', 'utf8');

// 1. Add prevVwapValue
content = content.replace('private lastVwapValue: number = 0;', 'private lastVwapValue: number = 0;\n    private prevVwapValue: number = 0;');
content = content.replace('this.lastVwapValue = this.vwap.nextValue(candle);', 'this.prevVwapValue = this.lastVwapValue;\n        this.lastVwapValue = this.vwap.nextValue(candle);');

// 2. Reorder fvgEvents to be before evaluateZones
content = content.replace(
`        const obEvents = this.orderBlocks.evaluateZones(candle, this.currentAtrValue, this.preset);
        events.push(...obEvents);`,
`        const fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...fvgEvents);

        const obEvents = this.orderBlocks.evaluateZones(candle, this.currentAtrValue, this.preset);
        events.push(...obEvents);`
);
content = content.replace(
`        const fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...fvgEvents);

        // Generate Legacy OBs on new FVGs`,
`        // Generate Legacy OBs on new FVGs`
);

// 3. Update obContext VWAP
content = content.replace(
`        const lastHl2 = (candle.high + candle.low) / 2;
        const obContext = {
            vwapStatus: this.lastVwapValue > 0 ? (lastHl2 > this.lastVwapValue ? 'OVER' : 'UNDER') : undefined,`,
`        const prevHl2 = this.previousCandle ? (this.previousCandle.high + this.previousCandle.low) / 2 : (candle.high + candle.low) / 2;
        const obContext = {
            vwapStatus: this.prevVwapValue > 0 ? (prevHl2 > this.prevVwapValue ? 'OVER' : 'UNDER') : undefined,`
);

fs.writeFileSync('src/engine/smc/SMCEngine.ts', content);
