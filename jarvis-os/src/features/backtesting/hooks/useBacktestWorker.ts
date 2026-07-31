import { useRef, useCallback, useEffect } from 'react';

interface PendingTask {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  cancelId: number;
}

/**
 * Hook que gestiona el ciclo de vida del Web Worker de backtesting.
 * Soporta cancelación cooperativa de tareas RUN_OPTIMIZATION.
 */
export function useBacktestWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<number, PendingTask>>(new Map());
  const cancelledRef = useRef<Set<number>>(new Set());

  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL('../../../services/backtest.worker.ts', import.meta.url),
        { type: 'module' }
      );
    }
    return workerRef.current;
  }, []);

  /**
   * Encola una tarea al worker y devuelve una promesa.
   * Soporta callbacks: 'DONE', 'ERROR', 'CANCELLED', 'PROGRESS'.
   */
  const runWorkerTask = useCallback((
    type: string,
    payload: any,
    onProgress?: (evaluated: number, budget: number, bestFitness: number) => void
  ): Promise<any> => {
    return new Promise((resolve, reject) => {
      const worker = getWorker();
      const id = Date.now() + Math.random();
      let timeoutId: ReturnType<typeof setTimeout>;

      const handler = (e: MessageEvent) => {
        if (e.data.id !== id) return;

        if (e.data.type === 'DONE') {
          clearTimeout(timeoutId);
          worker.removeEventListener('message', handler);
          pendingRef.current.delete(id);
          resolve(e.data.result);
        } else if (e.data.type === 'CANCELLED') {
          clearTimeout(timeoutId);
          worker.removeEventListener('message', handler);
          pendingRef.current.delete(id);
          resolve(e.data.result); // Resolver (no rechazar) con lo mejor hasta ahora
        } else if (e.data.type === 'ERROR') {
          clearTimeout(timeoutId);
          worker.removeEventListener('message', handler);
          pendingRef.current.delete(id);
          reject(new Error(e.data.error));
        } else if (e.data.type === 'PROGRESS') {
          onProgress?.(e.data.evaluated, e.data.budget, e.data.bestFitness);
        }
      };

      timeoutId = setTimeout(() => {
        worker.removeEventListener('message', handler);
        pendingRef.current.delete(id);
        reject(new Error('Worker Task Timeout (5m)'));
      }, 300000);

      pendingRef.current.set(id, { resolve, reject, cancelId: id });
      worker.addEventListener('message', handler);
      worker.postMessage({ type, id, payload });
    });
  }, [getWorker]);

  /**
   * Cancela una tarea RUN_OPTIMIZATION en curso. El worker responde
   * con CANCELLED conteniendo el mejor resultado hasta el momento.
   */
  const cancelOptimization = useCallback((taskId: number) => {
    cancelledRef.current.add(taskId);
    getWorker().postMessage({ type: 'CANCEL', id: taskId, payload: {} });
  }, [getWorker]);

  /**
   * Termina el worker y rechaza todas las promesas pendientes.
   */
  const terminate = useCallback(() => {
    // Rechazar todas las promesas pendientes
    for (const [, task] of pendingRef.current) {
      task.reject(new Error('Worker terminated'));
    }
    pendingRef.current.clear();
    cancelledRef.current.clear();
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  // Limpiar al desmontar
  useEffect(() => {
    return () => {
      terminate();
    };
  }, [terminate]);

  return { runWorkerTask, cancelOptimization, terminate };
}
