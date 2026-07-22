// ExecutionModel.ts - Manejo de órdenes y envío al broker (cTrader / Webhooks)
import { executeMarketOrder } from '../services/ctrader.js';

export interface OrderInstruction {
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    slPrice: number;
    tp1Price: number;
    tp2Price?: number;
    lotSize?: number; // Si se calcula dinámicamente
    tradeId?: string; // Para trazar la orden
}

export async function executeOrder(instruction: OrderInstruction): Promise<boolean> {
    const result = await executeMarketOrder({
        ticker: instruction.ticker,
        direction: instruction.direction,
        entryPrice: instruction.entryPrice,
        slPrice: instruction.slPrice,
        tp1Price: instruction.tp1Price,
        tp2Price: instruction.tp2Price,
        tradeId: instruction.tradeId || 'UNKNOWN'
    });
    if (!result.success) {
        console.error(`[EXECUTION] ❌ ${result.error}`);
    } else {
        console.log(`[EXECUTION] ✅ Order sent: ${instruction.direction} ${instruction.ticker} @ ${instruction.entryPrice}`);
    }
    return result.success;
}
