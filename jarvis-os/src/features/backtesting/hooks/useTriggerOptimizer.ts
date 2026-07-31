import { useCallback } from 'react';
import { useBacktestingStore } from '../store';
import type { useBacktestWorker } from './useBacktestWorker';

type WorkerApi = ReturnType<typeof useBacktestWorker>;

/**
 * Hook para la optimización de gatillos con soporte GA y Grid,
 * usando el protocolo RUN_OPTIMIZATION del worker.
 */
export function useTriggerOptimizer(workerApi: WorkerApi) {
  const store = useBacktestingStore;

  const handleOptimizeTrigger = useCallback(async (
    sessionKey: string,
    triggerKey: string,
    strategy: 'grid' | 'ga' = 'ga',
    budget = 600,
    trainFraction = 0.7
  ) => {
    const state = store.getState();
    if (state.optimizingTrigger) return;

    if (state.uploadedFiles.length === 0) {
      // toast handled externally
      return false;
    }

    store.setState({ optimizingTrigger: `${sessionKey}-${triggerKey}`, optimizeProgress: 0 });

    // Construir baseConfig (todos los triggers desactivados excepto el target)
    const baseConfig = JSON.parse(JSON.stringify(state.sessionTriggers));
    Object.keys(baseConfig).forEach((sk: string) => {
      if (typeof baseConfig[sk] === 'object' && baseConfig[sk] !== null) {
        Object.keys(baseConfig[sk]).forEach((tk: string) => {
          if (typeof baseConfig[sk][tk] === 'object' && baseConfig[sk][tk] !== null) {
            baseConfig[sk][tk].enabled = false;
          }
        });
      }
    });
    if (!baseConfig[sessionKey]) baseConfig[sessionKey] = {};
    if (!baseConfig[sessionKey][triggerKey]) baseConfig[sessionKey][triggerKey] = { enabled: true, minScore: 4 };
    baseConfig[sessionKey][triggerKey].enabled = true;

    // Enviar logs al worker UNA vez
    const logs = new Map<string, string[]>();
    state.uploadedFiles.forEach(f => logs.set(f.tf, f.lines));
    const logsArray = Array.from(logs.entries());

    try {
      await workerApi.runWorkerTask('SET_LOGS', { logsArray });
    } catch (e) {
      console.error('Error setting logs in worker', e);
      store.setState({ optimizingTrigger: null });
      return false;
    }

    // Lanzar optimización (UN solo mensaje, todo dentro del worker)
    const payload = {
      ticker: state.ticker,
      baseConfig: { sessions: baseConfig },
      sessionKey,
      triggerKey,
      strategy,
      seed: Date.now() % 100000,
      budget,
      trainFraction,
      minTrades: 15,
      minBuyPoints: state.minBuyPoints,
      minSellPoints: state.minSellPoints,
      oteEntryPercent: state.oteEntryPercent,
      maxDailyLossR: state.maxDailyLossR,
      dailyProfitTargetR: state.dailyProfitTargetR,
      maxConsecutiveLosses: state.maxConsecutiveLosses,
      maxTradesPerDay: state.maxTradesPerDay,
      maxTradesPerSession: state.maxTradesPerSession,
      trailingDrawdownR: state.trailingDrawdownR,
      spreadPips: state.spreadPips,
      commissionPerLot: state.commissionPerLot,
      tp1StructuralMinRR: state.tp1StructuralMinRR,
      slBufferPercent: state.slBufferPercent,
      fixedRR: state.fixedRR,
    };

    try {
      const optResult = await workerApi.runWorkerTask(
        'RUN_OPTIMIZATION',
        payload,
        (evaluated, budget, _bestFitness) => {
          store.setState({ optimizeProgress: budget > 0 ? evaluated / budget : 0 });
        }
      );

      if (!optResult || !optResult.best) {
        store.setState({ optimizingTrigger: null });
        return false;
      }

      // Guardar el mejor resultado en sessionTriggers
      const current = store.getState().sessionTriggers;
      const next = JSON.parse(JSON.stringify(current));
      if (!next[sessionKey]) next[sessionKey] = {};
      next[sessionKey][triggerKey] = {
        ...(next[sessionKey][triggerKey] || { enabled: true }),
        minScore: optResult.best.minScore,
        slBuff: optResult.best.slBuff,
        tp2: optResult.best.tp2,
        partialClosePct: optResult.best.partialClosePct,
        slAfterTp1: optResult.best.slAfterTp1,
        tp15BeEnabled: optResult.best.tp15BeEnabled,
        atrTrailEnabled: optResult.best.atrTrailEnabled,
        structuralTrailEnabled: optResult.best.structuralTrailEnabled,
      };
      localStorage.setItem('bt_session_triggers', JSON.stringify(next));
      store.setState({
        sessionTriggers: next,
        optimizingTrigger: null,
        optimizeProgress: 0,
      });

      return {
        trainPnlR: optResult.trainPnlR,
        trainTrades: optResult.trainTrades,
        oosPnlR: optResult.oosPnlR,
        oosTrades: optResult.oosTrades,
        evaluated: optResult.evaluated,
        bestConfig: optResult.best,
      };
    } catch (err: any) {
      console.error('Optimization failed:', err);
      store.setState({ optimizingTrigger: null });
      return false;
    }
  }, [workerApi, store]);

  const cancelOptimization = useCallback(async (taskId: number) => {
    workerApi.cancelOptimization(taskId);
  }, [workerApi]);

  return { handleOptimizeTrigger, cancelOptimization };
}
