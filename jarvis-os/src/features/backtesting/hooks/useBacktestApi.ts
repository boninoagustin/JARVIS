/**
 * useBacktestApi — reemplaza useBacktestWorker con llamadas HTTP a Kronos v2.
 * El upload se hace directo desde handleFilesUpload. Este hook solo llama los endpoints.
 */
import { useCallback } from 'react';

const KRONOS_URL = 'http://169.58.163.132:8000';

export function useBacktestApi() {
    const runWorkerTask = useCallback(async (
        type: string,
        payload: any,
        onProgress?: (evaluated: number, budget: number, bestFitness: number) => void
    ): Promise<any> => {
        switch (type) {
            case 'SET_LOGS':
                // Ya no se usa — el upload se hace directo desde handleFilesUpload
                return { status: 'ok' };

            case 'RUN_BACKTEST': {
                const { config } = payload;
                const ticker = config.ticker || payload.ticker || '';
                const tfs = (config.tfs || []).join(',');
                // Pasar el config COMPLETO (incluye sessions, sessionFilter, etc.)
                const cfgStr = encodeURIComponent(JSON.stringify(config));

                const res = await fetch(
                    `${KRONOS_URL}/api/backtest/run?ticker=${encodeURIComponent(ticker)}&tfs=${encodeURIComponent(tfs)}&config_json=${cfgStr}`,
                    { method: 'POST' }
                );
                if (!res.ok) throw new Error(`Backtest failed: ${res.status}`);
                return await res.json();
            }

            case 'RUN_OPTIMIZATION': {
                const { ticker, ...rest } = payload;
                const tfs = (rest.tfs || []).join(',');
                const cfgStr = encodeURIComponent(JSON.stringify({
                    minBuyPoints: rest.minBuyPoints || 5,
                    minSellPoints: rest.minSellPoints || 5,
                    slBuffer: rest.slBufferPercent || 0.0015,
                    fixedRR: rest.fixedRR || 1.5,
                    partialClosePct: rest.partialClosePct || 0.5,
                    slAfterTp1: rest.slAfterTp1 || 'midpoint',
                    tp15BeEnabled: rest.tp15BeEnabled ?? true,
                    atrTrailEnabled: rest.atrTrailEnabled ?? true,
                    structuralTrailEnabled: rest.structuralTrailEnabled ?? false,
                    spreadPips: rest.spreadPips || 1.5,
                }));

                const res = await fetch(
                    `${KRONOS_URL}/api/backtest/optimize?ticker=${encodeURIComponent(ticker || '')}&tfs=${encodeURIComponent(tfs)}&config_json=${cfgStr}`,
                    { method: 'POST' }
                );
                if (!res.ok) throw new Error(`Optimize failed: ${res.status}`);
                const data = await res.json();
                onProgress?.(50, 50, 0);
                return { optimized: data.optimized, metrics: data.metrics, trades: data.trades };
            }

            case 'RUN_BATCH': {
                const { configs } = payload;
                const results = [];
                for (const cfg of configs) {
                    try {
                        const res = await runWorkerTask('RUN_BACKTEST', { config: cfg });
                        results.push(res);
                    } catch (e) {
                        results.push({ error: String(e) });
                    }
                }
                return results;
            }

            default:
                throw new Error(`Unknown task type: ${type}`);
        }
    }, []);

    const cancelOptimization = useCallback(() => {}, []);
    const terminate = useCallback(() => {}, []);

    return { runWorkerTask, cancelOptimization, terminate };
}
