import { runBacktest, prepareEntries } from './backtestEngine';
import { gridGenomes, gridCount, geneticSearch } from './optimizer';
import type { TriggerGenome } from './optimizer';
import type { LogEntry } from './backtestTypes';

let cachedLogs: Map<string, string[]> | null = null;
let preparedEntries: LogEntry[] | null = null;
const cancelledIds = new Set<number>();

self.onmessage = (e: MessageEvent) => {
  const { type, id, payload } = e.data;

  try {
    if (type === 'SET_LOGS') {
      const { logsArray } = payload;
      cachedLogs = new Map<string, string[]>(logsArray);
      // Pre-preparar entradas una sola vez para todas las simulaciones futuras
      preparedEntries = prepareEntries(cachedLogs);
      self.postMessage({ type: 'DONE', id, result: { entryCount: preparedEntries.length } });
    }
    else if (type === 'RUN_BACKTEST') {
      const { logsArray, config } = payload;
      const logs = logsArray ? new Map<string, string[]>(logsArray) : cachedLogs;
      if (!logs) throw new Error("No logs available in worker");
      const prep = logsArray ? prepareEntries(logs) : preparedEntries;
      
      const res = runBacktest(logs, config, undefined, prep ?? undefined);
      self.postMessage({ type: 'DONE', id, result: res });
    }
    else if (type === 'RUN_BATCH') {
      const { logsArray, configs } = payload;
      const logs = logsArray ? new Map<string, string[]>(logsArray) : cachedLogs;
      if (!logs) throw new Error("No logs available in worker");
      const prep = logsArray ? prepareEntries(logs) : preparedEntries;
      
      // Reuse prepared entries for all batch items
      const results = configs.map((config: any) => runBacktest(logs, config, undefined, prep ?? undefined));
      
      self.postMessage({ type: 'DONE', id, result: results });
    }
    else if (type === 'RUN_OPTIMIZATION') {
      const {
        ticker, baseConfig, sessionKey, triggerKey,
        strategy = 'grid', seed = 42, budget = 600,
        trainFraction = 0.7, minTrades = 15,
        minBuyPoints, minSellPoints, oteEntryPercent,
        maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses,
        maxTradesPerDay, maxTradesPerSession, trailingDrawdownR,
        spreadPips, commissionPerLot, tp1StructuralMinRR,
        slBufferPercent, fixedRR,
      } = payload;

      const logs = cachedLogs;
      if (!logs) throw new Error("No logs available in worker. Send SET_LOGS first.");
      if (!preparedEntries) throw new Error("Entries not prepared. Send SET_LOGS first.");

      const total = preparedEntries.length;
      const splitIdx = Math.floor(total * trainFraction);
      const trainPrepared = preparedEntries.slice(0, splitIdx);
      const testPrepared = preparedEntries.slice(splitIdx);

      if (trainPrepared.length === 0) throw new Error("Train split is empty");

      // Función de evaluación (cierra sobre las variables del scope)
      const evaluate = (genome: TriggerGenome): number => {
        if (cancelledIds.has(id)) return -Infinity;

        // Construir config una vez mutando solo triggerKey
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
          minBuyPoints: minBuyPoints ?? 4,
          minSellPoints: minSellPoints ?? 4,
          slBufferPercent: slBufferPercent ?? 0.1,
          fixedRR: fixedRR ?? 2.0,
          oteEntryPercent: oteEntryPercent ?? 50,
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

        let pnlR = 0;
        let wins = 0;
        let totalTrades = 0;

        for (const t of res.trades) {
          if (t.triggerType === triggerKey && (t.points || 0) >= genome.minScore) {
            if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) {
              pnlR += t.rMultiple;
              totalTrades++;
              if (t.rMultiple > 0) wins++;
            }
          }
        }

        // Penalizar pocos trades (umbral bajo para no descartar sesiones válidas)
        if (totalTrades < minTrades) {
          return -1000 + totalTrades;
        }

        // Fitness: PnL puro con WR como tiebreaker (idéntico al viejo optimizador)
        const wr = totalTrades > 0 ? wins / totalTrades : 0;
        return pnlR + wr * 0.001;
      };

      // Ejecutar estrategia
      let result: { best: TriggerGenome; top10: TriggerGenome[]; evaluated: number };

      if (strategy === 'ga') {
        result = geneticSearch({
          evaluate,
          budget: budget ?? 600,
          seed: seed ?? 42,
          populationSize: 24,
          maxGenerations: 20,
          elite: 2,
          tournamentK: 3,
          mutationRate: 0.15,
          earlyStopGens: 6,
          onProgress: (evaluated, budget, _bestGenome, bestFitness) => {
            self.postMessage({
              type: 'PROGRESS', id,
              evaluated, budget, bestFitness,
            });
          },
        });
      } else {
        // Grid exhaustivo
        let bestGenome: TriggerGenome = { minScore: 4, slBuff: 0, tp2: 1.5, partialClosePct: 0, slAfterTp1: 'none', tp15BeEnabled: false, atrTrailEnabled: false, structuralTrailEnabled: false, minimal_roi: null };
        let bestFitness = -Infinity;
        const allResults: { genome: TriggerGenome; fitness: number }[] = [];
        const totalGrid = gridCount();
        let evalCount = 0;

        for (const genome of gridGenomes()) {
          if (cancelledIds.has(id)) {
            self.postMessage({ type: 'CANCELLED', id, result: { best: bestGenome, evaluated: evalCount } });
            return;
          }
          const fitness = evaluate(genome);
          allResults.push({ genome: { ...genome }, fitness });
          evalCount++;

          if (fitness > bestFitness) {
            bestFitness = fitness;
            bestGenome = { ...genome };
          }

          if (evalCount % 100 === 0) {
            self.postMessage({
              type: 'PROGRESS', id,
              evaluated: evalCount, budget: totalGrid, bestFitness,
            });
          }
        }

        allResults.sort((a, b) => b.fitness - a.fitness);
        result = {
          best: allResults[0].genome,
          top10: allResults.slice(0, 10).map(x => x.genome),
          evaluated: evalCount,
        };
      }

      if (cancelledIds.has(id)) {
        self.postMessage({ type: 'CANCELLED', id, result: { best: result.best, evaluated: result.evaluated } });
        return;
      }

      // Re-evaluar el mejor sobre test set (out-of-sample)
      let trainPnlR = 0;
      let trainTrades = 0;
      let oosPnlR = 0;
      let oosTrades = 0;

      // Train (ya lo tenemos del evaluate final)
      const trainSessions = JSON.parse(JSON.stringify(baseConfig.sessions));
      if (!trainSessions[sessionKey]) trainSessions[sessionKey] = {};
      trainSessions[sessionKey][triggerKey] = {
        ...(trainSessions[sessionKey][triggerKey] || { enabled: true }),
        minScore: result.best.minScore,
        slBuff: result.best.slBuff,
        tp2: result.best.tp2,
        partialClosePct: result.best.partialClosePct,
        slAfterTp1: result.best.slAfterTp1,
        tp15BeEnabled: result.best.tp15BeEnabled,
        atrTrailEnabled: result.best.atrTrailEnabled,
        structuralTrailEnabled: result.best.structuralTrailEnabled,
        enabled: true,
      };
      const trainConfig = {
        ticker, entryTrigger: 'SMART', sessions: trainSessions, sessionFilter: [sessionKey],
        minBuyPoints: minBuyPoints ?? 4, minSellPoints: minSellPoints ?? 4,
        slBufferPercent: slBufferPercent ?? 0.1, fixedRR: fixedRR ?? 2.0,
        oteEntryPercent: oteEntryPercent ?? 50,
        maxDailyLossR: maxDailyLossR || undefined,
        dailyProfitTargetR: dailyProfitTargetR || undefined,
        maxConsecutiveLosses: maxConsecutiveLosses || undefined,
        maxTradesPerDay: maxTradesPerDay || undefined,
        maxTradesPerSession: maxTradesPerSession || undefined,
        trailingDrawdownR: trailingDrawdownR || undefined,
        enabled: true, spreadPips: spreadPips ?? 0, commissionPerLot: commissionPerLot ?? 0,
        partialClosePct: result.best.partialClosePct,
        slAfterTp1: result.best.slAfterTp1,
        tp15BeEnabled: result.best.tp15BeEnabled,
        atrTrailEnabled: result.best.atrTrailEnabled,
        structuralTrailEnabled: result.best.structuralTrailEnabled,
        tp1StructuralMinRR: tp1StructuralMinRR ?? 1.2,
      };
      const trainRes = runBacktest(logs, trainConfig as any, undefined, trainPrepared);
      for (const t of trainRes.trades) {
        if (t.triggerType === triggerKey && (t.points || 0) >= result.best.minScore) {
          if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) {
            trainPnlR += t.rMultiple;
            trainTrades++;
          }
        }
      }

      // OOS
      if (testPrepared.length > 0) {
        const oosRes = runBacktest(logs, trainConfig as any, undefined, testPrepared);
        for (const t of oosRes.trades) {
          if (t.triggerType === triggerKey && (t.points || 0) >= result.best.minScore) {
            if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) {
              oosPnlR += t.rMultiple;
              oosTrades++;
            }
          }
        }
      }

      self.postMessage({
        type: 'DONE', id,
        result: {
          best: result.best,
          top10: result.top10,
          evaluated: result.evaluated,
          trainPnlR: Math.round(trainPnlR * 100) / 100,
          trainTrades,
          oosPnlR: testPrepared.length > 0 ? Math.round(oosPnlR * 100) / 100 : null,
          oosTrades: testPrepared.length > 0 ? oosTrades : null,
        }
      });
    }
    else if (type === 'CANCEL') {
      cancelledIds.add(id);
      self.postMessage({ type: 'DONE', id, result: true });
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', id, error: err.message });
  }
};
