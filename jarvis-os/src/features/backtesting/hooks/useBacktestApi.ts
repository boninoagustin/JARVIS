/**
 * useBacktestApi — reemplaza useBacktestWorker con llamadas HTTP a Kronos.
 * Misma interfaz, cero cambios en BacktestingPanel.tsx.
 */
import { useRef, useCallback } from 'react';

const KRONOS_URL = 'http://169.58.163.132:8000';

export function useBacktestApi() {
    const uploadedTickers = useRef<Set<string>>(new Set());
    const currentTicker = useRef('');
    const currentTfs = useRef<string[]>([]);

    const runWorkerTask = useCallback(async (
        type: string,
        payload: any,
        onProgress?: (evaluated: number, budget: number, bestFitness: number) => void
    ): Promise<any> => {
        switch (type) {
            case 'SET_LOGS': {
                // Upload files to Kronos
                const { logsArray, ticker } = payload;
                currentTicker.current = ticker;
                const formData = new FormData();
                const tfs: string[] = [];
                
                for (const log of logsArray) {
                    const { tf, lines } = log;
                    const csvContent = typeof lines === 'string' ? lines : lines.join('\n');
                    const blob = new Blob([csvContent], { type: 'text/csv' });
                    formData.append('files', blob, `pine-logs-SMC Master_${tf}.csv`);
                    tfs.push(tf);
                }
                currentTfs.current = tfs;
                formData.append('ticker', ticker);

                const res = await fetch(`${KRONOS_URL}/api/backtest/upload`, {
                    method: 'POST',
                    body: formData,
                });
                if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
                const data = await res.json();
                uploadedTickers.current.add(ticker);
                return data;
            }

            case 'RUN_BACKTEST': {
                const { config, ticker } = payload;
                const tfs = currentTfs.current.join(',');
                const cfgStr = encodeURIComponent(JSON.stringify({
                    minBuyPoints: config.minBuyPoints || 5,
                    minSellPoints: config.minSellPoints || 5,
                    slBuffer: config.slBufferPercent || 0.0015,
                    fixedRR: config.fixedRR || 1.5,
                    entryTrigger: config.entryTrigger || 'SMART',
                    partialClosePct: config.partialClosePct || 0.5,
                    slAfterTp1: config.slAfterTp1 || 'midpoint',
                    tp15BeEnabled: config.tp15BeEnabled ?? true,
                    atrTrailEnabled: config.atrTrailEnabled ?? true,
                    structuralTrailEnabled: config.structuralTrailEnabled ?? false,
                    spreadPips: config.spreadPips || 1.5,
                    minRR: config.minRR || 0.75,
                }));

                const res = await fetch(
                    `${KRONOS_URL}/api/backtest/run?ticker=${ticker || currentTicker.current}&tfs=${tfs}&config_json=${cfgStr}`,
                    { method: 'POST' }
                );
                if (!res.ok) throw new Error(`Backtest failed: ${res.status}`);
                return await res.json();
            }

            case 'RUN_OPTIMIZATION': {
                const { ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, 
                    partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, 
                    structuralTrailEnabled, spreadPips } = payload;
                const tfs = currentTfs.current.join(',');
                const cfgStr = encodeURIComponent(JSON.stringify({
                    minBuyPoints: minBuyPoints || 5,
                    minSellPoints: minSellPoints || 5,
                    slBuffer: slBufferPercent || 0.0015,
                    fixedRR: fixedRR || 1.5,
                    partialClosePct: partialClosePct || 0.5,
                    slAfterTp1: slAfterTp1 || 'midpoint',
                    tp15BeEnabled: tp15BeEnabled ?? true,
                    atrTrailEnabled: atrTrailEnabled ?? true,
                    structuralTrailEnabled: structuralTrailEnabled ?? false,
                    spreadPips: spreadPips || 1.5,
                }));

                const res = await fetch(
                    `${KRONOS_URL}/api/backtest/optimize?ticker=${ticker || currentTicker.current}&tfs=${tfs}&config_json=${cfgStr}`,
                    { method: 'POST' }
                );
                if (!res.ok) throw new Error(`Optimize failed: ${res.status}`);
                const data = await res.json();
                // Simular progress (GA no reporta progreso en tiempo real por ahora)
                onProgress?.(50, 50, 0);
                return { optimized: data.optimized, metrics: data.metrics, trades: data.trades };
            }

            case 'RUN_BATCH': {
                // Múltiples simulaciones en secuencia
                const { configs } = payload;
                const results = [];
                for (const cfg of configs) {
                    try {
                        const res = await runWorkerTask('RUN_BACKTEST', { config: cfg, ticker: currentTicker.current });
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
