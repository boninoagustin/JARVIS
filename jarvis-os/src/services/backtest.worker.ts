import { runBacktest } from './backtestEngine';

let cachedLogs: Map<string, string[]> | null = null;

self.onmessage = (e: MessageEvent) => {
  const { type, id, payload } = e.data;

  try {
    if (type === 'INIT_LOGS') {
      const { logsArray } = payload;
      cachedLogs = new Map<string, string[]>(logsArray);
      
      // Clear parse caches so it forces a re-parse for the new logs
      (globalThis as any)._cachedValidEntries = null;
      (globalThis as any)._cachedSyncEntries = null;
      (globalThis as any)._cachedRestEntries = null;
      
      self.postMessage({ type: 'DONE', id, result: 'OK' });
    }
    else if (type === 'RUN_BACKTEST') {
      const { logsArray, config } = payload;
      const logs = new Map<string, string[]>(logsArray);
      
      // Clear parse cache because it's a one-off run
      (globalThis as any)._cachedValidEntries = null;
      (globalThis as any)._cachedSyncEntries = null;
      (globalThis as any)._cachedRestEntries = null;
      
      const res = runBacktest(logs, config);
      self.postMessage({ type: 'DONE', id, result: res });
    }
    else if (type === 'RUN_BATCH') {
      const { configs } = payload;
      if (!cachedLogs) throw new Error("Logs not initialized in worker");
      
      // Execute all configs in the batch using the cached logs
      const results = configs.map((config: any) => runBacktest(cachedLogs!, config));
      
      self.postMessage({ type: 'DONE', id, result: results });
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', id, error: err.message });
  }
};
