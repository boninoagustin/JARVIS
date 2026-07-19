// ExecutionModel.ts - Manejo de órdenes y envío al broker (cTrader / Webhooks)

export interface OrderInstruction {
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    slPrice: number;
    tp1Price: number;
    tp2Price: number;
    lotSize?: number; // Si se calcula dinámicamente
}

export async function executeOrder(instruction: OrderInstruction): Promise<boolean> {
    // Aquí irá la lógica que antes hacía webhook calls directamente en trading.ts
    console.log(`[EXECUTION] Order sent: ${instruction.direction} ${instruction.ticker} @ ${instruction.entryPrice}`);
    return true;
}
