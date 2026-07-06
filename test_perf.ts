import { loadLogs } from './scripts/optimize_eurusd.js';
import { runBacktest } from './jarvis-os/src/services/backtestEngine.js';

const logsMap = loadLogs();
const config = {
  ticker: 'EURUSD',
  minBuyPoints: 5,
  minSellPoints: 5,
  slBufferPercent: 5,
  fixedRR: 3,
  oteEntryPercent: 50,
  entryTrigger: 'CHOCH',
  sessions: {
    LONDON: { choch5m: { enabled: true, minScore: 5, entryPercent: 50 } },
    NY: { choch5m: { enabled: true, minScore: 5, entryPercent: 50 } },
    ASIA: { choch5m: { enabled: true, minScore: 5, entryPercent: 50 } },
    OFF: { choch5m: { enabled: true, minScore: 5, entryPercent: 50 } },
  }
} as any;

console.time("backtest1");
runBacktest(logsMap, config);
console.timeEnd("backtest1");

console.time("backtest2");
runBacktest(logsMap, config);
console.timeEnd("backtest2");

console.time("backtest3");
runBacktest(logsMap, config);
console.timeEnd("backtest3");
