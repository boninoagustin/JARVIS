import fs from 'fs';
import path from 'path';
import { runBacktest, parseCSV } from '../jarvis-os/src/services/backtestEngine.js';

const logsDir = path.resolve(process.cwd(), 'logs/eurusd');

function loadLogs(requiredTFs: string[]) {
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.csv'));
    const logsMap = new Map<string, string[]>();

    for (const file of files) {
        const filePath = path.join(logsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const { lines, detectedTF } = parseCSV(content);
        if (requiredTFs.includes(detectedTF)) {
            logsMap.set(detectedTF, lines);
        }
    }
    
    // Print what was loaded
    for (const tf of requiredTFs) {
       console.log(`Loaded ${logsMap.get(tf)?.length || 0} lines for TF ${tf}`);
    }
    
    return logsMap;
}

const slBuffers = [0, 5, 10, 15];
const tp2s = [1.5, 2.0, 2.5, 3.0];
const scoresToTest = Array.from({length: 26}, (_, i) => i + 5); // 5 to 30

async function evaluateScenario(scenarioName: string, requiredTFs: string[], activeTriggers: string[]) {
    console.log(`\n=================================`);
    console.log(`🚀 EVALUATING ${scenarioName}`);
    console.log(`=================================`);
    
    const logsMap = loadLogs(requiredTFs);
    let bestOverallMetric = -Infinity;
    let bestOverallConfig: any = null;
    let bestOverallStats: any = null;

    for (const slBuffer of slBuffers) {
        for (const tp2 of tp2s) {
            
            const sessionsConfig: any = {
                'LONDON': { }, 'NY': { }, 'ASIA': { }, 'OFF': { }
            };
            
            for (const s of ['LONDON', 'NY', 'ASIA', 'OFF']) {
                // Initialize all possible triggers to false
                for (const t of ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m']) {
                     sessionsConfig[s][t] = { enabled: false };
                }
                
                // Enable only active triggers with minimum score 5
                for (const trigger of activeTriggers) {
                    sessionsConfig[s][trigger] = {
                        enabled: true,
                        minScore: 5,
                        entryPercent: 50
                    };
                }
                
                sessionsConfig[s].slBufferPercent = slBuffer;
                sessionsConfig[s].fixedRR = tp2;
            }

            const config = {
                ticker: 'EURUSD',
                entryTrigger: 'SMART' as any,
                minBuyPoints: 5,
                minSellPoints: 5,
                slBufferPercent: slBuffer,
                fixedRR: tp2,
                oteEntryPercent: 50,
                sessions: sessionsConfig
            };

            // Run heavy engine ONCE for this SL/TP combo
            const result = runBacktest(logsMap, config);
            
            // Ultra-fast post-filtration loop for scores
            for (const testScore of scoresToTest) {
                let wins = 0;
                let losses = 0;
                let runningPnL = 0;
                let peakPnL = 0;
                let maxDrawdown = 0;
                
                // Filter trades that had at least testScore points
                const filteredTrades = result.trades.filter(t => t.points >= testScore);
                
                for (const t of filteredTrades) {
                    const pnl = t.rMultiple ?? 0;
                    runningPnL += pnl;
                    if (runningPnL > peakPnL) peakPnL = runningPnL;
                    const dd = peakPnL - runningPnL;
                    if (dd > maxDrawdown) maxDrawdown = dd;
                    
                    if (pnl > 0) wins++;
                    else losses++;
                }
                
                const tradeCount = filteredTrades.length;
                const winRate = tradeCount > 0 ? wins / tradeCount : 0;
                
                if (tradeCount >= 10 && winRate >= 0.30) {
                    const metricScore = runningPnL - (maxDrawdown * 0.5);
                    if (metricScore > bestOverallMetric) {
                        bestOverallMetric = metricScore;
                        bestOverallConfig = { minScore: testScore, slBufferPercent: slBuffer, tp2 };
                        bestOverallStats = { 
                            pnl: runningPnL.toFixed(2), 
                            winRate: (winRate*100).toFixed(1) + '%',
                            trades: tradeCount,
                            maxDrawdown: maxDrawdown.toFixed(2)
                        };
                    }
                }
            }
        }
    }
    
    if (bestOverallConfig) {
        console.log(`✅ WINNER for ${scenarioName}:`);
        console.log(`   Config: Score ${bestOverallConfig.minScore}, SL Buff ${bestOverallConfig.slBufferPercent}%, TP2 ${bestOverallConfig.tp2}R`);
        console.log(`   Stats:  PnL ${bestOverallStats.pnl}R, WinRate ${bestOverallStats.winRate}, Trades ${bestOverallStats.trades}, MaxDD ${bestOverallStats.maxDrawdown}R`);
    } else {
        console.log(`❌ No profitable configuration found for ${scenarioName}`);
    }
}

async function main() {
    // Escenario A: Standard (5m, 15m, 1h, 4h)
    const tfsA = ['5', '15', '60', '240'];
    const triggersA = ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m'];
    await evaluateScenario('ESCENARIO A (Estándar sin D)', tfsA, triggersA);
    
    // Escenario B: Daily Confluence (15m, 1h, 4h, D)
    const tfsB = ['15', '60', '240', 'D'];
    const triggersB = ['choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];
    await evaluateScenario('ESCENARIO B (Confluencia Diaria)', tfsB, triggersB);
}

main();
