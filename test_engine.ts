import { runBacktest, BacktestConfig } from './jarvis-os/src/services/backtestEngine.ts';

const logs = new Map<string, string[]>();
logs.set('3', [
    'PING_PRICE, TS: 10, Precio: 100, High: 100, Low: 100, TF: 3, BUY',
    'EVENTO_BUY_3M, TS: 20, ORIGIN: 100, Precio: 200, Payload: {}, BUY', 
    'VALIDACION_EFECTIVA, TS: 25, TF: 3, Payload: {}, BUY',
    'PING_PRICE, TS: 30, Precio: 200, High: 200, Low: 200, TF: 3, BUY',
    'PING_PRICE, TS: 40, Precio: 138, High: 138, Low: 138, TF: 3, BUY', 
    'PING_PRICE, TS: 50, Precio: 200, High: 200, Low: 200, TF: 3, BUY', 
    'PING_PRICE, TS: 60, Precio: 230, High: 230, Low: 230, TF: 3, BUY', 
]);

const config: BacktestConfig = {
    ticker: 'TEST',
    minBuyPoints: 0,
    minSellPoints: 0,
    slBufferPercent: 0,
    fixedRR: 2.0,
    oteEntryPercent: 62,
    entryTrigger: 'BOTH'
};

const res = runBacktest(logs, config);
console.log(JSON.stringify(res.trades.map(t => ({ id: t.id, events: t.events, rTp1: t.rMultipleTp1, rTp2: t.rMultipleTp2, pnl: t.pnl })), null, 2));
