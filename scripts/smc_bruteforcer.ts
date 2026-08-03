/**
 * ⚠️ DEPRECATED — Reemplazado por scripts/hyperopt/ (Optuna Bayesian Optimization)
 *
 * Este archivo usaba Coordinate Descent secuencial sobre grillas discretas
 * (pivot_lens=[3,5,8,13,21], wick=[0.1,0.3,0.5,0.7], div=[2,3,5], z=[14,20,50,100])
 * para cada TF por separado. La nueva arquitectura unifica la búsqueda con TPE
 * multivariado y evalúa todos los TFs simultáneamente en vez de greedy secuencial.
 *
 * Para Hyperopt moderno:   python scripts/hyperopt/run_hyperopt.py <ticker>
 * Para migrar un preset:   python scripts/hyperopt/load_best_params.py <output.json>
 *
 * Keep for backward compatibility (csv-based log generation still useful).
 */
import fs from 'fs';
import path from 'path';
import { OHLCV, SMCPreset } from '../src/engine/smc/types.js';
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';
import { runBacktest } from '../jarvis-os/src/services/backtestEngine.js';
import { BacktestConfig } from '../jarvis-os/src/services/backtestTypes.js';
import { parse as parseCsv } from 'csv-parse/sync';
const ticker = (process.argv[2] || 'EURUSD').toUpperCase();

function loadCandles(filePath: string): OHLCV[] {
    console.log(`Loading candles from ${filePath}...`);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const records = parseCsv(fileContent, {
        columns: true,
        skip_empty_lines: true
    });

    return records.map((row: any) => ({
        timestamp: Number(row.timestamp),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume)
    }));
}

function fmt(n: number): number {
    return Number(n.toFixed(5));
}

function dirToBot(dir: string): string {
    return dir === 'Bullish' ? 'BUY' : (dir === 'Bearish' ? 'SELL' : 'NEUTRAL');
}

const MEDAL_MAP: Record<string, string> = {
    '🥇': 'GOLD',
    '🥈': 'SILVER',
    '🥉': 'BRONZE'
};

interface SMCGene {
    pivot_len: number;
    wick_pct: number;
    div_len: number;
    z_window: number;
}

interface RiskGene {
    slBufferPercent: number;
    fixedRR: number;
    minRR: number;
}

function evaluateConfig(logsMap: Map<string, string[]>, activeTriggers: string[], risk: RiskGene): number {
    const sessionsConfig: any = {
        'LONDON': { }, 'NY': { }, 'ASIA': { }, 'OFF': { }
    };
    
    for (const s of ['LONDON', 'NY', 'ASIA', 'OFF']) {
        for (const t of ['choch5m', 'choch15m', 'bos5m', 'bos15m', 'oteChoch5m', 'oteChoch15m', 'oteBos5m', 'oteBos15m']) {
             sessionsConfig[s][t] = { enabled: false };
        }
        for (const trigger of activeTriggers) {
            sessionsConfig[s][trigger] = {
                enabled: true,
                minScore: 4, 
                entryPercent: 50
            };
        }
        sessionsConfig[s].slBufferPercent = risk.slBufferPercent;
        sessionsConfig[s].fixedRR = risk.fixedRR;
    }

    const config: BacktestConfig = {
        ticker: ticker,
        entryTrigger: 'SMART',
        minBuyPoints: 4,
        minSellPoints: 4,
        minRR: risk.minRR,
        slBufferPercent: risk.slBufferPercent,
        fixedRR: risk.fixedRR,
        oteEntryPercent: 50,
        sessions: sessionsConfig,
        directManagement: {
            partialClosePct: 0.5,
            slAfterTp1: 'breakeven',
            tp15BeEnabled: true,
            atrTrailEnabled: false
        }
    };
    
    const result = runBacktest(logsMap, config);
    let winCount = 0;
    let totalPnl = 0;
    for (const t of result.trades) {
        if (t.result === 'WIN') winCount++;
        totalPnl += (t.pnl || 0);
    }
    
    if (result.trades.length < 5) return -100; // Penalize lack of trades
    
    return totalPnl;
}

