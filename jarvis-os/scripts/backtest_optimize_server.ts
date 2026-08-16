/**
 * backtest_optimize_server.ts — Auto-Tune Global server-side usando el MOTOR REAL.
 * Replica la lógica de RUN_OPTIMIZATION del viejo backtest.worker.ts, pero corre en el VPS.
 *
 * Uso: npx tsx scripts/backtest_optimize_server.ts <ticker> <tfs> <payload_json>
 * payload_json = el payload de RUN_OPTIMIZATION (baseConfig, sessionKey, triggerKey, etc.)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest, prepareEntries } from '../src/services/backtestEngine';
import { geneticSearch, gridGenomes, gridCount } from '../src/services/optimizer';
import type { TriggerGenome } from '../src/services/optimizer';
import type { LogEntry } from '../src/services/backtestTypes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_ROOT = path.join(__dirname, '..', '..', 'logs');

function loadLogs(ticker: string, tfs: string[]): Map<string, string[]> {
    const tickerDir = path.join(LOGS_ROOT, ticker.toLowerCase(), 'history_exported');
    if (!fs.existsSync(tickerDir)) throw new Error(`No existe: ${tickerDir}`);
    const logs = new Map<string, string[]>();
    for (const tf of tfs) {
        const candidates = [
            path.join(tickerDir, `pine-logs-SMC Master_${tf}.csv`),
            path.join(tickerDir, `pine-logs-SMC Master_${tf.toUpperCase()}.csv`),
        ];
        const tfNum: Record<string, string> = { 'M5': '5', 'M15': '15', 'H1': '60', 'H4': '240', 'D1': 'D' };
        const alt = tfNum[tf];
        const all = alt ? candidates.concat([path.join(tickerDir, `pine-logs-SMC Master_${alt}.csv`)]) : candidates;
        const found = all.find(c => fs.existsSync(c));
        if (!found) continue;
        const content = fs.readFileSync(found, 'utf8');
        logs.set(tf, content.split('\n').filter(l => l.trim().length > 0));
    }
    return logs;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 3) {
        console.log(JSON.stringify({ error: 'Uso: backtest_optimize_server.ts <ticker> <tfs> <payload_json>' }));
        process.exit(0);
    }
    const ticker = args[0].toUpperCase();
    const tfs = args[1].split(',').map(t => t.trim()).filter(Boolean);
    const payload = JSON.parse(args[2]);

    const {
        baseConfig, sessionKey, triggerKey,
        strategy = 'ga', seed = 42, budget = 600,
        trainFraction = 1.0, minTrades = 5,
        minBuyPoints = 4, minSellPoints = 4, oteEntryPercent = 50,
        slBufferPercent = 0.1, fixedRR = 2.0,
        maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses,
        maxTradesPerDay, maxTradesPerSession, trailingDrawdownR,
        spreadPips = 0, commissionPerLot = 0, tp1StructuralMinRR = 1.2,
    } = payload;

    const tfsFinal = (payload.tfs && Array.isArray(payload.tfs) && payload.tfs.length > 0)
        ? payload.tfs : tfs;

    const logs = loadLogs(ticker, tfsFinal);
    const prepared: LogEntry[] = await prepareEntries(logs);
    if (prepared.length === 0) {
        console.log(JSON.stringify({ error: 'Sin entradas preparadas (¿CSVs vacíos?)' }));
        process.exit(0);
    }

    const total = prepared.length;
    const splitIdx = Math.floor(total * trainFraction);
    const trainPrepared = prepared.slice(0, splitIdx);
    const testPrepared = prepared.slice(splitIdx);

    // Función de evaluación (misma que el worker)
    const evaluate = (genome: TriggerGenome): number => {
        const sessions = JSON.parse(JSON.stringify(baseConfig.sessions));
        if (!sessions[sessionKey]) sessions[sessionKey] = {};
        sessions[sessionKey][triggerKey] = {
            ...(sessions[sessionKey][triggerKey] || { enabled: true }),
            minScore: genome.minScore,
            slBuff: genome.slBuff,
            tp2: genome.tp2,
            partialClosePct: genome.partialClosePct,
            slAfterTp1: genome.slAfterTp1,
            tp15BeEnabled: genome.tp15BeEnabled,
            atrTrailEnabled: genome.atrTrailEnabled,
            structuralTrailEnabled: genome.structuralTrailEnabled,
            minimal_roi: genome.minimal_roi || undefined,
            entryPercent: genome.entryPercent,
            enabled: true,
        };

        const configToRun: any = {
            ticker,
            minBuyPoints, minSellPoints,
            slBufferPercent, fixedRR,
            oteEntryPercent,
            entryTrigger: 'SMART',
            maxDailyLossR: maxDailyLossR || undefined,
            dailyProfitTargetR: dailyProfitTargetR || undefined,
            maxConsecutiveLosses: maxConsecutiveLosses || undefined,
            maxTradesPerDay: maxTradesPerDay || undefined,
            maxTradesPerSession: maxTradesPerSession || undefined,
            trailingDrawdownR: trailingDrawdownR || undefined,
            sessions,
            sessionFilter: [sessionKey],
            enabled: true,
            spreadPips: spreadPips ?? 0,
            commissionPerLot: commissionPerLot ?? 0,
            partialClosePct: genome.partialClosePct,
            slAfterTp1: genome.slAfterTp1,
            tp15BeEnabled: genome.tp15BeEnabled,
            atrTrailEnabled: genome.atrTrailEnabled,
            structuralTrailEnabled: genome.structuralTrailEnabled,
            tp1StructuralMinRR: tp1StructuralMinRR ?? 1.2,
        };

        const res = runBacktest(logs, configToRun, undefined, trainPrepared);

        let pnlR = 0, wins = 0, totalTrades = 0;
        for (const t of res.trades) {
            if (t.triggerType === triggerKey && (t.points || 0) >= genome.minScore) {
                if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) {
                    pnlR += t.rMultiple;
                    totalTrades++;
                    if (t.rMultiple > 0) wins++;
                }
            }
        }
        if (totalTrades < minTrades) return -1000 + totalTrades;
        const wr = totalTrades > 0 ? wins / totalTrades : 0;
        return pnlR + wr * 0.001;
    };

    let result: { best: TriggerGenome; top10: TriggerGenome[]; evaluated: number };

    if (strategy === 'ga') {
        result = await geneticSearch({ evaluate, budget, seed, populationSize: 24, maxGenerations: 20, elite: 2, tournamentK: 3, mutationRate: 0.15, earlyStopGens: 6 });
    } else {
        let bestGenome: TriggerGenome = { minScore: 4, slBuff: 0, tp2: 1.5, partialClosePct: 0, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, minimal_roi: null, entryPercent: 50 };
        let bestFitness = -Infinity;
        let evalCount = 0;
        const allResults: { genome: TriggerGenome; fitness: number }[] = [];
        for (const genome of gridGenomes()) {
            const fitness = evaluate(genome);
            allResults.push({ genome: { ...genome }, fitness });
            evalCount++;
            if (fitness > bestFitness) { bestFitness = fitness; bestGenome = { ...genome }; }
        }
        allResults.sort((a, b) => b.fitness - a.fitness);
        result = { best: allResults[0].genome, top10: allResults.slice(0, 10).map(x => x.genome), evaluated: evalCount };
    }

    // Re-evaluar el mejor sobre train (mismo que worker)
    let trainPnlR = 0, trainTrades = 0;
    const trainSessions = JSON.parse(JSON.stringify(baseConfig.sessions));
    if (!trainSessions[sessionKey]) trainSessions[sessionKey] = {};
    trainSessions[sessionKey][triggerKey] = {
        ...(trainSessions[sessionKey][triggerKey] || { enabled: true }),
        minScore: result.best.minScore, slBuff: result.best.slBuff, tp2: result.best.tp2,
        partialClosePct: result.best.partialClosePct, slAfterTp1: result.best.slAfterTp1,
        tp15BeEnabled: result.best.tp15BeEnabled, atrTrailEnabled: result.best.atrTrailEnabled,
        structuralTrailEnabled: result.best.structuralTrailEnabled, enabled: true,
        minimal_roi: result.best.minimal_roi, // 🔧 FIX: propagar ROI al train re-eval (antes el reporte no correspondía al fitness)
    };
    const trainConfig: any = {
        ticker, entryTrigger: 'SMART', sessions: trainSessions, sessionFilter: [sessionKey],
        minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent,
        maxDailyLossR: maxDailyLossR || undefined, dailyProfitTargetR: dailyProfitTargetR || undefined,
        maxConsecutiveLosses: maxConsecutiveLosses || undefined, maxTradesPerDay: maxTradesPerDay || undefined,
        maxTradesPerSession: maxTradesPerSession || undefined, trailingDrawdownR: trailingDrawdownR || undefined,
        enabled: true, spreadPips: spreadPips ?? 0, commissionPerLot: commissionPerLot ?? 0,
        partialClosePct: result.best.partialClosePct, slAfterTp1: result.best.slAfterTp1,
        tp15BeEnabled: result.best.tp15BeEnabled, atrTrailEnabled: result.best.atrTrailEnabled,
        structuralTrailEnabled: result.best.structuralTrailEnabled, tp1StructuralMinRR: tp1StructuralMinRR ?? 1.2,
    };
    const trainRes = runBacktest(logs, trainConfig, undefined, trainPrepared);
    for (const t of trainRes.trades) {
        if (t.triggerType === triggerKey && (t.points || 0) >= result.best.minScore) {
            if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) { trainPnlR += t.rMultiple; trainTrades++; }
        }
    }

    let oosPnlR: number | null = null, oosTrades: number | null = null;
    if (testPrepared.length > 0) {
        const oosRes = runBacktest(logs, trainConfig, undefined, testPrepared);
        let _oosPnlR = 0, _oosTrades = 0;
        for (const t of oosRes.trades) {
            if (t.triggerType === triggerKey && (t.points || 0) >= result.best.minScore) {
                if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) { _oosPnlR += t.rMultiple; _oosTrades++; }
            }
        }
        oosPnlR = Math.round(_oosPnlR * 100) / 100;
        oosTrades = _oosTrades;
    }

    const output = {
        best: result.best,
        top10: result.top10,
        evaluated: result.evaluated,
        trainPnlR: Math.round(trainPnlR * 100) / 100,
        trainTrades,
        oosPnlR: testPrepared.length > 0 ? oosPnlR : null,
        oosTrades: testPrepared.length > 0 ? oosTrades : null,
    };
    console.log(JSON.stringify(output));
}

main().catch(e => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
