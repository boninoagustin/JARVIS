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

function runBacktestWithConfig(candles: OHLCV[], config: VwapConfig, ticker: string = 'EURUSD') {
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

    let consecutiveLosses = 0;
    let killswitchUntil = 0;

    for (const candle of candles) {
        for (const trade of activeTrades) {
            if (trade.closed) continue;

            if (trade.dir === 'BUY') {
                if (candle.low <= trade.sl) {
                    trade.closed = true;
                    trade.slHit = true;
                    let loss = trade.riskAmount;
                    balance -= loss;

                    if (trade.tp1Hit) {
                        balance += loss; 
                        loss = 0;
                        partials++; 
                        consecutiveLosses = 0;
                        consecutiveLosses = 0;
                    } else {
                        losses++;
                        grossLoss += loss;
                        consecutiveLosses++;
                        if (config.maxConsecutiveLosses && consecutiveLosses >= config.maxConsecutiveLosses) {
                            const nextDay = new Date(candle.ts);
                            nextDay.setUTCHours(24, 0, 0, 0);
                            killswitchUntil = nextDay.getTime();
                        }
                    }
                } else if (!trade.tp1Hit && candle.high >= trade.tp1) {
                    trade.tp1Hit = true;
                    trade.sl = trade.entryPrice; 
                    const r_multiple = (trade.tp1 - trade.entryPrice) / (trade.entryPrice - trade.originalSl);
                    const profit = trade.riskAmount * r_multiple * 0.5;
                    balance += profit;
                    grossProfit += profit;
                    consecutiveLosses = 0;
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
                        balance += loss; 
                        loss = 0;
                        partials++; 
                        consecutiveLosses = 0;
                        consecutiveLosses = 0;
                    } else {
                        losses++;
                        grossLoss += loss;
                        consecutiveLosses++;
                        if (config.maxConsecutiveLosses && consecutiveLosses >= config.maxConsecutiveLosses) {
                            const nextDay = new Date(candle.ts);
                            nextDay.setUTCHours(24, 0, 0, 0);
                            killswitchUntil = nextDay.getTime();
                        }
                    }
                } else if (!trade.tp1Hit && candle.low <= trade.tp1) {
                    trade.tp1Hit = true;
                    trade.sl = trade.entryPrice; 
                    const r_multiple = (trade.entryPrice - trade.tp1) / (trade.originalSl - trade.entryPrice);
                    const profit = trade.riskAmount * r_multiple * 0.5;
                    balance += profit;
                    grossProfit += profit;
                    consecutiveLosses = 0;
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

        if (balance > maxBalance) {
            maxBalance = balance;
        }
        const drawdown = ((maxBalance - balance) / maxBalance) * 100;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
        }

        activeTrades = activeTrades.filter(t => !t.closed);

        const result = engine.processCandle(candle.open, candle.high, candle.low, candle.close, candle.volume);

        // Killzone Logic (e.g. 07:00 to 16:00 UTC for EURUSD)
        const hour = candle.ts.getUTCHours();
        const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
        const isInKillzone = isCrypto ? true : (hour >= 7 && hour <= 16);

        if (result.signal && candle.ts.getTime() >= killswitchUntil && isInKillzone) {
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
                    riskAmount: balance * 0.01 
                });
            }
        }
    }

    const total = wins + partials + losses;
    const winRate = total > 0 ? ((wins + partials) / total) * 100 : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0);

    return {
        balance,
        total,
        wins,
        partials,
        losses,
        winRate,
        profitFactor,
        maxDrawdown,
        grossProfit,
        grossLoss,
        config
    };
}

async function main() {
    await new Promise(r => setTimeout(r, 1000));
    const ticker = process.argv.length > 2 ? process.argv[2] : 'EURUSD';
    const timeframe = process.argv.length > 3 ? process.argv[3] : 'M15';

    // Para EURUSD M15 mantengo el fallback al viejo directorio si hace falta, o asumo logs/ticker/history
    const filename = `history_${timeframe}.csv`;
    let csvPath = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history', filename);
    
    if (!fs.existsSync(csvPath)) {
        // Fallback for old structure just in case
        csvPath = path.join(process.cwd(), 'logs', 'history', filename);
    }

    if (!fs.existsSync(csvPath)) {
        console.error(`No se encontró el archivo CSV: ${csvPath}`);
        return;
    }

    console.log(`Cargando archivo: ${csvPath}`);

    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');

    const candles: OHLCV[] = [];

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

    candles.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    console.log(`Loaded ${candles.length} candles for ${timeframe}.`);
    console.log(`Iniciando optimización...`);

    let emaFastOptions = [13];
    let emaSlowOptions = [34];
    let regimeLenOptions = [75];
    let fixedRROptions = [3.5, 2.0, 2.5];
    let vwapPrdOptions = [5];
    let maxZScoreOptions = [2.5]; 
    let maxConsecutiveLossesOptions = [1, 2, 3, undefined];

    if (ticker.includes('BTC')) {
        // Malla mucho más amplia para Bitcoin
        emaFastOptions = [9, 13, 21];
        emaSlowOptions = [34, 50, 89];
        regimeLenOptions = [50, 75, 100];
        fixedRROptions = [1.5, 2.0, 3.0];
        vwapPrdOptions = [5, 8, 13];
        maxZScoreOptions = [2.5, 3.0, 3.5]; 
        maxConsecutiveLossesOptions = [1, 2, undefined];
    }


    
    const results = [];
    let iters = 0;
    
    for (const fast of emaFastOptions) {
        for (const slow of emaSlowOptions) {
            for (const regime of regimeLenOptions) {
                for (const rr of fixedRROptions) {
                    for (const prd of vwapPrdOptions) {
                        for (const zscore of maxZScoreOptions) {
                            for (const cl of maxConsecutiveLossesOptions) {
                                iters++;
                                const config: VwapConfig = {
                                    emaFastLen: fast,
                                    emaSlowLen: slow,
                                    regimeLen: regime,
                                    prd: prd,
                                    baseAPT: 10,
                                    useAdapt: false,
                                    volBias: 1,
                                    confirmCandle: true,
                                    slBufferPercent: 0.0005,
                                    fixedRR: rr,
                                    maxZScore: zscore,
                                    maxConsecutiveLosses: cl
                                };
                                
                                const res = runBacktestWithConfig(candles, config, ticker);
                                results.push(res);
                            }
                        }
                    }
                }
            }
        }
    }
    
    console.log(`Ejecutadas ${iters} combinaciones.`);
    
    // Sort by Balance (Net Profit)
    results.sort((a, b) => b.balance - a.balance);
    
    console.log(`\n--- TOP 5 CONFIGURACIONES (${timeframe}) ---`);
    for (let i = 0; i < Math.min(5, results.length); i++) {
        const r = results[i];
        console.log(`Rank ${i+1}:`);
        console.log(`  Config: EMA_F=${r.config.emaFastLen}, EMA_S=${r.config.emaSlowLen}, Regime=${r.config.regimeLen}, VWAP=${r.config.prd}, RR=${r.config.fixedRR}, Z-Score=${r.config.maxZScore}, MaxLoss=${r.config.maxConsecutiveLosses === undefined ? 'OFF' : r.config.maxConsecutiveLosses}`);
        console.log(`  Balance Final: $${r.balance.toFixed(2)} | Profit Factor: ${r.profitFactor.toFixed(2)} | Win Rate: ${r.winRate.toFixed(2)}% | Max DD: ${r.maxDrawdown.toFixed(2)}% | Total Trades: ${r.total}`);
    }
}

main().catch(console.error);