function evaluateConfigWithDetails(logsMap: Map<string, string[]>, activeTriggers: string[], risk: RiskGene): any {
    const pnl = evaluateConfig(logsMap, activeTriggers, risk);
    const sessionsConfig: any = { 'LONDON': {}, 'NY': {}, 'ASIA': {}, 'OFF': {} };
    for (const s of ['LONDON', 'NY', 'ASIA', 'OFF']) {
        for (const trigger of activeTriggers) {
            sessionsConfig[s][trigger] = { enabled: true, minScore: 4, entryPercent: 50 };
        }
        sessionsConfig[s].slBufferPercent = risk.slBufferPercent;
        sessionsConfig[s].fixedRR = risk.fixedRR;
    }
    
    const config: BacktestConfig = {
        ticker: ticker,
        entryTrigger: 'SMART',
        minBuyPoints: 4,
        minSellPoints: 4,
        minRR: risk.minRR,
        slBufferPercent: risk.slBufferPercent,
        fixedRR: risk.fixedRR,
        oteEntryPercent: 50,
        sessions: sessionsConfig,
        directManagement: { partialClosePct: 0.5, slAfterTp1: 'breakeven', tp15BeEnabled: true, atrTrailEnabled: false }
    };

    const result = runBacktest(logsMap, config);
    let winCount = 0;
    for (const t of result.trades) {
        if (t.result === 'WIN') winCount++;
    }
    const winRate = result.trades.length > 0 ? (winCount / result.trades.length) * 100 : 0;
    return { pnl, trades: result.trades.length, winRate };
}

function getGeneName(gene: SMCGene) {
    return `Piv${gene.pivot_len}-W${gene.wick_pct}-D${gene.div_len}-Z${gene.z_window}`;
}

