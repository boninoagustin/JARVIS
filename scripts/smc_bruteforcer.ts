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

async function runOptimization() {
    const inputDir = path.join(process.cwd(), 'logs', ticker.toLowerCase(), 'history');
    
    const historyM15 = loadCandles(path.join(inputDir, 'history_M15.csv'));
    const historyH1 = loadCandles(path.join(inputDir, 'history_H1.csv'));
    const historyH4 = loadCandles(path.join(inputDir, 'history_H4.csv'));
    const historyD1 = loadCandles(path.join(inputDir, 'history_D1.csv'));
    
    console.log(`Loaded M15: ${historyM15.length}, H1: ${historyH1.length}, H4: ${historyH4.length}, D1: ${historyD1.length}`);

    // Generate grid of SMC Genes (Expanded for deep brute force)
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
    console.log(`Precomputing logs for all combinations... this might take a minute!`);

    const tfsData = [
        { name: '15', candles: historyM15 },
        { name: '60', candles: historyH1 },
        { name: '240', candles: historyH4 },
        { name: 'D', candles: historyD1 }
    ];

    // Store precomputed logs: tfName -> geneIndex -> csvLines[]
    const precomputedLogs = new Map<string, Map<number, string[]>>();

    for (const tf of tfsData) {
        const tfLogsMap = new Map<number, string[]>();
        for (let i = 0; i < smcGrid.length; i++) {
            const gene = smcGrid[i];
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

            const engine = new SMCEngine(testPreset, tf.name);
            engine.setHTFContext('Neutral', 'Neutral');

            const csvLines: string[] = [];
            for (let j = 0; j < tf.candles.length; j++) {
                const candle = tf.candles[j];
                const events = engine.nextCandle(candle);
                const state = engine.getState();
                
                const tfCode = tf.name;
                
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
            tfLogsMap.set(i, csvLines);
        }
        precomputedLogs.set(tf.name, tfLogsMap);
        console.log(`Precomputed ${smcGrid.length} variants for TF ${tf.name}`);
    }

    const defaultGeneIdx = 0; // The first in grid acts as default initially
    const activeTriggers = ['choch15m', 'bos15m', 'oteChoch15m', 'oteBos15m'];
    const defaultRisk: RiskGene = { slBufferPercent: 0, fixedRR: 2, minRR: 1.5 };

    // --- PHASE 1: Tactical Optimization (M15 & H1) ---
    console.log(`\n\n=== PHASE 1: TACTICAL OPTIMIZATION (M15 & H1) ===`);
    let bestPhase1Metric = -Infinity;
    let bestM15Idx = defaultGeneIdx;
    let bestH1Idx = defaultGeneIdx;

    let phase1Iter = 0;
    const totalPhase1 = smcGrid.length * smcGrid.length;
    for (let i = 0; i < smcGrid.length; i++) {
        for (let j = 0; j < smcGrid.length; j++) {
            phase1Iter++;
            
            const logsMap = new Map<string, string[]>();
            logsMap.set('15', precomputedLogs.get('15')!.get(i)!);
            logsMap.set('60', precomputedLogs.get('60')!.get(j)!);
            logsMap.set('240', precomputedLogs.get('240')!.get(defaultGeneIdx)!);
            logsMap.set('D', precomputedLogs.get('D')!.get(defaultGeneIdx)!);

            const metric = evaluateConfig(logsMap, activeTriggers, defaultRisk);
            if (metric > bestPhase1Metric) {
                bestPhase1Metric = metric;
                bestM15Idx = i;
                bestH1Idx = j;
                const m15Name = getGeneName(smcGrid[i]);
                const h1Name = getGeneName(smcGrid[j]);
                console.log(`[P1] New Best: ${metric.toFixed(2)}R | M15: ${m15Name} | H1: ${h1Name}`);
            }
        }
    }

    console.log(`\n>> Phase 1 Complete. Locked M15: ${getGeneName(smcGrid[bestM15Idx])} | Locked H1: ${getGeneName(smcGrid[bestH1Idx])}`);

    // --- PHASE 2: Structural Optimization (H4 & D1) ---
    console.log(`\n\n=== PHASE 2: STRUCTURAL OPTIMIZATION (H4 & D1) ===`);
    let bestPhase2Metric = -Infinity;
    let bestH4Idx = defaultGeneIdx;
    let bestD1Idx = defaultGeneIdx;

    let phase2Iter = 0;
    for (let k = 0; k < smcGrid.length; k++) {
        for (let l = 0; l < smcGrid.length; l++) {
            phase2Iter++;
            
            const logsMap = new Map<string, string[]>();
            logsMap.set('15', precomputedLogs.get('15')!.get(bestM15Idx)!);
            logsMap.set('60', precomputedLogs.get('60')!.get(bestH1Idx)!);
            logsMap.set('240', precomputedLogs.get('240')!.get(k)!);
            logsMap.set('D', precomputedLogs.get('D')!.get(l)!);

            const metric = evaluateConfig(logsMap, activeTriggers, defaultRisk);
            if (metric > bestPhase2Metric) {
                bestPhase2Metric = metric;
                bestH4Idx = k;
                bestD1Idx = l;
                const h4Name = getGeneName(smcGrid[k]);
                const d1Name = getGeneName(smcGrid[l]);
                console.log(`[P2] New Best: ${metric.toFixed(2)}R | H4: ${h4Name} | D1: ${d1Name}`);
            }
        }
    }

    console.log(`\n>> Phase 2 Complete. Locked H4: ${getGeneName(smcGrid[bestH4Idx])} | Locked D1: ${getGeneName(smcGrid[bestD1Idx])}`);

    // --- PHASE 3: Risk Management Optimization ---
    console.log(`\n\n=== PHASE 3: RISK MANAGEMENT OPTIMIZATION ===`);
    
    const slBuffers = [0, 5, 10, 15, 20, 25]; 
    const tp2Multipliers = [1.5, 2, 3, 4, 5]; 
    const minRRs = [1.0, 1.5, 2.0, 2.5, 3.0]; 
    let bestPhase3Metric = -Infinity;
    let bestRisk: RiskGene = defaultRisk;
    
    // Build final locked logsMap
    const finalLogsMap = new Map<string, string[]>();
    finalLogsMap.set('15', precomputedLogs.get('15')!.get(bestM15Idx)!);
    finalLogsMap.set('60', precomputedLogs.get('60')!.get(bestH1Idx)!);
    finalLogsMap.set('240', precomputedLogs.get('240')!.get(bestH4Idx)!);
    finalLogsMap.set('D', precomputedLogs.get('D')!.get(bestD1Idx)!);

    for (const sl of slBuffers) {
        for (const rr of tp2Multipliers) {
            for (const mRR of minRRs) {
                const r: RiskGene = { slBufferPercent: sl, fixedRR: rr, minRR: mRR };
                const metric = evaluateConfig(finalLogsMap, activeTriggers, r);
                if (metric > bestPhase3Metric) {
                    bestPhase3Metric = metric;
                    bestRisk = r;
                    console.log(`[P3] New Best: ${metric.toFixed(2)}R | SL Buff: ${sl}% | TP2 RR: ${rr} | Min RR: ${mRR}`);
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
