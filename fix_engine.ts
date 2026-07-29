import * as fs from 'fs';

let content = fs.readFileSync('src/engine/smc/SMCEngine.ts', 'utf8');

content = content.replace(
`        // 4. Order Blocks & Imbalances Update
        const obEvents = this.orderBlocks.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...obEvents);

        const fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset);
        events.push(...fvgEvents);`,
`        // 4. Order Blocks & Imbalances Update
        this.orderBlocks.updateHistory(candle);
        
        const fvgEvents = this.imbalances.processCandle(candle, this.currentAtrValue, this.preset);
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
        events.push(...obEvents);
        
        // Generate Structural OBs on BOS or CHoCH
        for (const ev of structEvents) {
            if (ev.type === 'EVENT_BOS' || ev.type === 'EVENT_CHOCH') {
                const newOBs = this.orderBlocks.createStructuralOB(ev, this.currentAtrValue, this.preset, obContext as any);
                events.push(...newOBs);
            }
        }
`
);

fs.writeFileSync('src/engine/smc/SMCEngine.ts', content);
