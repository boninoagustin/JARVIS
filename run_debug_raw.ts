import fs from 'fs';
import { runBacktest } from './jarvis-os/src/services/backtestEngine.js';

const content = fs.readFileSync('pine-logs-SMC Master 5.1 [JARVIS v5.4]_c450d.csv', 'utf8');
const linesRaw = content.split('\n').filter(r => r.includes('| TS: '));
const config = {
  asset: 'XAUUSD',
  riskUsd: 50,
  spreadPips: 2,
  commissionPerLot: 6,
  minRR: 1.5,
  minBuyPoints: 4,
  minSellPoints: 4,
  entryTrigger: 'SMART',
  sessions: {
    "LONDON": { "choch15m": { "enabled": true, "minScore": 4 }, "bos15m": { "enabled": true, "minScore": 4 }, "enabled": true },
    "NY": { "choch15m": { "enabled": true, "minScore": 4 }, "bos15m": { "enabled": true, "minScore": 4 }, "enabled": true }
  }
};
const result = runBacktest([{ name: 'xauusd', tf: '15', lines: linesRaw as any, lineCount: linesRaw.length }], config as any);
console.log("SMART Trades:", result.trades.length);
console.log("SMART Breakdown:", result.trades.map(t => t.triggerType));
