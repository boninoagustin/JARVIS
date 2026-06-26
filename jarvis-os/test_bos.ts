import { runBacktest } from './src/services/backtestEngine';
import fs from 'fs';

const logs = fs.readFileSync('./logs/pine-logs-SMC Master 5.1 [JARVIS v5.4]_24742.csv', 'utf8');

const config = {
  ticker: 'EURUSD',
  entryTrigger: 'BOTH',
  minBuyPoints: 10,
  minSellPoints: 10,
  oteEntryPercent: 50,
  fixedRR: 2,
  sessions: {
    'LONDON': {
      enabled: true,
      choch5m: { enabled: true, minScore: 10 },
      choch15m: { enabled: true, minScore: 10 },
      bos5m: { enabled: true, minScore: 10 },
      bos15m: { enabled: true, minScore: 10 },
      oteChoch5m: { enabled: true, minScore: 8 },
      oteChoch15m: { enabled: true, minScore: 8 },
      oteBos5m: { enabled: true, minScore: 8 },
      oteBos15m: { enabled: true, minScore: 8 },
      maxSellLosses: 3,
      maxBuyLosses: 3
    },
    'NY_AM': {
      enabled: true,
      choch5m: { enabled: true, minScore: 10 },
      choch15m: { enabled: true, minScore: 10 },
      bos5m: { enabled: true, minScore: 10 },
      bos15m: { enabled: true, minScore: 10 },
      oteChoch5m: { enabled: true, minScore: 8 },
      oteChoch15m: { enabled: true, minScore: 8 },
      oteBos5m: { enabled: true, minScore: 8 },
      oteBos15m: { enabled: true, minScore: 8 },
      maxSellLosses: 3,
      maxBuyLosses: 3
    },
    'NY_PM': { enabled: false },
    'ASIAN': { enabled: false }
  }
};

const results = runBacktest(logs, config as any);
const bosTrades = results.trades.filter(t => t.events?.some(e => e.includes('EVENTO_BOS')));
console.log('Total trades:', results.trades.length);
console.log('BOS trades:', bosTrades.length);
if(bosTrades.length > 0) {
  console.log(bosTrades[0]);
}
