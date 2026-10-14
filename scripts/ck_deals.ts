// ck_deals.ts — deals reales de la posición XAUUSD 289100359 (one-shot, el bot se reconecta solo)
import 'dotenv/config';
import { connectCTrader, getDealsByPosition, getAccountInfo } from '../src/services/ctrader.js';

const ok = await connectCTrader();
if (!ok) { console.error('no conectó'); process.exit(1); }
try {
  const acc = await getAccountInfo();
  console.log('CUENTA:', JSON.stringify({ currency: acc?.currency, balance: acc?.balance, equity: acc?.equity }));
  const deals = await getDealsByPosition('289100359');
  console.log('N deals:', deals.length);
  for (const d of deals) {
    console.log(JSON.stringify({
      id: d.dealId, type: d.type, side: d.tradeSide,
      filledVolume: d.filledVolume, executionPrice: d.executionPrice,
      moneyDigits: d.moneyDigits, grossProfit: d.grossProfit,
      commission: d.commission, swap: d.swap, balance: d.balance,
      closeTrigger: d.closePositionDetail?.closeTriggerBase ?? null,
    }));
  }
} catch (e: any) { console.error('ERR', e.message); }
process.exit(0);
