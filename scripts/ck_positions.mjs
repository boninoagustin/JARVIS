// ck_positions.mjs — snapshot de posiciones cTrader (one-shot, el bot se reconecta solo)
import 'dotenv/config';
import { connect } from 'ctrader-ts';
const { CTRADER_HOST, CTRADER_PORT, CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN, CTRADER_ACCOUNT_ID } = process.env;
try {
  const c = await connect({ host: CTRADER_HOST || 'demo.ctraderapi.com', port: Number(CTRADER_PORT || 5035), clientId: CTRADER_CLIENT_ID, clientSecret: CTRADER_CLIENT_SECRET, accessToken: CTRADER_ACCESS_TOKEN, accountId: Number(CTRADER_ACCOUNT_ID) });
  const r = await c.reconcile();
  console.log('N posiciones:', r.positions.length);
  r.positions.forEach(p => console.log(JSON.stringify({
    positionId: p.positionId, side: p.tradeData?.tradeSide,
    volume: p.tradeData?.volume, openPrice: p.tradeData?.openPrice,
    sl: p.tradeData?.stopLoss, tp: p.tradeData?.takeProfit,
    pnlUSD: p.profitInMoney != null ? p.profitInMoney / 100 : null,
    price: p.price,
  })));
  await c.close();
} catch (e) { console.error('ERR', e.message); process.exit(1); }
