import { runBacktest, preParseLogsAsync } from './backtestEngine';

let cachedLogs: Map<string, string[]> | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data;
  
  try {
    if (type === 'INIT_LOGS') {
      const { logsArray } = payload;
      cachedLogs = new Map<string, string[]>(logsArray);
      
      (globalThis as any)._cachedValidEntries = null;
      (globalThis as any)._cachedSyncEntries = null;
      (globalThis as any)._cachedRestEntries = null;

      await preParseLogsAsync(cachedLogs);
      
      self.postMessage({ type: 'DONE', id, result: 'OK' });
    }
    else if (type === 'RUN_BACKTEST') {
      const { logsArray, config } = payload;
      let logsToUse = cachedLogs;
      
      if (logsArray) {
          logsToUse = new Map<string, string[]>(logsArray);
          (globalThis as any)._cachedValidEntries = null;
          (globalThis as any)._cachedSyncEntries = null;
          (globalThis as any)._cachedRestEntries = null;
      }
      
      if (!logsToUse) throw new Error("No logs available");
      
      const res = runBacktest(logsToUse, config);
      self.postMessage({ type: 'DONE', id, result: res });
    }
    else if (type === 'RUN_BATCH') {
      const { configs } = payload;
      if (!cachedLogs) throw new Error("Logs not initialized in worker");
      
      const results = [];
      for (let i = 0; i < configs.length; i++) {
          const config = configs[i];
          const res = runBacktest(cachedLogs!, config);
          const pnlBySession: Record<string, number> = { OFF: 0, LONDON: 0, NY: 0, ASIA: 0 };
          
          res.trades.forEach((t: any) => {
              if (t.result && t.result !== 'TIMEOUT') {
                  const d = new Date(t.timestamp);
                  const arHour = (d.getUTCHours() + 21) % 24;
                  const arMin = d.getUTCMinutes();
                  const timeDecimal = arHour + arMin / 60;
                  
                  let s = 'OFF';
                  if (timeDecimal >= 21 || timeDecimal < 4) s = 'ASIA';
                  else if (timeDecimal >= 4 && timeDecimal < 10.5) s = 'LONDON';
                  else if (timeDecimal >= 10.5 && timeDecimal < 17) s = 'NY';
                  
                  pnlBySession[s] = (pnlBySession[s] || 0) + (t.rMultiple || 0);
              }
          });
          
          results.push({ pnlBySession });
          await new Promise(r => setTimeout(r, 0));
      }
      
      self.postMessage({ type: 'DONE', id, result: results });
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', id, error: err.message });
  }
};
