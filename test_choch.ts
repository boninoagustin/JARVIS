import fs from 'fs';
import { parseCSV, runBacktest } from './jarvis-os/src/services/backtestEngine.js';

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
    "London": {
      "choch15m": { "enabled": true, "minScore": 4 },
      "bos15m": { "enabled": true, "minScore": 4 },
      "enabled": true
    },
    "New York": {
      "choch15m": { "enabled": true, "minScore": 4 },
      "bos15m": { "enabled": true, "minScore": 4 },
      "enabled": true
    }
  }
};

try {
  const result = runBacktest([{ name: 'xauusd', tf: detectedTF, lines, lineCount: lines.length }], config as any);
  console.log("SMART Trades:", result.trades.length);
} catch (e) {
  console.error(e);
}