function generateLogs(tfCode: string, candles: OHLCV[], gene: SMCGene): string[] {
    const testPreset: SMCPreset = {
        name: 'Optimization_Preset',
        risk_level: 3,
        asset_type: 'forex',
        override_choch: false,
        require_displacement: true,
        require_fvg_after_ob: false,
        strict_breaker: false,
        strict_sweep: true,
        confirm_close: true,
        min_score: 0,
        pivot_len: gene.pivot_len,
        min_sweep_wick_pct: gene.wick_pct,
        div_pivot_len: gene.div_len,
        z_score_window: gene.z_window
    };

    const engine = new SMCEngine(testPreset, tfCode);
    engine.setHTFContext('Neutral', 'Neutral');

    const csvLines: string[] = [];
    for (let j = 0; j < candles.length; j++) {
        const candle = candles[j];
        const events = engine.nextCandle(candle);
        const state = engine.getState();
        
        const payload: any[] = [];
        for (const ob of state.activeBreakers) payload.push({ t: tfCode, d: ob.direction === 'Bullish' ? 'BUY' : 'SELL', p: fmt(ob.top), b: fmt(ob.bottom), lv: fmt(ob.top), md: 'Breaker', sc: ob.score, a: state.atr });
        for (const ob of state.activeOBs.filter(o => o.category !== 'Breaker')) payload.push({ t: tfCode, d: ob.direction === 'Bullish' ? 'BUY' : 'SELL', p: fmt(ob.top), b: fmt(ob.bottom), lv: fmt(ob.top), md: ob.category === 'CHoCH' ? 'CHoCH' : (ob.category === 'Legacy' ? 'Legacy' : 'BRK'), sc: ob.score, a: state.atr });
        if (state.lastDivergence) payload.push({ t: tfCode, d: state.lastDivergence.direction === 'Bullish' ? 'BUY' : 'SELL', p: fmt((state.lastDivergence as any).price), b: fmt((state.lastDivergence as any).bottom || ((state.lastDivergence as any).price - 0.0005)), lv: 'DIV', md: 'SMC_DIV', sc: 8, a: state.atr, kz: true });
        
        const structTrend = state.currentTrend === 'Bullish' ? 'BUY' : (state.currentTrend === 'Bearish' ? 'SELL' : 'NEUTRAL');
        
        csvLines.push(`HB | TF: ${tfCode} | TS: ${candle.timestamp}`);
        csvLines.push(`PING_PRICE | TF: ${tfCode} | Precio: ${fmt(candle.close)} | High: ${fmt(candle.high)} | Low: ${fmt(candle.low)} | TS: ${candle.timestamp}`);
        csvLines.push(`SYNC_ZONES | TF: ${tfCode} | Trend: ${structTrend} | WBias: NEUTRAL | Payload: ${JSON.stringify(payload)} | TS: ${candle.timestamp}`);
        
        for (const ev of events) {
            let alertMsg: string | null = null;
            switch (ev.type) {
                case 'EVENT_CHOCH':
                case 'EVENT_BOS': {
                    const prefix = ev.type === 'EVENT_CHOCH' ? 'EVENTO_CHOCH' : 'EVENTO_BOS';
                    const dir = dirToBot(ev.direction);
                    const origin = (ev as any).origin !== undefined ? ` | ORIGIN: ${fmt((ev as any).origin)}` : '';
                    alertMsg = `${prefix} | TF: ${tfCode} | Dir: ${dir} | Precio: ${fmt(candle.close)}${origin} | CONFIRMED | TS: ${candle.timestamp}`;
                    break;
                }
                case 'EVENT_SWEEP': {
                    const dir = dirToBot(ev.direction);
                    if (ev.sweepType === 'LIQ_GRAB') {
                        alertMsg = `LIQ_GRAB | TF: ${tfCode} | Dir: ${dir} | Nivel: ${fmt(ev.price)} | TS: ${candle.timestamp}`;
                    } else {
                        alertMsg = `EVENTO_SWEEP | TF: ${tfCode} | Dir: ${dir} | Nivel Reclamado | TS: ${candle.timestamp}`;
                    }
                    break;
                }
                case 'EVENT_DIVERGENCE': {
                    const dir = dirToBot(ev.direction);
                    const rsiDiff = Math.round(((ev as any).divergence?.rsiDiff ?? 0) * 10) / 10;
                    const score = (ev as any).divergence?.score ?? 0;
                    alertMsg = `EVENTO_SMC_DIV | TF: ${tfCode} | Dir: ${dir} | Score: ${score} | RSI_Diff: ${rsiDiff} | TS: ${candle.timestamp}`;
                    break;
                }
                case 'ZONE_TOUCHED':
                case 'ZONE_BROKEN': {
                    const dir = dirToBot(ev.direction);
                    const category = (ev as any).category ?? (ev as any).medal;
                    const medal = MEDAL_MAP[category] ?? category;
                    alertMsg = `${ev.type} | TF: ${tfCode} | Dir: ${dir} | Medal: ${medal} | Score: ${ev.score} | Top: ${fmt(ev.top)} | Btm: ${fmt(ev.bottom)} | TS: ${candle.timestamp}`;
                    break;
                }
            }
            if (alertMsg) csvLines.push(alertMsg);
        }
    }
    return csvLines;
}

