// ck_positions.ts — snapshot de posiciones cTrader usando el cliente del bot (one-shot)
import 'dotenv/config';
import { connectCTrader, getOpenPositions } from '../src/services/ctrader.js';

const ok = await connectCTrader();
if (!ok) { console.error('no conectó'); process.exit(1); }
try {
  const pos = await getOpenPositions();
  console.log('N posiciones cTrader:', pos.length);
  for (const p of pos) {
    console.log(JSON.stringify({
      positionId: p.positionId, symbol: p.symbolName, side: p.tradeSide ?? p.direction,
      volume: p.volume, openPrice: p.openPrice ?? p.entryPrice,
      sl: p.stopLoss ?? p.sl, tp: p.takeProfit ?? p.tp,
      pnlUSD: p.profitUSD ?? p.grossProfit, price: p.currentPrice ?? p.price,
    }));
  }
} catch (e: any) { console.error('ERR', e.message); }
process.exit(0);
