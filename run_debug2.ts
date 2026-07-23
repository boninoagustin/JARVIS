import fs from 'fs';
import { parseCSV } from './jarvis-os/src/services/backtestEngine.js';
import { runBacktestLocal } from './debug_engine.ts';

const content = fs.readFileSync('pine-logs-SMC Master 5.1 [JARVIS v5.4]_c450d.csv', 'utf8');
const { lines, detectedTF } = parseCSV(content);
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
    "LONDON": {
      "choch15m": { "enabled": true, "minScore": 4 },
      "bos15m": { "enabled": true, "minScore": 4 },
      "enabled": true
    },
    "NY": {
      "choch15m": { "enabled": true, "minScore": 4 },
      "bos15m": { "enabled": true, "minScore": 4 },
      "enabled": true
    }
  }
};
// files array requires string[] for logs
// we will construct f.lines as string[] by reading the file
const linesRaw = content.split('\n');
const result = runBacktestLocal([{ name: 'xauusd', tf: detectedTF, lines: linesRaw, lineCount: linesRaw.length }], config as any);
console.log("SMART Trades:", result.trades.length);
