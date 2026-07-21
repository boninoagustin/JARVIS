import type { ActiveTrade } from './Types.js';
import { getDecimals } from './AlphaModel.js';

export interface FrictionConfig {
    commissionPerLot: number; // Comisión por lado (ej. $3)
    baseSpreadPips: number;   // Spread raw promedio (ej. 0.1)
    latencyMs: number;        // Latencia estimada al broker
}

export const defaultFrictionConfig: Record<string, FrictionConfig> = {
    'FOREX': { commissionPerLot: 3.0, baseSpreadPips: 0.1, latencyMs: 50 },
    'CRYPTO': { commissionPerLot: 0.0, baseSpreadPips: 2.0, latencyMs: 50 },
    'INDICES': { commissionPerLot: 0.0, baseSpreadPips: 1.0, latencyMs: 50 },
    'METALS': { commissionPerLot: 3.0, baseSpreadPips: 1.0, latencyMs: 50 },
};

function getAssetClass(ticker: string): string {
    const t = ticker.toUpperCase();
    if (t.includes('BTC') || t.includes('ETH')) return 'CRYPTO';
    if (['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI'].some(i => t.includes(i))) return 'INDICES';
    if (t.includes('XAU') || t.includes('GOLD')) return 'METALS';
    return 'FOREX';
}

export function getPipValue(ticker: string, currentPrice: number): number {
    const assetClass = getAssetClass(ticker);
    if (assetClass === 'FOREX') {
        if (ticker.includes('JPY')) return 0.01;
        return 0.0001;
    }
    if (assetClass === 'INDICES') return 1.0;
    if (assetClass === 'METALS') return 0.1;
    if (assetClass === 'CRYPTO') return currentPrice * 0.0001; // Proxy dinámico
    return 0.0001;
}

export function evaluateNetTrade(
    trade: ActiveTrade, 
    nowMs: number, 
    customConfig?: FrictionConfig
): { approved: boolean; netTrade: ActiveTrade; reason?: string; frictionCostDetails?: string } {
    const assetClass = getAssetClass(trade.ticker);
    const config = customConfig || defaultFrictionConfig[assetClass];
    const pipValue = getPipValue(trade.ticker, trade.entryPrice);
    const decimals = getDecimals(trade.ticker);

    // 1. Spread Dinámico (Aumentado por horario o por defecto)
    let activeSpreadPips = config.baseSpreadPips;
    const hourUTC = new Date(nowMs).getUTCHours();
    // Horario Rollover: 21:00 a 22:00 UTC (Spread se abre masivamente)
    if (hourUTC === 21) {
        activeSpreadPips *= 5; // Simulación del "Death Spread" del Rollover
    }
    const spreadCost = activeSpreadPips * pipValue;
    
    // 2. Slippage por latencia (0.1 pips por cada 50ms)
    const slippagePips = (config.latencyMs / 50) * 0.1;
    const slippageCost = slippagePips * pipValue;

    // Fricción Total en la entrada (Peor precio)
    const entryFriction = spreadCost + slippageCost;
    
    // Aplicamos el peor precio de entrada al simulador
    const netEntryPrice = trade.direction === 'BUY' 
        ? trade.entryPrice + entryFriction 
        : trade.entryPrice - entryFriction;
    
    // 3. Costo de Comisión convertido a impacto en Precio
    // Para propósitos de R:R de backtest, convertimos los $6 (Round Turn) a pips.
    // Aproximación estándar: $10 = 1 pip. Entonces $6 = 0.6 pips extra de costo.
    const commissionRoundTurn = config.commissionPerLot * 2;
    const commissionPips = commissionRoundTurn / 10;
    const commissionCostInPrice = commissionPips * pipValue;

    const frictionCostDetails = `Spread: ${activeSpreadPips.toFixed(2)} pips | Slip: ${slippagePips.toFixed(2)} pips | Com: ${commissionPips.toFixed(2)} pips (Total R:R Merma)`;

    // 4. Recalcular Beneficio Neto vs Riesgo Real
    const grossRiskDistance = Math.abs(trade.entryPrice - trade.slPrice);
    const minRisk = Math.max(Number.EPSILON, pipValue * 0.5); // media unidad de precisión mínima
    if (grossRiskDistance <= minRisk) {
        return { 
            approved: false, 
            netTrade: trade, 
            reason: 'Riesgo bruto insuficiente (SL demasiado cerca del entry).',
            frictionCostDetails
        };
    }
    const netRiskDistance = grossRiskDistance + entryFriction + commissionCostInPrice;
    
    const grossRewardDistance = Math.abs(trade.tp1Price - trade.entryPrice);
    const netRewardDistance = grossRewardDistance - entryFriction - commissionCostInPrice;

    if (netRewardDistance <= 0) {
        return { 
            approved: false, 
            netTrade: trade, 
            reason: `Fricción devoró la ganancia (Neto negativo).`,
            frictionCostDetails
        };
    }

    let netRR = netRewardDistance / netRiskDistance;

    const hasTp2 = trade.tp2Price !== undefined && trade.tp2Price !== trade.tp1Price && trade.tp2Price !== 0;
    if (hasTp2) {
        const grossRewardDistanceTp2 = Math.abs(trade.tp2Price - trade.entryPrice);
        const netRewardDistanceTp2 = grossRewardDistanceTp2 - entryFriction - commissionCostInPrice;
        if (netRewardDistanceTp2 > 0) {
            const netRRTp2 = netRewardDistanceTp2 / netRiskDistance;
            // Evaluamos la viabilidad global del trade basándonos en TP2 si existe
            netRR = Math.max(netRR, netRRTp2);
        }
    }

    const MIN_NET_RR = 0.8; // Permitimos un poco menos de 1.0 porque TP1 neto suele ser < 1.0 tras spread/comisiones
    if (netRR < MIN_NET_RR) {
        return {
            approved: false,
            netTrade: trade,
            reason: `Net R:R inaceptable (${netRR.toFixed(2)} < ${MIN_NET_RR}). El Broker absorbe la rentabilidad.`,
            frictionCostDetails
        };
    }

    const modifiedTrade = { ...trade };
    modifiedTrade.entryPrice = parseFloat(netEntryPrice.toFixed(decimals));
    // SL y TP NO se modifican: son niveles de orden, la fricción actúa en el fill.

    return {
        approved: true,
        netTrade: modifiedTrade,
        frictionCostDetails
    };
}
