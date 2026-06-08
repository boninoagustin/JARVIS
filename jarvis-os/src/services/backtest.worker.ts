import { runBacktest, runPortfolioSimulation } from './backtestEngine';

self.onmessage = (e: MessageEvent) => {
  const { type, id, payload } = e.data;

  try {
    if (type === 'RUN_BACKTEST') {
      const { logsArray, config } = payload;
      const logs = new Map<string, string[]>(logsArray);
      
      const res = runBacktest(logs, config);
      self.postMessage({ type: 'DONE', id, result: res });
    }
    else if (type === 'RUN_BATCH') {
      const { logsArray, configs } = payload;
      const logs = new Map<string, string[]>(logsArray);
      
      // Execute all configs in the batch
      const results = configs.map((config: any) => runBacktest(logs, config));
      
      self.postMessage({ type: 'DONE', id, result: results });
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', id, error: err.message });
  }
};
