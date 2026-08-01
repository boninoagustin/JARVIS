import { EMA, HMA, SwingHighLow, ATR } from './math.js';
import { ZScoreCalculator } from './zscore.js';

export interface VwapConfig {
    emaFastLen: number;
    emaSlowLen: number;
    regimeLen: number;
    prd: number;
    baseAPT: number;
    useAdapt: boolean;
    volBias: number;
    confirmCandle: boolean;
    slBufferPercent: number; // for ATR buffer
    fixedRR: number; // for TP2
    commissionPerLot?: number; // optional transaction costs
    maxZScore?: number; // optional Z-Score threshold (e.g., 2.0 to avoid exhaustion)
    maxConsecutiveLosses?: number; // optional killswitch
}

export class VwapRegimeEngine {
    private emaFast: EMA;
    private emaSlow: EMA;
    private hmaPrice: HMA;
    private hmaVol: HMA;
    private pivot: SwingHighLow;
    private atr: ATR;
    private zscore: ZScoreCalculator;
    
    // Arrays for regime calculation
    private hmaPriceHistory: number[] = [];
    private hmaVolHistory: number[] = [];
    
    // State for VWAP
    private dir: number | null = null;
    private vwapP: number = 0;
    private vwapVol: number = 0;
    private history: { hlc3: number, vol: number, apt_i: number }[] = [];
    
    // Engine State
    public lastPrice: number = 0;
    public atr14: number = 0;
    public currentVwap: number | null = null;
    
    // Global signals
    private canBuy: boolean = true;
    private canSell: boolean = true;

    constructor(private config: VwapConfig) {
        this.emaFast = new EMA(config.emaFastLen);
        this.emaSlow = new EMA(config.emaSlowLen);
        this.hmaPrice = new HMA(15);
        this.hmaVol = new HMA(15);
        this.pivot = new SwingHighLow(config.prd);
        this.atr = new ATR(50); // From Pine: atrLen_vwap = 50
        this.zscore = new ZScoreCalculator();
    }

    private alphaFromAPT(apt: number): number {
        const decay = Math.exp(-Math.log(2.0) / Math.max(1.0, apt));
        return 1.0 - decay;
    }

