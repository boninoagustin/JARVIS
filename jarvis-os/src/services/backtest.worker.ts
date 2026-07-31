import { runBacktest } from './backtestEngine';

let cachedLogs: Map<string, string[]> | null = null;

self.onmessage = (e: MessageEvent) => {
  const { type, id, payload } = e.data;

  try {
    // Clear cache to prevent stale logs between runs
    (globalThis as any)._cachedValidEntries = null;
    (globalThis as any)._cachedSyncEntries = null;
    (globalThis as any)._cachedRestEntries = null;

    if (type === 'SET_LOGS') {
      const { logsArray } = payload;
      cachedLogs = new Map<string, string[]>(logsArray);
      self.postMessage({ type: 'DONE', id, result: true });
    }
    else if (type === 'RUN_BACKTEST') {
      const { logsArray, config } = payload;
      const logs = logsArray ? new Map<string, string[]>(logsArray) : cachedLogs;
      if (!logs) throw new Error("No logs available in worker");
      
      const res = runBacktest(logs, config);
      self.postMessage({ type: 'DONE', id, result: res });
    }
    else if (type === 'RUN_BATCH') {
      const { logsArray, configs } = payload;
      const logs = logsArray ? new Map<string, string[]>(logsArray) : cachedLogs;
      if (!logs) throw new Error("No logs available in worker");
      
      // Execute all configs in the batch
      const results = configs.map((config: any) => runBacktest(logs, config));
      
      self.postMessage({ type: 'DONE', id, result: results });
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', id, error: err.message });
  }
};
