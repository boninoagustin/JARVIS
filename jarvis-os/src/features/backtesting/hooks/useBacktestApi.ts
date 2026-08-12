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
                // Pasar el payload COMPLETO (baseConfig, sessionKey, triggerKey, etc.)
                const cfgStr = encodeURIComponent(JSON.stringify(payload));

                const res = await fetch(
                    `${KRONOS_URL}/api/backtest/optimize?ticker=${encodeURIComponent(ticker || '')}&tfs=${encodeURIComponent(tfs)}&config_json=${cfgStr}`,
                    { method: 'POST' }
                );
                if (!res.ok) throw new Error(`Optimize failed: ${res.status}`);
                // El VPS devuelve { best, top10, evaluated, trainPnlR, ... } — pasarlo directo
                return await res.json();
            }

            case 'RUN_BATCH': {
                const { configs } = payload;
                const results = [];
                for (const cfg of configs) {
                    try {
                        const res = await runWorkerTask('RUN_BACKTEST', { config: cfg });
                        // Computar pnlR/wins/total igual que el viejo worker
                        let pnlR = 0, wins = 0, total = 0;
                        (res.trades || []).forEach((t: any) => {
                            if (t.rMultiple !== undefined && !Number.isNaN(t.rMultiple)) {
                                pnlR += t.rMultiple;
                                total++;
                                if (t.rMultiple > 0) wins++;
                            }
                        });
                        results.push({ pnlR, wins, total });
                    } catch (e) {
                        results.push({ pnlR: 0, wins: 0, total: 0, error: String(e) });
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
