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
    "LONDON": {
      "choch15m": { "enabled": true, "minScore": 4 },
      "bos15m": { "enabled": true, "minScore": 4 },
      "choch5m": { "enabled": true, "minScore": 4 },
      "bos5m": { "enabled": true, "minScore": 4 },
      "enabled": true
    },
    "NY": {
      "choch15m": { "enabled": true, "minScore": 4 },
      "bos15m": { "enabled": true, "minScore": 4 },
      "choch5m": { "enabled": true, "minScore": 4 },
      "bos5m": { "enabled": true, "minScore": 4 },
      "enabled": true
    }
  }
};

const engineCode = fs.readFileSync('./jarvis-os/src/services/backtestEngine.ts', 'utf8');
const dirtyCode = engineCode
  .replace(/export function runBacktest\(files: UploadedFile\[\], config: BacktestConfig\): BacktestResult {/g, 'export function runBacktestLocal(files: UploadedFile[], config: BacktestConfig): BacktestResult {')
  .replace(/if \(efectiveValidation && triggerEnabled && totalPoints >= minPtsRequired\) {/, 'console.log("Validation CHOCH/BOS:", {efectiveValidation, triggerEnabled, totalPoints, minPtsRequired, prefix, currentSession});\nif (efectiveValidation && triggerEnabled && totalPoints >= minPtsRequired) {');
fs.writeFileSync('./debug_engine.ts', dirtyCode);
