import { runBacktest, parseCSV } from '../jarvis-os/src/services/backtestEngine.js';
import { BacktestConfig } from '../jarvis-os/src/services/backtestTypes.js';
import fs from 'fs';
import path from 'path';

async function main() {
    const ticker = (process.argv[2] || 'EURUSD').toUpperCase();
    const baseDir = path.resolve(process.cwd(), 'logs', ticker.toLowerCase(), 'history_exported');
    
    function loadLogs(tf: string) {
        const file = path.join(baseDir, `pine-logs-SMC Master_${tf}.csv`);
        if (!fs.existsSync(file)) return [];
        const content = fs.readFileSync(file, 'utf8');
        return parseCSV(content).lines;
    }

    const logsM15 = loadLogs('M15');
    const logsH1 = loadLogs('H1');
    const logsH4 = loadLogs('H4');
    const logsD1 = loadLogs('D1');
    
    const logsMap = new Map<string, any[]>();
    logsMap.set('15', logsM15);
    logsMap.set('60', logsH1);
    logsMap.set('240', logsH4);
    logsMap.set('D', logsD1);

    const config: any = {
        ticker: ticker.toLowerCase(),
        timeframe: '15',
        startBalance: 100000,
        riskPerTradePct: 1, // 1%
        fixedRR: 3,         // Default, will be overridden by optimized json if available
        minRR: 1,
        slBufferPercent: 10,
        maxTradesPerDay: 5,
        trailingSlType: 'NONE',
        partialTakeProfitPct: 0,
        spreadPips: 0.1,
        commissionPerLot: 3,
        strategy: 'SMART',
        enableDivergenceFilter: false
    };
    
    const { getOptimizedRisk } = await import('../src/engine/smc/smc_config.js');
    const optimizedRisk = getOptimizedRisk(ticker);
    if (optimizedRisk) {
        if (optimizedRisk.slBufferPercent) config.slBufferPercent = optimizedRisk.slBufferPercent;
        if (optimizedRisk.fixedRR) config.fixedRR = optimizedRisk.fixedRR;
        if (optimizedRisk.minRR) config.minRR = optimizedRisk.minRR;
        console.log("Using optimized risk params:", optimizedRisk);
    }

    // Assign sessions using SMART trigger
    const triggerKeys = ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m'];
    const sessionsConfig: any = { 'LONDON': {}, 'NY': {}, 'ASIA': {}, 'OFF': {} };
    for (const s of Object.keys(sessionsConfig)) {
        for (const tk of triggerKeys) {
            sessionsConfig[s][tk] = { enabled: true, minScore: 4 };
        }
        sessionsConfig[s].slBufferPercent = config.slBufferPercent;
        sessionsConfig[s].fixedRR = config.fixedRR;
    }
    config.sessions = sessionsConfig;

    console.log("Running Backtest (SMART Strategy)...");
    const result = runBacktest(logsMap, config);
    
    let totalPnl = 0;
    let totalR = 0;
    let winCount = 0;
    for (const t of result.trades) {
        totalPnl += (t.pnl || 0);
        totalR += (t.rMultiple || 0);
        if (t.result === 'WIN') winCount++;
    }
    const winRate = result.trades.length > 0 ? (winCount / result.trades.length) * 100 : 0;
    
    console.log(`\n============================`);
    console.log(`TOTAL TRADES: ${result.trades.length}`);
    console.log(`WIN RATE: ${winRate.toFixed(2)}%`);
    console.log(`TOTAL PNL ($): $${totalPnl.toFixed(2)}`);
    console.log(`TOTAL PNL (R): ${totalR.toFixed(2)}R`);
    console.log(`============================`);

    const outFile = path.join(process.cwd(), 'logs', `jarvis_bt_${ticker}_${Date.now()}.json`);
    const outData = {
        metadata: { ticker, winRate, totalR, totalPnl, tradesCount: result.trades.length },
        trades: result.trades
    };
    fs.writeFileSync(outFile, JSON.stringify(outData, null, 2));
    console.log(`Saved backtest results to ${outFile}`);
}

main().catch(console.error);
