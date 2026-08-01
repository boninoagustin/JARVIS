import fs from 'fs';
import path from 'path';
import { VwapRegimeEngine, VwapConfig } from './src/engine/vwap_regime/VwapRegimeEngine.js';

interface OHLCV {
    ts: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface SimulatedTrade {
    id: string;
    dir: 'BUY' | 'SELL';
    entryPrice: number;
    sl: number;
    originalSl: number;
    tp1: number;
    tp2: number;
    tp1Hit: boolean;
    tp2Hit: boolean;
    slHit: boolean;
    closed: boolean;
    pnl: number;
    ts: Date;
    riskAmount: number;
}

async function runBacktest(filename: string, timeframe: string) {
    const csvPath = path.join(process.cwd(), 'logs', 'history', filename);
    if (!fs.existsSync(csvPath)) {
        console.error(`No se encontró el archivo CSV: ${csvPath}`);
        return;
    }

    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');
    
    const candles: OHLCV[] = [];
    
    // Parsear el CSV de cTrader (timestamp,open,high,low,close,volume)
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const parts = line.split(',');
        if (parts.length >= 6) {
            const timestamp = parseInt(parts[0], 10);
            const ts = new Date(timestamp);
            const open = parseFloat(parts[1]);
            const high = parseFloat(parts[2]);
            const low = parseFloat(parts[3]);
            const close = parseFloat(parts[4]);
            const vol = parseFloat(parts[5]);
            
            if (!isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close) && !isNaN(vol)) {
                candles.push({ ts, open, high, low, close, volume: vol });
            }
        }
    }
    
    // Asegurar orden cronológico
    candles.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    console.log(`\n======================================================`);
    console.log(` Iniciando Backtest en ${timeframe} (${candles.length} velas) `);
    console.log(`======================================================`);

    const config: VwapConfig = {
        emaFastLen: 21,
        emaSlowLen: 50,
        regimeLen: 21,
        prd: 10,
        baseAPT: 10,
        useAdapt: false,
        volBias: 1,
        confirmCandle: true,
        slBufferPercent: 0.0005, // 5 pips approx for EURUSD
        fixedRR: 3.0
    };

    const engine = new VwapRegimeEngine(config);
    let activeTrades: SimulatedTrade[] = [];
    
    let balance = 10000;
    const initialBalance = balance;
    let maxBalance = initialBalance;
    let maxDrawdown = 0;
    
    let wins = 0;
    let partials = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    for (const candle of candles) {
        // Manage active trades FIRST with the candle highs/lows
        for (const trade of activeTrades) {
            if (trade.closed) continue;
            
            // SMC Trade Management Logic
            if (trade.dir === 'BUY') {
                if (candle.low <= trade.sl) {
                    trade.closed = true;
                    trade.slHit = true;
                    // Calculate PnL (lost -1R or breakeven)
                    let loss = trade.riskAmount;
                    balance -= loss;
                    
                    if (trade.tp1Hit) {
                        balance += loss; // breakeven
                        loss = 0;
                        partials++; // Count as partial win (hit TP1 but not TP2)
                    } else {
                        losses++;
                        grossLoss += loss;
                    }
                } else if (!trade.tp1Hit && candle.high >= trade.tp1) {
                    trade.tp1Hit = true;
                    trade.sl = trade.entryPrice; // Move SL to Breakeven
                    // Take Partial (half position)
                    const r_multiple = (trade.tp1 - trade.entryPrice) / (trade.entryPrice - trade.originalSl);
                    const profit = trade.riskAmount * r_multiple * 0.5;
                    balance += profit;
                    grossProfit += profit;
                } else if (trade.tp1Hit && !trade.tp2Hit && candle.high >= trade.tp2) {
                    trade.tp2Hit = true;
                    trade.closed = true;
                    const r_multiple = (trade.tp2 - trade.entryPrice) / (trade.entryPrice - trade.originalSl);
                    const profit = trade.riskAmount * r_multiple * 0.5;
                    balance += profit;
                    grossProfit += profit;
                    wins++;
                }
            } else {
                if (candle.high >= trade.sl) {
                    trade.closed = true;
                    trade.slHit = true;
                    let loss = trade.riskAmount;
                    balance -= loss;
                    if (trade.tp1Hit) {
                        balance += loss; // breakeven
                        loss = 0;
                        partials++; // Count as partial win
                    } else {
                        losses++;
                        grossLoss += loss;
                    }
                } else if (!trade.tp1Hit && candle.low <= trade.tp1) {
                    trade.tp1Hit = true;
                    trade.sl = trade.entryPrice; // BE
                    const r_multiple = (trade.entryPrice - trade.tp1) / (trade.originalSl - trade.entryPrice);
                    const profit = trade.riskAmount * r_multiple * 0.5;
                    balance += profit;
                    grossProfit += profit;
                } else if (trade.tp1Hit && !trade.tp2Hit && candle.low <= trade.tp2) {
                    trade.tp2Hit = true;
                    trade.closed = true;
                    const r_multiple = (trade.entryPrice - trade.tp2) / (trade.originalSl - trade.entryPrice);
                    const profit = trade.riskAmount * r_multiple * 0.5;
                    balance += profit;
                    grossProfit += profit;
                    wins++;
                }
            }
        }
        
        // Update Max Drawdown
        if (balance > maxBalance) {
            maxBalance = balance;
        }
        const drawdown = ((maxBalance - balance) / maxBalance) * 100;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
        }
        
        activeTrades = activeTrades.filter(t => !t.closed);

        // Process candle in engine to get new signals
        const result = engine.processCandle(candle.open, candle.high, candle.low, candle.close, candle.volume);
        
        if (result.signal) {
            const hasSameDir = activeTrades.some(t => t.dir === result.signal);
            if (!hasSameDir) {
                activeTrades.push({
                    id: Math.random().toString(),
                    dir: result.signal,
                    entryPrice: candle.close,
                    sl: result.sl!,
                    originalSl: result.sl!,
                    tp1: result.tp1!,
                    tp2: result.tp2!,
                    tp1Hit: false,
                    tp2Hit: false,
                    slHit: false,
                    closed: false,
                    pnl: 0,
                    ts: candle.ts,
                    riskAmount: balance * 0.01 // 1% of current balance
                });
            }
        }
    }

    const total = wins + partials + losses;
    const winRate = total > 0 ? ((wins + partials) / total) * 100 : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0);

    console.log(`Balance Inicial:   $${initialBalance}`);
    console.log(`Balance Final:     $${balance.toFixed(2)}`);
    console.log(`Total Trades:      ${total}`);
    console.log(`Ganados (Full TP2):${wins}`);
    console.log(`Ganados (Parcial): ${partials}`);
    console.log(`Perdidos (SL):     ${losses}`);
    console.log(`Win Rate Global:   ${winRate.toFixed(2)}% (Incluyendo parciales)`);
    console.log(`Profit Factor:     ${profitFactor.toFixed(2)}`);
    console.log(`Max Drawdown:      ${maxDrawdown.toFixed(2)}%`);
    console.log(`Gross Profit:      $${grossProfit.toFixed(2)}`);
    console.log(`Gross Loss:        $${grossLoss.toFixed(2)}`);
}

async function main() {
    await runBacktest('history_H1.csv', 'H1');
}

main().catch(console.error);
