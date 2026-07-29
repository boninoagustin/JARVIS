import * as fs from 'fs';

let content = fs.readFileSync('src/engine/smc/SMCEngine.ts', 'utf8');

// 1. Add fields
content = content.replace(
    'private currentAtrValue: number = 0;',
`    private currentAtrValue: number = 0;
    private lastVwapValue: number = 0;
    private prevVwapValue: number = 0;
    private lastZScoreUp: number | null = null;
    private lastZScoreDn: number | null = null;
    
    private htfTrend: string = 'Neutral';
    private weeklyBias: string = 'Neutral';
    private simpleTrend: string = 'Neutral';
    private pivotEngine33: PivotEngine;
    private lastPivotHigh33: number = NaN;
    private lastPivotLow33: number = NaN;`
);

// 2. Add constructor init
content = content.replace(
    'this.pivots = new PivotEngine(5, 5);',
`    this.pivots = new PivotEngine(5, 5);
        this.pivotEngine33 = new PivotEngine(3, 3);`
);

// 3. Add setHTFContext
content = content.replace(
    'public setPreset(presetName: string) {',
`    public setHTFContext(htfTrend: string, weeklyBias: string) {
        this.htfTrend = htfTrend;
        this.weeklyBias = weeklyBias;
    }

    public setPreset(presetName: string) {`
);

// 4. Update getState
content = content.replace(
    'this.state.currentTrend = this.structure.currentTrend;',
`        this.state.currentTrend = this.structure.currentTrend;
        this.state.simpleTrend = this.simpleTrend;`
);

// 5. Update nextCandle for math updates
content = content.replace(
    'this.vwap.nextValue(candle);',
`this.prevVwapValue = this.lastVwapValue;
        this.lastVwapValue = this.vwap.nextValue(candle);`
);
content = content.replace(
    'this.zscore.nextValue(candle.close);',
`const zs = this.zscore.nextValue(candle);
        if (zs) {
            this.lastZScoreUp = zs.zUp;
            this.lastZScoreDn = zs.zDn;
        }`
);

// 6. Add Pivot33 update
content = content.replace(
    '        // 3. Market Structure Update',
`        // 2.1 Simple Trend Update
        const pivot33 = this.pivotEngine33.nextCandle(candle);
        if (pivot33) {
            if (pivot33.type === 'High') this.lastPivotHigh33 = pivot33.price;
            else this.lastPivotLow33 = pivot33.price;
            
            if (!Number.isNaN(this.lastPivotHigh33) && !Number.isNaN(this.lastPivotLow33)) {
                if (candle.close > this.lastPivotHigh33) this.simpleTrend = 'Bullish';
                else if (candle.close < this.lastPivotLow33) this.simpleTrend = 'Bearish';
            }
        }

        // 3. Market Structure Update`
);

// 7. Reorder imbalances and obContext
content = content.replace(
`        const obContext = {
            vwapStatus: this.lastVwapValue > 0 ? (lastHl2 > this.lastVwapValue ? 'OVER' : 'UNDER') : undefined,
            currentTrend: this.structure.currentTrend,
            simpleTrend: this.simpleTrend,
        };

        const obEvents = this.orderBlocks.evaluateZones(candle, this.currentAtrValue, this.preset);
        events.push(...obEvents);

        const fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...fvgEvents);`,
`        const fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...fvgEvents);

        const prevHl2 = this.previousCandle ? (this.previousCandle.high + this.previousCandle.low) / 2 : (candle.high + candle.low) / 2;
        const zScoreObj = this.lastZScoreUp !== null && this.lastZScoreDn !== null 
            ? { zUp: this.lastZScoreUp, zDn: this.lastZScoreDn } 
            : null;
            
        const obContext = {
            vwapStatus: this.prevVwapValue > 0 ? (prevHl2 > this.prevVwapValue ? 'OVER' : 'UNDER') : undefined,
            currentTrend: this.structure.currentTrend,
            simpleTrend: this.simpleTrend,
            hasIFVGOverlap: (top: number, bottom: number) => this.imbalances.activeFVGs.some(
                f => f.is_ifvg && !(top < f.bottom || bottom > f.top)
            ),
            zScore: zScoreObj,
            htfTrend: this.htfTrend,
            weeklyBias: this.weeklyBias,
            htfAligned: (isBull: boolean) => {
                const targetDir = isBull ? 'Bullish' : 'Bearish';
                const isHtf2 = this.htfTrend === targetDir;
                const isWBias = this.weeklyBias === targetDir;
                
                if (['H1', 'H4', 'D1', 'W1'].includes(this.period)) {
                    return isHtf2 || isWBias;
                } else {
                    return isHtf2;
                }
            }
        };

        const obEvents = this.orderBlocks.evaluateZones(candle, this.currentAtrValue, this.preset);
        events.push(...obEvents);`
);

fs.writeFileSync('src/engine/smc/SMCEngine.ts', content);
