import type { ExecutionCostEstimate, ExecutionCostInput, ExecutionDirection, ExecutionInstrument, ExecutionQuote, ExecutionRegime } from './ExecutionTypes.ts';

const CURRENCIES = new Set(['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD','SEK','NOK','DKK','SGD','HKD','CNH','CNY','ZAR','MXN','TRY','PLN','HUF','CZK']);
const SYMBOL_REGIMES: Readonly<Record<string,ExecutionRegime>> = Object.freeze(Object.fromEntries([
  ...'XAGUSD XAUUSD XPDUSD XPTUSD GOLD SILVER'.split(' ').map(s => [s,'METALS']),
  ...'AUSTRALIA200 AUS200 EUROPE50 EU50 FRA40 FR40 GER40 DE40 DAX ITALY40 JP225 JPN225 NIKKEI225 NL25 SPAIN35 ES35 UK100 FTSE100 US30 DJI US500 SP500 SPX500 USTECH100 NAS100 US100 NASDAQ100'.split(' ').map(s => [s,'INDICES']),
  ...'NATGAS XNGUSD USOIL XTIUSD WTI XBRUSD UKOIL BRENT'.split(' ').map(s => [s,'ENERGY']),
  ...'BTCUSD ETHUSD LTCUSD BCHUSD XRPUSD ADAUSD SOLUSD DOGEUSD'.split(' ').map(s => [s,'CRYPTO']),
]) as Record<string,ExecutionRegime>);

/** Round away from the market. Decimal normalization removes binary multiplication noise. */
export function roundExecutionStop(price: number, direction: 'BUY'|'SELL', tickSize: number): number {
  if (!positive(price) || !positive(tickSize) || (direction !== 'BUY' && direction !== 'SELL')) return NaN;
  const units = price / tickSize;
  if (!Number.isFinite(units) || units > Number.MAX_SAFE_INTEGER) return NaN;
  const nearest = Math.round(units);
  const aligned = Math.abs(units-nearest) <= Math.min(1e-7,Number.EPSILON * Math.max(1,Math.abs(units)) * 2);
  const ticks = aligned ? nearest : direction === 'BUY' ? Math.floor(units) : Math.ceil(units);
  const [mantissa,exponent='0']=tickSize.toString().toLowerCase().split('e');
  const decimals=Math.max(0,(mantissa.split('.')[1]?.length ?? 0)-Number(exponent));
  if (decimals>100) return NaN;
  const result = Number((ticks*tickSize).toFixed(decimals));
  return positive(result) ? result : NaN;
}

export function validateExecutionStop(input: {direction:ExecutionDirection;candidateSl:number;currentSl:number;quote:ExecutionQuote;instrument:ExecutionInstrument;nowMs:number}): {valid:boolean;reason:string;price:number} {
  const price = roundExecutionStop(input.candidateSl,input.direction,input.instrument?.tickSize);
  const fail = (reason:string) => ({valid:false,reason,price});
  if (!validateExecutionInstrument(input.instrument)) return fail('UNKNOWN_INSTRUMENT_UNITS');
  const q = input.quote;
  if (!q || !positive(q.bid) || !positive(q.ask) || q.bid > q.ask || !['broker','modeled'].includes(q.source)
    || !nonnegative(q.timestampMs) || !nonnegative(input.nowMs) || q.timestampMs > input.nowMs || input.nowMs-q.timestampMs > 10000) return fail('INVALID_OR_STALE_QUOTE');
  if (!positive(price) || !positive(input.currentSl)) return fail('INVALID_STOP');
  const epsilon = Number.EPSILON * Math.max(price,q.ask,input.currentSl) * 4;
  if (input.direction === 'BUY') {
    if (!(price-input.currentSl > epsilon)) return fail('NOT_STRICT_IMPROVEMENT');
    if (!(q.bid-input.instrument.minStopDistance-price > epsilon)) return fail('STOP_INSIDE_BID_DISTANCE');
  } else if (input.direction === 'SELL') {
    if (!(input.currentSl-price > epsilon)) return fail('NOT_STRICT_IMPROVEMENT');
    if (!(price-q.ask-input.instrument.minStopDistance > epsilon)) return fail('STOP_INSIDE_ASK_DISTANCE');
  } else return fail('INVALID_DIRECTION');
  return {valid:true,reason:'VALID_STOP_ESTIMATE',price};
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function validateExecutionInstrument(value: unknown): value is ExecutionInstrument {
  if (!value || typeof value !== 'object') return false;
  const v = value as ExecutionInstrument;
  return classifyExecutionRegime(v.ticker) !== undefined && classifyExecutionRegime(v.ticker) === v.regime
    && (v.source === 'broker_metadata' || v.source === 'explicit_model')
    && [v.pipSize,v.tickSize,v.pipValuePerLotUsd].every(positive)
    && [v.baseSpreadPips,v.exitSlippagePips,v.commissionPerLotSideUsd,v.minStopDistance].every(nonnegative);
}

/** Fill already includes entry spread/slip. paidCostsUsd is validated sunk cost, NOT charged again. */
export function estimatePendingExecutionCosts(input: ExecutionCostInput): ExecutionCostEstimate {
  const invalid = (reason: string): ExecutionCostEstimate => ({valid:false,reason,pendingCostPrice:NaN,pendingCostUsd:NaN});
  if (!input || !validateExecutionInstrument(input.instrument)) return invalid('UNKNOWN_INSTRUMENT_UNITS');
  const {instrument,lots,remainingLots,paidCostsUsd} = input;
  if (!positive(lots) || !positive(remainingLots) || remainingLots > lots || !nonnegative(paidCostsUsd)) return invalid('INVALID_QUANTITY_OR_PAID_COSTS');
  const commission = input.estimatedExitCommissionPerLotUsd === undefined ? instrument.commissionPerLotSideUsd : input.estimatedExitCommissionPerLotUsd;
  const swap = input.accruedSwapUsd === undefined ? 0 : input.accruedSwapUsd;
  if (!nonnegative(commission) || typeof swap !== 'number' || !Number.isFinite(swap)) return invalid('INVALID_PENDING_COSTS');
  const pendingCostUsd = remainingLots * (commission + instrument.pipValuePerLotUsd * instrument.exitSlippagePips) + Math.max(-swap,0);
  const usdPerPip=remainingLots*instrument.pipValuePerLotUsd;
  if (!positive(usdPerPip)) return invalid('INVALID_COST_UNITS');
  const pendingCostPrice = pendingCostUsd / usdPerPip * instrument.pipSize;
  if (!nonnegative(pendingCostUsd) || !nonnegative(pendingCostPrice)) return invalid('INVALID_COST_UNITS');
  return {valid:true,reason:'REMAINING_EXIT_COST_ESTIMATE',pendingCostUsd,pendingCostPrice};
}

/** Explicit aliases, or two distinct recognized currency codes; never a six-letter guess. */
export function classifyExecutionRegime(ticker: string): ExecutionRegime | undefined {
  if (typeof ticker !== 'string') return undefined;
  const symbol = ticker.trim().toUpperCase();
  if (SYMBOL_REGIMES[symbol]) return SYMBOL_REGIMES[symbol];
  const fx = /^(\w{3})\/?(\w{3})$/.exec(symbol);
  return fx && fx[1] !== fx[2] && CURRENCIES.has(fx[1]) && CURRENCIES.has(fx[2]) ? 'FOREX' : undefined;
}