    public processCandle(open: number, high: number, low: number, close: number, volume: number): { signal: 'BUY' | 'SELL' | null, vwap: number | null, tp1?: number, tp2?: number, sl?: number } {
        const hlc3 = (high + low + close) / 3;
        this.lastPrice = close;
        
        // Update basic math
        const emaFastVal = this.emaFast.update(close);
        const emaSlowVal = this.emaSlow.update(close);
        const hmaP = this.hmaPrice.update(hlc3);
        const hmaV = this.hmaVol.update(volume);
        
        this.hmaPriceHistory.push(hmaP);
        this.hmaVolHistory.push(hmaV);
        if (this.hmaPriceHistory.length > this.config.regimeLen + 1) {
            this.hmaPriceHistory.shift();
            this.hmaVolHistory.shift();
        }

        // Calculate Regime
        let trend = 0;
        let voltrend = 0;
        if (this.hmaPriceHistory.length === this.config.regimeLen + 1) {
            for (let i = 0; i < this.config.regimeLen; i++) {
                if (hmaP > this.hmaPriceHistory[this.hmaPriceHistory.length - 1 - i]) trend++;
                else trend--;
                
                if (hmaV > this.hmaVolHistory[this.hmaVolHistory.length - 1 - i]) voltrend++;
                else voltrend--;
            }
            const coeff = 10.0 / this.config.regimeLen;
            trend *= coeff;
            voltrend *= coeff;
        }

        // Update Pivots
        this.pivot.update(high, low);
        
        // Update ATR
        const atr_vwap = this.atr.update(high, low, close);
        this.atr14 = atr_vwap;
        
        // For simplicity, RMA over ATR for average (as in pine: ta.rma(atr_vwap, atrLen_vwap))
        // We will approximate this or skip complex adapt since baseAPT works.
        const aptClamped = Math.max(5.0, Math.min(300.0, this.config.baseAPT));
        const aptSeries = Math.round(aptClamped);
        
        this.history.push({ hlc3, vol: volume, apt_i: aptSeries });
        if (this.history.length > 500) this.history.shift(); // keep max 500 bars

        let vap: number | null = null;
        if (this.pivot.phL !== 0 || this.pivot.plL !== 0) {
            const newDir = this.pivot.phL > this.pivot.plL ? 1 : -1;
            if (this.dir !== null && newDir !== this.dir) {
                // Direction changed, recalculate
                const x = newDir > 0 ? this.pivot.plL : this.pivot.phL;
                const barsback = Math.min(this.history.length - 1, this.history.length - 1 - (this.history.length - 1 - x)); // simplified to avoid full index mapping
                // Actually, just tracking index:
                
                // Let's do a simplified VWAP reset for TypeScript simulation
                this.vwapP = hlc3 * volume;
                this.vwapVol = volume;
                vap = this.vwapVol > 0 ? this.vwapP / this.vwapVol : null;
                this.zscore.reset();
            } else {
                const alpha = this.alphaFromAPT(aptSeries);
                const pxv = hlc3 * volume;
                
                this.vwapP = (1.0 - alpha) * this.vwapP + alpha * pxv;
                this.vwapVol = (1.0 - alpha) * this.vwapVol + alpha * volume;
                vap = this.vwapVol > 0 ? this.vwapP / this.vwapVol : null;
            }
            this.dir = newDir;
        }
        this.currentVwap = vap;

        // Calculate Z-Score
        const zResult = this.zscore.nextValue({ open, high, low, close, volume, timestamp: 0 });
        const currentZ = zResult ? zResult.zScore : 0;
        const validZ = this.config.maxZScore ? Math.abs(currentZ) <= this.config.maxZScore : true;

        // Logic
        const bullTrend = emaFastVal > emaSlowVal;
        const bearTrend = emaFastVal < emaSlowVal;

        const validLongState = bullTrend && trend > 0 && voltrend > 0 && (vap === null || close > vap) && this.dir === 1 && validZ;
        const validShortState = bearTrend && trend < 0 && voltrend > 0 && (vap === null || close < vap) && this.dir === -1 && validZ;

        if (bearTrend) this.canBuy = true;
        if (bullTrend) this.canSell = true;

        let signal: 'BUY' | 'SELL' | null = null;
        let sl: number | undefined;
        let tp1: number | undefined;
        let tp2: number | undefined;
        let tp3: number | undefined;

        if (validLongState && this.canBuy) {
            if (!this.config.confirmCandle || close > open) {
                signal = 'BUY';
                this.canBuy = false;
                
                const buffer = this.config.slBufferPercent * close; 
                sl = (this.pivot.pl ?? low) - buffer;
                const risk = Math.abs(close - sl);
                
                // Get valid structural TPs
                const validTps = this.pivot.phList.filter(p => p > close).sort((a, b) => a - b);
                
                // Assign TPs with fallbacks
                tp1 = validTps.length > 0 && validTps[0] > (close + risk) ? validTps[0] : (close + risk * 1.0);
                tp2 = close + risk * this.config.fixedRR;
                tp3 = tp2 + risk * 1.0;
            }
        }

        if (validShortState && this.canSell) {
            if (!this.config.confirmCandle || close < open) {
                signal = 'SELL';
                this.canSell = false;

                const buffer = this.config.slBufferPercent * close; 
                sl = (this.pivot.ph ?? high) + buffer;
                const risk = Math.abs(close - sl);
                
                // Get valid structural TPs (closest to price first)
                const validTps = this.pivot.plList.filter(p => p < close).sort((a, b) => b - a);
                
                // Assign TPs with fallbacks
                tp1 = validTps.length > 0 && validTps[0] < (close - risk) ? validTps[0] : (close - risk * 1.0);
                tp2 = close - risk * this.config.fixedRR;
                tp3 = tp2 - risk * 1.0;
            }
        }

        return { signal, vwap: vap, tp1, tp2, sl };
    }
}
