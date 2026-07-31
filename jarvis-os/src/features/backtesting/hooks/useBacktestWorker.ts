import { useRef, useCallback, useEffect } from 'react';

interface PendingTask {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  cancelId: number;
}

const POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 8);

export function useBacktestWorker() {
  const workersRef = useRef<Worker[]>([]);
  const nextWorkerIndex = useRef(0);
  const pendingRef = useRef<Map<number, PendingTask>>(new Map());
  const cancelledRef = useRef<Set<number>>(new Set());
  
  // Track logs set per worker
  const logsSetRef = useRef<boolean[]>(Array(POOL_SIZE).fill(false));
  const currentLogsArrayRef = useRef<any[] | null>(null);

  const initWorkers = useCallback(() => {
    if (workersRef.current.length === 0) {
      for (let i = 0; i < POOL_SIZE; i++) {
        workersRef.current.push(new Worker(
          new URL('../../../services/backtest.worker.ts', import.meta.url),
          { type: 'module' }
        ));
      }
    }
  }, []);

  useEffect(() => {
    initWorkers();
    return () => {
      workersRef.current.forEach(w => w.terminate());
      workersRef.current = [];
    };
  }, [initWorkers]);

  const runWorkerTask = useCallback((
    type: string,
    payload: any,
    onProgress?: (evaluated: number, budget: number, bestFitness: number) => void
  ): Promise<any> => {
    return new Promise(async (resolve, reject) => {
      initWorkers();

      // Ensure SET_LOGS is dispatched to ALL workers
      if (type === 'SET_LOGS') {
        currentLogsArrayRef.current = payload.logsArray;
        const promises = workersRef.current.map((w, idx) => {
          return new Promise((res, rej) => {
            const tempId = Date.now() + Math.random();
            const h = (e: MessageEvent) => {
              if (e.data.id === tempId) {
                w.removeEventListener('message', h);
                if (e.data.type === 'DONE') {
                  logsSetRef.current[idx] = true;
                  res(e.data.result);
                } else {
                  rej(e.data.error);
                }
              }
            };
            w.addEventListener('message', h);
            w.postMessage({ type: 'SET_LOGS', id: tempId, payload });
          });
        });
        try {
          const results = await Promise.all(promises);
          resolve(results[0]);
        } catch (err) {
          reject(err);
        }
        return;
      }

      // Round robin selection
      const workerIdx = nextWorkerIndex.current;
      nextWorkerIndex.current = (nextWorkerIndex.current + 1) % POOL_SIZE;
      const worker = workersRef.current[workerIdx];

      // Auto-set logs if missing on this worker (failsafe)
      if (!logsSetRef.current[workerIdx] && currentLogsArrayRef.current && type !== 'SET_LOGS') {
        try {
          await runWorkerTask('SET_LOGS', { logsArray: currentLogsArrayRef.current });
        } catch(e) {
          console.error("Failed auto-setting logs on worker", workerIdx, e);
        }
      }

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
          resolve(e.data.result);
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
        reject(new Error('Worker Task Timeout (10m)'));
      }, 600000);

      pendingRef.current.set(id, { resolve, reject, cancelId: id });
      worker.addEventListener('message', handler);
      worker.postMessage({ type, id, payload });
    });
  }, [initWorkers]);

  const cancelOptimization = useCallback((taskId: number) => {
    cancelledRef.current.add(taskId);
    workersRef.current.forEach(w => w.postMessage({ type: 'CANCEL', id: taskId, payload: {} }));
  }, []);

  const terminate = useCallback(() => {
    for (const [, task] of pendingRef.current) {
      task.reject(new Error('Worker terminated'));
    }
    pendingRef.current.clear();
    cancelledRef.current.clear();
    workersRef.current.forEach(w => w.terminate());
    workersRef.current = [];
    logsSetRef.current = Array(POOL_SIZE).fill(false);
  }, []);

  useEffect(() => {
    return () => {
      terminate();
    };
  }, [terminate]);

  return { runWorkerTask, cancelOptimization, terminate };
}