async function runOptimization() {
    const inputDir = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history');
    
    const historyM15 = loadCandles(path.join(inputDir, 'history_M15.csv'));
    const historyH1 = loadCandles(path.join(inputDir, 'history_H1.csv'));
    const historyH4 = loadCandles(path.join(inputDir, 'history_H4.csv'));
    const historyD1 = loadCandles(path.join(inputDir, 'history_D1.csv'));
    
    console.log(`Loaded M15: ${historyM15.length}, H1: ${historyH1.length}, H4: ${historyH4.length}, D1: ${historyD1.length}`);

    // Generate grid of SMC Genes
    const pivot_lens = [3, 5, 8, 13, 21]; 
    const min_sweep_wick_pcts = [0.1, 0.3, 0.5, 0.7];
    const div_pivot_lens = [2, 3, 5];
    const z_score_windows = [14, 20, 50, 100];

    const smcGrid: SMCGene[] = [];
    for (const p of pivot_lens) {
        for (const w of min_sweep_wick_pcts) {
            for (const d of div_pivot_lens) {
                for (const z of z_score_windows) {
                    smcGrid.push({ pivot_len: p, wick_pct: w, div_len: d, z_window: z });
                }
            }
        }
    }

    console.log(`\nGrid size: ${smcGrid.length} combinations per timeframe.`);
    console.log(`Using Coordinate Descent (Greedy Search) for extreme performance & memory optimization...`);

    const defaultGeneIdx = 0; 
    const activeTriggers = ['choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];
    const defaultRisk: RiskGene = { slBufferPercent: 0, fixedRR: 2, minRR: 1.5 };

    let bestM15Idx = defaultGeneIdx;
    let bestH1Idx = defaultGeneIdx;
    let bestH4Idx = defaultGeneIdx;
    let bestD1Idx = defaultGeneIdx;

    let bestM15Logs = generateLogs('15', historyM15, smcGrid[bestM15Idx]);
    let bestH1Logs = generateLogs('60', historyH1, smcGrid[bestH1Idx]);
    let bestH4Logs = generateLogs('240', historyH4, smcGrid[bestH4Idx]);
    let bestD1Logs = generateLogs('D', historyD1, smcGrid[bestD1Idx]);

    let bestGlobalMetric = -Infinity;

    // Helper to evaluate current logs
    const evaluateCurrent = (m15: string[], h1: string[], h4: string[], d1: string[]) => {
        const logsMap = new Map<string, string[]>();
        logsMap.set('15', m15);
        logsMap.set('60', h1);
        logsMap.set('240', h4);
        logsMap.set('D', d1);
        return evaluateConfig(logsMap, activeTriggers, defaultRisk);
    };

    // Evaluate initial baseline
    bestGlobalMetric = evaluateCurrent(bestM15Logs, bestH1Logs, bestH4Logs, bestD1Logs);
    console.log(`Baseline Metric: ${bestGlobalMetric.toFixed(2)}R`);

    // --- PHASE 1: M15 Optimization ---
    console.log(`\n\n=== PHASE 1: M15 OPTIMIZATION ===`);
    for (let i = 0; i < smcGrid.length; i++) {
        const testLogs = generateLogs('15', historyM15, smcGrid[i]);
        const metric = evaluateCurrent(testLogs, bestH1Logs, bestH4Logs, bestD1Logs);
        if (metric > bestGlobalMetric) {
            bestGlobalMetric = metric;
            bestM15Idx = i;
            bestM15Logs = testLogs;
            console.log(`[M15] New Best: ${metric.toFixed(2)}R | Gene: ${getGeneName(smcGrid[i])}`);
        }
    }
    console.log(`>> M15 Locked: ${getGeneName(smcGrid[bestM15Idx])}`);

    // --- PHASE 2: H1 Optimization ---
    console.log(`\n\n=== PHASE 2: H1 OPTIMIZATION ===`);
    for (let i = 0; i < smcGrid.length; i++) {
        const testLogs = generateLogs('60', historyH1, smcGrid[i]);
        const metric = evaluateCurrent(bestM15Logs, testLogs, bestH4Logs, bestD1Logs);
        if (metric > bestGlobalMetric) {
            bestGlobalMetric = metric;
            bestH1Idx = i;
            bestH1Logs = testLogs;
            console.log(`[H1] New Best: ${metric.toFixed(2)}R | Gene: ${getGeneName(smcGrid[i])}`);
        }
    }
    console.log(`>> H1 Locked: ${getGeneName(smcGrid[bestH1Idx])}`);

    // --- PHASE 3: H4 Optimization ---
    console.log(`\n\n=== PHASE 3: H4 OPTIMIZATION ===`);
    for (let i = 0; i < smcGrid.length; i++) {
        const testLogs = generateLogs('240', historyH4, smcGrid[i]);
        const metric = evaluateCurrent(bestM15Logs, bestH1Logs, testLogs, bestD1Logs);
        if (metric > bestGlobalMetric) {
            bestGlobalMetric = metric;
            bestH4Idx = i;
            bestH4Logs = testLogs;
            console.log(`[H4] New Best: ${metric.toFixed(2)}R | Gene: ${getGeneName(smcGrid[i])}`);
        }
    }
    console.log(`>> H4 Locked: ${getGeneName(smcGrid[bestH4Idx])}`);

    // --- PHASE 4: D1 Optimization ---
    console.log(`\n\n=== PHASE 4: D1 OPTIMIZATION ===`);
    for (let i = 0; i < smcGrid.length; i++) {
        const testLogs = generateLogs('D', historyD1, smcGrid[i]);
        const metric = evaluateCurrent(bestM15Logs, bestH1Logs, bestH4Logs, testLogs);
        if (metric > bestGlobalMetric) {
            bestGlobalMetric = metric;
            bestD1Idx = i;
            bestD1Logs = testLogs;
            console.log(`[D1] New Best: ${metric.toFixed(2)}R | Gene: ${getGeneName(smcGrid[i])}`);
        }
    }
    console.log(`>> D1 Locked: ${getGeneName(smcGrid[bestD1Idx])}`);

    // --- PHASE 5: RISK MANAGEMENT OPTIMIZATION ---
    console.log(`\n\n=== PHASE 5: RISK MANAGEMENT OPTIMIZATION ===`);
    const slBuffers = [0, 5, 10, 15, 20, 25]; 
    const tp2Multipliers = [1.5, 2, 3, 4, 5]; 
    const minRRs = [1.0, 1.5, 2.0, 2.5, 3.0]; 
    
    let bestRiskMetric = -Infinity;
    let bestRisk: RiskGene = defaultRisk;
    
    const finalLogsMap = new Map<string, string[]>();
    finalLogsMap.set('15', bestM15Logs);
    finalLogsMap.set('60', bestH1Logs);
    finalLogsMap.set('240', bestH4Logs);
    finalLogsMap.set('D', bestD1Logs);

    for (const sl of slBuffers) {
        for (const rr of tp2Multipliers) {
            for (const mRR of minRRs) {
                const r: RiskGene = { slBufferPercent: sl, fixedRR: rr, minRR: mRR };
                const metric = evaluateConfig(finalLogsMap, activeTriggers, r);
                if (metric > bestRiskMetric) {
                    bestRiskMetric = metric;
                    bestRisk = r;
                    console.log(`[RISK] New Best: ${metric.toFixed(2)}R | SL Buff: ${sl}% | TP2 RR: ${rr} | Min RR: ${mRR}`);
                }
            }
        }
    }

    // --- FINAL RESULTS ---
    console.log(`\n\n🏆 OPTIMIZATION FINISHED 🏆`);
    const finalDetails = evaluateConfigWithDetails(finalLogsMap, activeTriggers, bestRisk);
    
    const finalPreset = {
        M15: smcGrid[bestM15Idx],
        H1: smcGrid[bestH1Idx],
        H4: smcGrid[bestH4Idx],
        D1: smcGrid[bestD1Idx],
        Risk: bestRisk,
        Metrics: {
            PnL_R: finalDetails.pnl.toFixed(2),
            Trades: finalDetails.trades,
            WinRate: finalDetails.winRate.toFixed(2) + '%'
        }
    };
    
    console.log(JSON.stringify(finalPreset, null, 2));

    const outPath = path.join(process.cwd(), `optimized_preset_${ticker}.json`);
    fs.writeFileSync(outPath, JSON.stringify(finalPreset, null, 4));
    console.log(`\nSaved optimized preset to ${outPath}`);
}

runOptimization().catch(console.error);
