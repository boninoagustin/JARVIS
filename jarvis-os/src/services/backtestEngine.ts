import { validateReplayWindow, contextObservationTf, type ReplayWindowOptions, type ReplayDiagnostics } from './replayWindow';
import type {
  RadarZone, ImpulseLeg, RadarState, BacktestTrade,
  BacktestConfig, BacktestResult, LogEntry, ParsedAlert,
} from './backtestTypes';
import { evaluateImpulseCore, isInsideMacroOteZone, gcScore, addScoreEvent, computePoints, structuralInvalidate, refreshScoreCache, TF_RANK, TF_WEIGHT, calculateDynamicSlBuffer, getMinPipDistance, getMinImpulseRange } from '../engine/AlphaModel';
import { getPipValue, defaultFrictionConfig, getAssetClass, pipValuePerLotUsd } from '../engine/FrictionModel';
import { capTp2Price, getAdrPrice } from '../../../src/engine/tp2Cap';
import { DEFAULT_BIAS_CONFLUENCE, extractMgmtOverrides, normalizePartialClosePct } from '../../../src/engine/Types';
import { canonicalZoneMedal, isNativeZoneAlert, parseNativeZoneBreak, matchesNativeBrokenZone, hasLegacyUnresolvedZoneEvidence } from '../../../src/engine/smc/zone_protocol';
import { recordMacroImpulse, selectMacroImpulse, updateMacroImpulses } from '../../../src/engine/MacroImpulse';
import { evaluateNetTrade } from '../engine/FrictionModel';
import { getRolloverCalendar } from '../../../src/engine/RolloverSpreadGate';
import {
  emptyState, normalizeZone, parseTF, getBuffer, getDecimals
} from './backtestTypes';
import {
  evaluateTimesfmFilter, resolveTimesfmConfig, loadTimesfmCache, timesfmCandleKey,
  appendTimesfmAudit, resolveTp2FromForecast, type TimesfmForecast, type TimesfmDecision
} from '../engine/TimesfmFilter';
import { extractFeatures, loadModelFromJSON, predict as mlPredict, setMLWindowStart } from '../../../src/engine/MLFilter';
import * as fs from 'node:fs';
import * as nodeCrypto from 'node:crypto';

function safeSha256(data: string): string {
  try {
    if (typeof (nodeCrypto as any)?.createHash === 'function') {
      return (nodeCrypto as any).createHash('sha256').update(data).digest('hex');
    }
  } catch {}
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x6a09e667, h4 = 0xbb67ae85;
  for (let i = 0; i < data.length; i++) {
    const ch = data.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 2246822507);
    h4 = Math.imul(h4 ^ ch, 3266489909);
  }
  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  const part = toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
  return (part + part).slice(0, 64);
}
import {buildRolloverFreezeContext} from '../../../src/engine/RolloverRuntimeContext';
import {shouldFreezeRolloverObservation,evaluateRolloverTriage} from '../../../src/engine/RolloverTriagePolicy';
import { predictRegime,REGIME_FEATURE_SCHEMA } from '../../../src/engine/MLRegimeFeatures';
import { parseExecutionEnvelope, ingestExecutionContext, getExecutionSnapshot } from '../../../src/engine/ExecutionContext';
import { routeSmartEntry, resolveDirectTrigger, computeFinalScore } from '../../../src/engine/SmartRouting';
import { resolveExecutionPolicy, createExecutionPositionState, advanceExecutionPositionState, computeExecutionTargets, evaluateSmartEntryRouting, evaluateDynamicBreakeven, computeMultiAssetTrailingSl } from '../../../src/engine/ExecutionMicrostructure';
import { validateExecutionInstrument, estimatePendingExecutionCosts, validateExecutionStop } from '../../../src/engine/ExecutionCosts';
import type { ExecutionQuote, ExecutionMarketSnapshot, ExecutionPositionState, ExecutionObservation, SmartRoutingDecision } from '../../../src/engine/ExecutionTypes';

interface ModeledExecutionLedger {
  fillSource: 'MODELED';
  fillQuote: ExecutionQuote;
  managementOverrides: Record<string, any>;
  partialClosePct: number;
  remainingFraction: number;
  realizedPriceDist: number;
  paidCommissionPrice: number;
  exitCommissionPerLotUsd: number;
  maxHoldMin?: number;
  minimalRoi?: Record<string, number>;
  pendingAmend?: { price: number; stage: ExecutionPositionState['stage']; observedAtMs: number };
  lastProcessedMs: number;
  closeReason?: string;
  latestStructuralOrigin?: { price: number; direction: 'BUY'|'SELL'; tf: string; eventAtMs: number; availableAtMs: number };
}
type ModeledTrade = BacktestTrade & { executionBacktest?: ModeledExecutionLedger };
// Raw lastPrice remains available for risk/exits. Signal ATR/open approximations
// must bridge from the previous accepted observation, not a frozen raw shock.
const rolloverCleanCloses = new WeakMap<RadarState,number>();

function freezeResearchConfig<T>(value:T):T {
  if(value && typeof value === 'object') {for(const item of Object.values(value))freezeResearchConfig(item);Object.freeze(value);}
  return value;
}
function canonicalResearchJson(value:any):string {
  if(Array.isArray(value))return '['+value.map(canonicalResearchJson).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonicalResearchJson(value[k])).join(',')+'}';
  return JSON.stringify(value) ?? 'null';
}

function routeModeledSmart(leg: ImpulseLeg, state: RadarState, config: BacktestConfig, tf: string,
  nowMs: number, riskDist: number, requestedTp2Price: number, observation?: ExecutionObservation): SmartRoutingDecision {
  if (leg.executionDecision) return leg.executionDecision;
  const snapshot = getExecutionSnapshot(state, tf, nowMs);
  const wait = (reason: string): SmartRoutingDecision => ({ mode: 'WAIT_DATA', takeDirectNow: false, requiresCloseConfirmation: false, reason });
  let decision: SmartRoutingDecision;
  // Latest Wilder ATR is NOT the vintage of an older delayed break.
  if (!snapshot?.breakBar || !snapshot.closedBar || !observation?.breakBar
      || observation.tf !== tf || snapshot.breakBar.openTimeMs !== snapshot.closedBar.openTimeMs
      || observation.breakBar.openTimeMs !== snapshot.breakBar.openTimeMs
      || observation.observedAtMs > nowMs || !snapshot.quote
      || !validateExecutionInstrument(config.executionInstrument)) {
    decision = wait('MISSING_SAME_TF_CURRENT_BREAK_ATR_OR_INSTRUMENT');
  } else {
    const currentPrice = leg.dir === 'BUY' ? snapshot.quote.ask : snapshot.quote.bid;
    const policy = resolveExecutionPolicy(config.executionPolicy);
    let plannedTp2Price = requestedTp2Price;
    // The legacy cap uses abs(distance); do not let it turn an invalid request favorable.
    if (policy.profile === 'microstructure_v1' && requestedTp2Price !== undefined
        && (!Number.isFinite(requestedTp2Price) || (leg.dir === 'BUY' ? requestedTp2Price-currentPrice : currentPrice-requestedTp2Price) <= 0)) {
      decision = wait('WAIT_DATA_UNFAVORABLE_PLANNED_TP2');
    } else {
    if (policy.targets) {
      const targets = computeExecutionTargets({ direction: leg.dir, entryPrice: currentPrice,
        initialSlPrice: currentPrice + (leg.dir === 'BUY' ? -riskDist : riskDist),
        adr: getAdrPrice(config.ticker), regime: config.executionInstrument.regime,
        requestedTp2Price: requestedTp2Price > 0 ? requestedTp2Price : undefined });
      plannedTp2Price = targets.valid ? targets.tp2Price : NaN;
    } else plannedTp2Price = capTp2Price(config.ticker, leg.dir, currentPrice, currentPrice + (leg.dir === 'BUY' ? -riskDist : riskDist), requestedTp2Price);
    const sign = leg.dir === 'BUY' ? 1 : -1;
    const rooms = state.zones.filter(z => z.dir !== leg.dir).map(z => sign * ((leg.dir === 'BUY' ? z.btm : z.top) - currentPrice)).filter(x => Number.isFinite(x) && x > 0);
    const htfAligned = ['60','240','D'].filter(k => state.marketBias[k] === leg.dir && nowMs - (state.biasTs?.[k] ?? 0) < ({ '60': 8, '240': 48, D: 120 }[k]! * 3600e3)).length;
    decision = evaluateSmartEntryRouting({ ticker: config.ticker, direction: leg.dir, nowMs, currentPrice,
      originPrice: leg.origin, extremePrice: leg.extreme, riskDist, atr14: snapshot.atr14, adr: getAdrPrice(config.ticker),
      plannedTp2Price, rewardToOppositeZone: rooms.length ? Math.min(...rooms) : undefined,
      breakBar: snapshot.breakBar, impulseCreatedAtMs: observation.impulse?.createdAtMs ?? snapshot.breakBar.openTimeMs,
      fvgs: observation.impulse ? snapshot.fvgs : undefined, tickActivity: snapshot.tickActivity, htfAligned });
    }
  }
  leg.executionDecision = structuredClone(decision);
  leg.executionSnapshot = snapshot ? structuredClone(snapshot) : undefined;
  leg.executionDecisionAtMs = nowMs;
  return decision;
}

/** All experimental exits (including censor/SAR) settle the same remaining-leg ledger. */
function closeModeledTrade(trade: ModeledTrade, executablePrice: number, nowMs: number, reason: string): void {
  const ledger = trade.executionBacktest!, instrument = trade.executionInstrument!;
  const sign = trade.direction === 'BUY' ? 1 : -1;
  const fill = executablePrice - sign * instrument.exitSlippagePips * instrument.pipSize;
  const grossDist = ledger.realizedPriceDist + ledger.remainingFraction * sign * (fill - trade.entryPrice);
  ledger.paidCommissionPrice += ledger.remainingFraction * ledger.exitCommissionPerLotUsd / instrument.pipValuePerLotUsd * instrument.pipSize;
  ledger.remainingFraction = 0;
  ledger.closeReason = reason;
  delete ledger.pendingAmend;
  const netDist = grossDist - ledger.paidCommissionPrice;
  trade.pnl = netDist / trade.entryPrice * 100;
  trade.rMultiple = netDist / trade.executionState!.initialRiskDist * (trade.riskMult ?? 1);
  trade.result = trade.rMultiple > 0 ? 'WIN' : trade.rMultiple < 0 ? 'LOSS' : 'BE';
  trade.resultTp2 = reason === 'REVERSAL' ? 'REVERSAL' : trade.result;
  trade.pnlTp2 = trade.pnl;
  trade.rMultipleTp2 = trade.rMultiple - (trade.rMultipleTp1 ?? 0);
  trade.closeTimestamp = nowMs;
  trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
}

/** Quote-driven execution; whole closed post-observation OHLC is stop-first worst case. */
function manageModeledTrade(trade: ModeledTrade, quote: ExecutionQuote, snapshot: ExecutionMarketSnapshot | undefined, nowMs: number, ticker: string): boolean {
  const ledger = trade.executionBacktest!, instrument = trade.executionInstrument!, policy = trade.executionPolicy!;
  if (!quote || quote.source !== 'modeled' || quote.timestampMs > nowMs || nowMs - quote.timestampMs > 10000 || quote.timestampMs <= ledger.lastProcessedMs) return false;
  const sign = trade.direction === 'BUY' ? 1 : -1;
  const exitQuote = trade.direction === 'BUY' ? quote.bid : quote.ask;
  const bar = snapshot?.bar?.closed ? snapshot.bar : snapshot?.closedBar;
  // Never retest a newly amended stop against an already observed range.
  const wholeNewBar = !!bar && bar.closed && bar.openTimeMs >= ledger.lastProcessedMs && bar.availableAtMs <= nowMs;
  const halfSpread = (quote.ask - quote.bid) / 2;
  const low = wholeNewBar ? bar!.low - sign * halfSpread : exitQuote;
  const high = wholeNewBar ? bar!.high - sign * halfSpread : exitQuote;
  trade.executionState = advanceExecutionPositionState(trade.executionState!, { direction: trade.direction,
    entryPrice: trade.entryPrice, quote, nowMs });
  ledger.lastProcessedMs = quote.timestampMs;
  const stopped = trade.direction === 'BUY' ? low <= trade.slPrice : high >= trade.slPrice;
  if (stopped) {
    closeModeledTrade(trade, trade.direction === 'BUY' ? Math.min(exitQuote, trade.slPrice) : Math.max(exitQuote, trade.slPrice), nowMs, 'SL');
    return true;
  }
  const calendar = getRolloverCalendar(ticker, nowMs);
  const rolloverBlocked = calendar.protectionWindow || calendar.widenWindow || calendar.entryWindow;
  // The old stop governed the elapsed interval. Confirm a pending amend only
  // now, with this observation's market geometry, never against its past range.
  if (ledger.pendingAmend && quote.timestampMs > ledger.pendingAmend.observedAtMs) {
    const amend = ledger.pendingAmend;
    const checked = validateExecutionStop({ direction: trade.direction, candidateSl: amend.price,
      currentSl: trade.slPrice, quote, instrument, nowMs });
    if (!rolloverBlocked && checked.valid) {
      trade.slPrice = checked.price;
      trade.executionState = { ...trade.executionState!, lastConfirmedSlPrice: trade.slPrice, stage: amend.stage };
      trade.events.push('SL_AMEND_MODELED_CONFIRMED_NEXT_OBSERVATION');
    }
    delete ledger.pendingAmend;
  }
  const ageMin = (nowMs - trade.timestamp) / 60000;
  if (ledger.maxHoldMin && ageMin >= ledger.maxHoldMin) {
    closeModeledTrade(trade, exitQuote, nowMs, 'MAX_HOLD'); return true;
  }
  const roiAge = Object.keys(ledger.minimalRoi ?? {}).map(Number).filter(t => Number.isFinite(t) && ageMin >= t).sort((a,b) => b-a)[0];
  const roi = roiAge === undefined ? undefined : ledger.minimalRoi![String(roiAge)];
  if (roi !== undefined && roi > 0 && sign * (exitQuote - trade.entryPrice) / trade.entryPrice >= roi) {
    trade.roiDecayApplied = `${roiAge}m_${roi}`;
    closeModeledTrade(trade, exitQuote, nowMs, 'ROI'); return true;
  }
  const tp1Touched = trade.direction === 'BUY' ? high >= trade.tp1Price : low <= trade.tp1Price;
  if (!trade.tp1Hit && tp1Touched) {
    trade.tp1Hit = true;
    trade.resultTp1 = 'WIN';
    const partial = ledger.partialClosePct;
    if (partial > 0) {
      const fill = trade.tp1Price - sign * instrument.exitSlippagePips * instrument.pipSize;
      ledger.realizedPriceDist = partial * sign * (fill - trade.entryPrice);
      ledger.remainingFraction = 1 - partial;
      const exitCommission = ledger.exitCommissionPerLotUsd / instrument.pipValuePerLotUsd * instrument.pipSize;
      ledger.paidCommissionPrice += partial * exitCommission;
      trade.pnlTp1 = sign * (fill - trade.entryPrice) / trade.entryPrice * 100;
      trade.rMultipleTp1 = partial * (sign * (fill - trade.entryPrice) - 2 * exitCommission) / trade.executionState!.initialRiskDist * (trade.riskMult ?? 1);
      trade.executionState = { ...trade.executionState!, tp1Touched: true, partialConfirmed: true };
      trade.events.push(`PARTIAL_MODELED_FILLED_${partial}`);
    } else {
      trade.executionState = { ...trade.executionState!, tp1Touched: true };
    }
  }
  const tp2Touched = trade.tp2Price > 0 && (trade.direction === 'BUY' ? high >= trade.tp2Price : low <= trade.tp2Price);
  if (tp2Touched) { closeModeledTrade(trade, trade.tp2Price, nowMs, 'TP2'); return true; }

  const pendingCosts = estimatePendingExecutionCosts({ instrument, lots: 1, remainingLots: ledger.remainingFraction,
    paidCostsUsd: ledger.paidCommissionPrice / instrument.pipSize * instrument.pipValuePerLotUsd,
    estimatedExitCommissionPerLotUsd: ledger.exitCommissionPerLotUsd });
  let candidate = trade.slPrice, stage = trade.executionState!.stage;
  if (policy.management && pendingCosts.valid) {
    const be = evaluateDynamicBreakeven({ ticker, direction: trade.direction, entryPrice: trade.entryPrice,
      currentSlPrice: trade.slPrice, currentQuote: quote, instrument, state: trade.executionState!, atr14: snapshot?.atr14,
      adr: getAdrPrice(ticker), nowMs, pendingCostPrice: pendingCosts.pendingCostPrice, rolloverBlocked });
    if (be.shouldUpdateSl) { candidate = be.newSlPrice; stage = be.stage; }
  } else if (!policy.management && trade.executionState!.partialConfirmed) {
    const mode = ledger.managementOverrides.slAfterTp1;
    if (mode === 'midpoint') candidate = trade.entryPrice - sign * trade.executionState!.initialRiskDist * .5;
    if (mode === 'breakeven') candidate = trade.entryPrice + sign * (instrument.baseSpreadPips * instrument.pipSize);
  }
  if (policy.trailing) {
    // Trailing reads persisted, confirmed stage, never this observation's proposal.
    const trail = computeMultiAssetTrailingSl({ ticker, direction: trade.direction, entryPrice: trade.entryPrice,
      currentSlPrice: trade.slPrice, tp2Price: trade.tp2Price, currentQuote: quote, instrument, state: trade.executionState!,
      atr14: snapshot?.atr14, nowMs, rolloverBlocked, latestStructuralOrigin: ledger.latestStructuralOrigin });
    if (sign * (trail - candidate) > 0) candidate = trail;
  }
  if (!rolloverBlocked && candidate !== trade.slPrice) {
    const checked = validateExecutionStop({ direction: trade.direction, candidateSl: candidate,
      currentSl: trade.slPrice, quote, instrument, nowMs });
    if (checked.valid) {
      ledger.pendingAmend = { price: checked.price, stage, observedAtMs: quote.timestampMs };
      trade.events.push('SL_AMEND_MODELED_PENDING_NEXT_OBSERVATION');
    }
  }
  return false;
}

/** Historical prices are mid observations, NOT broker fills or tick flow. */
function modeledExecutionQuote(config: BacktestConfig, price: number | undefined, nowMs: number, instrument = config.executionInstrument): ExecutionQuote | undefined {
  if (!validateExecutionInstrument(instrument) || instrument.source !== 'explicit_model' || instrument.ticker !== config.ticker || !Number.isFinite(price) || !(price! > 0)) return;
  const spread = config.spreadPips ?? instrument.baseSpreadPips;
  if (!Number.isFinite(spread) || spread < 0) return;
  const halfSpread = spread * instrument.pipSize / 2;
  if (price! <= halfSpread) return;
  return { bid: price! - halfSpread, ask: price! + halfSpread, timestampMs: nowMs, source: 'modeled' };
}

// 🛡️ ML F3: modelos ya cargados en este proceso (evita re-parsear el JSON en cada trial del worker)
const _mlLoadedPaths = new Set<string>();

// 🆕 TimesFM F1: cache de forecasts precomputados, cargado una vez por corrida en runBacktest
let timesfmForecastCache: Map<number, TimesfmForecast> | undefined;
// Offline-only dependency, never serialized into strategy config. Reset every run.
let timesfmForecastAt: ((nowMs: number, tfMinutes: number) => TimesfmForecast | undefined) | undefined;

// 🛡️ ML F3: contexto del gate ML del run actual (variable de módulo: createTrade se llama
// desde helpers fuera del scope de runBacktest). Ejecución sincrónica → seguro con un run a la vez.
let _mlCtx: { cfg: any; rejected: number } = { cfg: undefined, rejected: 0 };

/**
 * 🛡️ ago-2026 — Buffer de fricción en el SL de breakeven (espejo del vivo trading.ts).
 * El fill de un stop paga el spread del lado de cierre; el backtest modela ese fill
 * cobrando la fricción, así que el SL de BE se coloca entry + spread modelado para
 * que el cierre neto quede ≈ 0 (paridad con el vivo, que usa el spread real).
 */
function btBreakevenBuffer(ticker: string, entryPrice: number, direction: 'BUY' | 'SELL'): number {
    const pipSize = getPipValue(ticker, entryPrice);
    const buffer = (defaultFrictionConfig[getAssetClass(ticker)]?.baseSpreadPips ?? 1) * pipSize;
    return direction === 'BUY' ? entryPrice + buffer : entryPrice - buffer;
}

function resolveTradeTriggerKey(trade: BacktestTrade): string {
    if (trade.execTrigger) return trade.execTrigger;
    if (trade.triggerType) return trade.triggerType;
    const events = trade.events ?? [];
    const hasOte = events.some(e => e.includes('OTE_Retracement'));
    const isBos = events.some(e => /(?:^|_|\s)(?:EVENTO_)?BOS/i.test(e) || e.includes('BOS🔨'));
    const isChoch = events.some(e => /(?:^|_|\s)(?:EVENTO_)?CHOCH/i.test(e) || e.includes('CHoCH'));
    let tfSuffix = '15m';
    if (trade.tf) {
        let extracted = String(trade.tf).toLowerCase();
        if (extracted.startsWith('m') && extracted.length > 1) extracted = extracted.substring(1);
        tfSuffix = extracted.endsWith('m') ? extracted : `${extracted}m`;
    } else {
        const tfEvent = events.find(e => e.includes('TF: '));
        const match = tfEvent?.match(/TF:\s*([a-zA-Z0-9]+)/i);
        if (match) {
            let extracted = match[1].toLowerCase();
            if (extracted.startsWith('m') && extracted.length > 1) extracted = extracted.substring(1);
            tfSuffix = extracted.endsWith('m') ? extracted : `${extracted}m`;
        }
    }
    if (hasOte && isBos) return `oteBos${tfSuffix}`;
    if (hasOte && isChoch) return `oteChoch${tfSuffix}`;
    if (isBos && !hasOte) return `bos${tfSuffix}`;
    if (isChoch && !hasOte) return `choch${tfSuffix}`;
    return '';
}

function resolveBacktestMgmt(trade: BacktestTrade, config: BacktestConfig) {
    const triggerKey = resolveTradeTriggerKey(trade);
    const sessionName = getSessionForTimestamp(trade.timestamp);
    const localMgmt = triggerKey ? (config.sessions?.[sessionName] as any)?.[triggerKey] : undefined;
    const tradeOverrides = (trade as any).mgmtOverrides;
    const cfgAny = config as any;
    const partialPct = normalizePartialClosePct(
        localMgmt?.partialClosePct ?? tradeOverrides?.partialClosePct ?? cfgAny.partialClosePct,
        0.5,
    );
    return {
        triggerKey,
        partialPct,
        remainderPct: 1 - partialPct,
        slAfterTp1Mode: (localMgmt?.slAfterTp1 ?? tradeOverrides?.slAfterTp1 ?? cfgAny.slAfterTp1 ?? 'midpoint') as 'midpoint' | 'breakeven' | 'none',
        tp15BeEnabled: Boolean(localMgmt?.tp15BeEnabled ?? tradeOverrides?.tp15BeEnabled ?? cfgAny.tp15BeEnabled ?? true),
        atrTrailEnabled: Boolean(localMgmt?.atrTrailEnabled ?? tradeOverrides?.atrTrailEnabled ?? cfgAny.atrTrailEnabled ?? true),
        structuralTrailEnabled: Boolean(localMgmt?.structuralTrailEnabled ?? tradeOverrides?.structuralTrailEnabled ?? cfgAny.structuralTrailEnabled ?? false),
        minimalRoi: (localMgmt?.minimal_roi ?? tradeOverrides?.minimal_roi ?? config.minimal_roi) as Record<string, number> | undefined,
    };
}

export type { BacktestTrade, BacktestResult, BacktestConfig } from './backtestTypes';

export interface DailyStats {
  currentDayStr: string;
  currentSessionStr: string;
  pnlR: number;
  peakPnlR: number;
  consecutiveLosses: number;
  streakKillswitchUntil: number;
  tradeCount: number;
  isKilled: boolean;
  sellLossCount: number;
  buyLossCount: number;
  sessionTradeCount: number;
  // 🆕 PARIDAD (sep-2026): gates direccionales del vivo portados al backtest.
  // dailyBuys/dailySells = entradas de hoy por dirección (maxBuys/maxSellsPerDay);
  // sessionBuy/SellLossStreak = racha de pérdidas POR dirección de la sesión actual
  // (maxBuyLosses/maxSellLosses por sesión, semántica de countConsecutiveLossesForAsset:
  // r<0 → +1, r>0 → 0, r=0 → sin cambio).
  dailyBuys: number;
  dailySells: number;
  sessionBuyLossStreak: number;
  sessionSellLossStreak: number;
  sessionExp?: Record<string, { n: number; sumR: number }>;
}

function updateDailyStatsFromClose(trade: BacktestTrade, dailyStats: DailyStats, config: BacktestConfig) {
  if (trade.rMultiple === undefined || Number.isNaN(trade.rMultiple)) return;

  dailyStats.pnlR = Math.round((dailyStats.pnlR + trade.rMultiple) * 1000) / 1000;
  if (dailyStats.pnlR > dailyStats.peakPnlR) {
    dailyStats.peakPnlR = dailyStats.pnlR;
  }
  
  const NET_BE_EPS = 0.05;
  if (trade.rMultiple < -NET_BE_EPS) {
    dailyStats.consecutiveLosses++;
    if (dailyStats.consecutiveLosses >= 5) {
      dailyStats.streakKillswitchUntil = (trade.closeTimestamp ?? trade.timestamp ?? 0) + 30 * 60 * 1000;
    }
    if (trade.direction === 'SELL') dailyStats.sellLossCount++;
    if (trade.direction === 'BUY') dailyStats.buyLossCount++;
  } else if (trade.rMultiple >= 0.8) {
    dailyStats.consecutiveLosses = 0;
    if (trade.direction === 'SELL') dailyStats.sellLossCount = 0;
    if (trade.direction === 'BUY') dailyStats.buyLossCount = 0;
  } else if (trade.rMultiple > NET_BE_EPS) {
    dailyStats.consecutiveLosses = Math.max(0, dailyStats.consecutiveLosses - 1);
    if (trade.direction === 'SELL') dailyStats.sellLossCount = Math.max(0, dailyStats.sellLossCount - 1);
    if (trade.direction === 'BUY') dailyStats.buyLossCount = Math.max(0, dailyStats.buyLossCount - 1);
  }
  
  if (!dailyStats.sessionExp) dailyStats.sessionExp = {};
  const key = `${dailyStats.currentSessionStr.split('-').pop()}-${trade.direction}`;
  const e = (dailyStats.sessionExp[key] ??= { n: 0, sumR: 0 });
  e.n++; e.sumR += trade.rMultiple;

  // 🆕 PARIDAD (sep-2026): racha direccional de la sesión — MISMA semántica que
  // countConsecutiveLossesForAsset del vivo (r<0 → +1, r>0 → 0, r=0 → sin cambio).
  const btSession = (trade as any).btSession ?? dailyStats.currentSessionStr;
  if (btSession === dailyStats.currentSessionStr) {
    if (trade.rMultiple < 0) {
      if (trade.direction === 'BUY') dailyStats.sessionBuyLossStreak++;
      else dailyStats.sessionSellLossStreak++;
    } else if (trade.rMultiple > 0) {
      if (trade.direction === 'BUY') dailyStats.sessionBuyLossStreak = 0;
      else dailyStats.sessionSellLossStreak = 0;
    }
  }

  if (config.maxDailyLossR && dailyStats.pnlR <= -config.maxDailyLossR) dailyStats.isKilled = true;
  if (config.dailyProfitTargetR && dailyStats.pnlR >= config.dailyProfitTargetR) dailyStats.isKilled = true;
  if (config.maxConsecutiveLosses && dailyStats.consecutiveLosses >= config.maxConsecutiveLosses) dailyStats.isKilled = true;
  if (config.trailingDrawdownR && (dailyStats.peakPnlR - dailyStats.pnlR) >= config.trailingDrawdownR) dailyStats.isKilled = true;
}


const MAX_ZONE_AGE_MS: Record<string, number> = {
  '3': 1800000, '5': 3600000, '15': 21600000,
  '60': 28800000, '240': 86400000, 'D': 604800000,
};

// --- CSV PARSING ---
export function* parseCSVLines(content: string): Generator<LogEntry> {
  const seen = new Set<string>();
  let start = 0;
  while (start < content.length) {
    let end = content.indexOf('\n', start);
    if (end === -1) end = content.length;
    let r = content.substring(start, end);
    if (r.endsWith('\r')) r = r.slice(0, -1);
    start = end + 1;

    if (r.trim().length === 0 || !r.includes(' | TS: ')) continue;
    const firstComma = r.indexOf(',');
    const line = firstComma > 0 ? r.substring(firstComma + 1).replace(/^"|"$/g, '') : r;
    
    const tsMatch = line.match(/TS:\s*(\d+)/i);
    const tfMatch = line.match(/TF:\s*([a-zA-Z0-9]+)/i);
    const ts = tsMatch ? parseInt(tsMatch[1], 10) : 0;
    const tf = tfMatch ? tfMatch[1].toUpperCase() : '3';
    // Clave compuesta TS+TF+prefijo para evitar colisiones silenciosas
    const dedupKey = `${ts}-${tf}-${line.substring(0, 40)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    yield {
      line: parseExecutionEnvelope(line, ts).text,
      ts,
      tf,
      parsed: preParseAlert(line)
    };
  }
}

export function parseCSV(content: string): { lines: LogEntry[]; detectedTF: string } {
  const entries: LogEntry[] = [];
  let tf = '3';
  let first = true;
  for (const entry of parseCSVLines(content)) {
    if (first && entry.tf) { tf = entry.tf; first = false; }
    entries.push(entry);
  }
  return { lines: entries, detectedTF: tf };
}

// --- GET SESSION FOR TIMESTAMP ---
export function getSessionForTimestamp(ts: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' {
  // Argentina is UTC-3 all year round
  const d = new Date(ts - 3 * 3600 * 1000);
  // Paridad con vivo (getCurrentSession trading.ts:967-971): sábado/domingo → OFF.
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return 'OFF';
  const arHour = d.getUTCHours();
  const arMin = d.getUTCMinutes();
  const timeDecimal = arHour + arMin / 60;
  
  if (timeDecimal >= 21 || timeDecimal < 4) return 'ASIA';
  if (timeDecimal >= 4 && timeDecimal < 10.5) return 'LONDON';
  if (timeDecimal >= 10.5 && timeDecimal < 17) return 'NY';
  
  return 'OFF';
}


// --- ENTRY PREPARATION (hoisted from runBacktest for reuse across many configs) ---
export async function prepareEntries(logs: Map<string, (string | LogEntry)[]>): Promise<LogEntry[]> {
  const allEntries: LogEntry[] = [];
  let count = 0;
  const seen = new Set<string>();

  for (const [tf, items] of logs.entries()) {
    for (const item of items) {
      if (typeof item === 'string') {
        let r = item;
        if (r.endsWith('\r')) r = r.slice(0, -1);
        if (r.trim().length === 0 || !r.includes(' | TS: ')) {
           count++;
           continue;
        }
        
        // loadSelectionLogs ya extrae el campo (sin timestamp ni comillas). Sólo re-parsear
        // si es CSV crudo: empieza con comilla O con la fecha ISO (el buscador de detección
        // sintetiza líneas `2026-01-01T..,"PAYLOAD"`). Antes, un payload SYNC_ZONES con comas
        // internas se truncaba en la primera coma → zonas vacías → smartAtr=0 → OTE forzado.
        const isRawCsv = r.startsWith('"') || /^\s*\d{4}-\d{2}-\d{2}T/.test(r);
        const firstComma = isRawCsv ? r.indexOf(',') : -1;
        const line = firstComma > 0 ? r.substring(firstComma + 1).replace(/^"|"$/g, '') : r;

        const tsMatch = line.match(/TS:\s*(\d+)/i);
        const tfMatch = line.match(/TF:\s*([a-zA-Z0-9]+)/i);
        const ts = tsMatch ? parseInt(tsMatch[1], 10) : 0;
        const entryTf = tfMatch ? tfMatch[1].toUpperCase() : tf;
        
        const dedupKey = `${ts}-${entryTf}-${line.substring(0, 40)}`;
        if (seen.has(dedupKey)) {
            count++;
            continue;
        }
        seen.add(dedupKey);

        allEntries.push({ ts, line: parseExecutionEnvelope(line, ts).text, tf: entryTf, parsed: preParseAlert(line) });
      } else {
        allEntries.push(item as LogEntry);
      }
      count++;
      if (count % 5000 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }
  return allEntries.filter(e => e.ts > 0).sort((a, b) => a.ts - b.ts);
}

// --- MAIN BACKTEST RUNNER ---
export function runBacktest(
  _logs: Map<string, (string | LogEntry)[]>,
  config: BacktestConfig,
  onProgress?: (pct: number, trades: BacktestTrade[]) => void,
  prepared?: LogEntry[],
  replayWindow?: ReplayWindowOptions,
  offlineOptions?: { timesfmForecastAt?: (nowMs: number, tfMinutes: number) => TimesfmForecast | undefined }
): BacktestResult {
  timesfmForecastAt = undefined;
  if (replayWindow) validateReplayWindow(replayWindow);
  if (offlineOptions?.timesfmForecastAt !== undefined) {
    if (!replayWindow || typeof offlineOptions.timesfmForecastAt !== 'function') throw new Error('TimesFM resolver requires explicit context-only replay window');
    timesfmForecastAt = offlineOptions.timesfmForecastAt;
  }
  const executionPolicy = resolveExecutionPolicy(config.executionPolicy);
  const experimental = executionPolicy.profile === 'microstructure_v1';
  // A research run owns its config; callbacks cannot retune open positions.
  if (experimental || config.mlRegimeShadow === true || config.rolloverPolicy?.profile === 'rollover_triage_v1') config = structuredClone({ ...config, ...(experimental ? { executionPolicy } : {}) });
  const executionReport = experimental ? {
    schema: 1, profile: executionPolicy.profile, fillSource: 'MODELED',
    instrumentSource: config.executionInstrument?.source ?? 'missing',
    adrSource: 'STATIC_FROZEN_REFERENCE_NOT_ASOF_FORECAST',
    priceAssumption: 'CSV_MID_PLUS_HALF_EXPLICIT_SPREAD', profitabilityEvidence: false,
    blockedReason: !validateExecutionInstrument(config.executionInstrument) || config.executionInstrument.source !== 'explicit_model'
      || config.executionInstrument.ticker !== config.ticker ? 'MISSING_OR_INVALID_EXPLICIT_INSTRUMENT' : undefined,
  } : undefined;
  // 🔧 FIX: fricción 0 = "auto" → undefined para caer en defaultFrictionConfig por activo.
  // El panel manda 0 por defecto y pisaba los defaults reales (FOREX: spread 0.1 + $3/lote).
  if (!experimental && (config as any).spreadPips === 0) (config as any).spreadPips = undefined;
  if (!experimental && (config as any).commissionPerLot === 0) (config as any).commissionPerLot = undefined;
  const researchRun = config.mlRegimeShadow === true || config.rolloverPolicy?.profile === 'rollover_triage_v1';
  const researchReport = researchRun ? {
    schema:1 as const,applyEligible:false as const,profitabilityEvidence:false as const,
    rolloverProfile:config.rolloverPolicy?.profile ?? 'legacy',mlRegimeShadow:config.mlRegimeShadow===true,
    triageExecution:'PROPOSAL_ONLY_NO_BILATERAL_EXECUTION_MODEL' as const,
    configSha256:safeSha256(canonicalResearchJson(config)),
  } : undefined;
  if(researchRun)freezeResearchConfig(config);

  // 🛡️ ML F3 (sep-2026): gate ML idéntico al vivo (AlphaModel.ts:357-359) dentro del backtest.
  // Walk-forward honesto: solo rechaza trades con ts > mlGate.trainedAt (mtime del modelo —
  // el modelo de la semana pasada evalúa la semana nueva, jamás su propio período de train).
  const mlGateCfg = (config as any).mlGate as { enabled?: boolean; modelPath?: string; trainedAt?: number } | undefined;
  _mlCtx = { cfg: mlGateCfg, rejected: 0 };
  // 🛡️ ML F3: ventana walk-forward para el gate del AlphaModel compartido (vivo: ventana 0).
  setMLWindowStart(mlGateCfg?.enabled ? (mlGateCfg.trainedAt ?? 0) : 0);
  // Replay trials can alternate models for the same ticker. A path having been
  // seen does not mean that it is still the model installed in MLFilter.
  // Preserve the approved legacy caching path when no replay is requested.
  if (replayWindow && mlGateCfg?.enabled) {
    // Fail closed: a missing/invalid fold model must not reuse a prior trial's
    // model or silently change the candidate to gate-OFF.
    try {
      if (!mlGateCfg.modelPath) throw new Error('model path missing');
      const modelBytes = fs.readFileSync(mlGateCfg.modelPath);
      if (!loadModelFromJSON(modelBytes.toString('utf8'), config.ticker, nodeCrypto.createHash('sha256').update(modelBytes).digest('hex'))) {
        throw new Error('model rejected');
      }
    } catch (e: any) {
      throw new Error(`Replay ML model unavailable: ${e.message}`);
    }
  } else if (mlGateCfg?.enabled && mlGateCfg.modelPath && !_mlLoadedPaths.has(mlGateCfg.modelPath)) {
    try {
      if (fs.existsSync(mlGateCfg.modelPath)) {
        const modelBytes = fs.readFileSync(mlGateCfg.modelPath);
        loadModelFromJSON(modelBytes.toString('utf8'), config.ticker, nodeCrypto.createHash('sha256').update(modelBytes).digest('hex'));
      } else {
        console.warn(`[ML-GATE] ⚠️ modelo no encontrado: ${mlGateCfg.modelPath} — gate OFF`);
      }
    } catch (e: any) {
      console.warn(`[ML-GATE] ⚠️ no se pudo cargar el modelo ${mlGateCfg.modelPath}: ${e.message}`);
    }
    _mlLoadedPaths.add(mlGateCfg.modelPath); // no reintentar en corridas siguientes del mismo proceso
  }

  const state = emptyState();
  const trades: BacktestTrade[] = [];

  // 🆕 TimesFM F1: cargar cache de forecasts precomputados (una sola vez por corrida)
  const tfmInit = (config as any).timesfm;
  timesfmForecastCache = (!timesfmForecastAt && tfmInit?.enabled && tfmInit?.cachePath && !tfmInit?.collectOnly)
    ? loadTimesfmCache(tfmInit.cachePath)
    : undefined;
  const activeTrades = new Map<string, BacktestTrade>();
  const dailyStats: DailyStats = {
    currentDayStr: '',
    currentSessionStr: '',
    pnlR: 0,
    peakPnlR: 0,
    consecutiveLosses: 0,
    streakKillswitchUntil: 0,
    tradeCount: 0,
    isKilled: false,
    sellLossCount: 0,
    buyLossCount: 0,
    sessionTradeCount: 0,
    dailyBuys: 0,
    dailySells: 0,
    sessionBuyLossStreak: 0,
    sessionSellLossStreak: 0
  };

  // 1. Parse all entries with timestamps (or use pre-prepared)
  const validEntries = replayWindow
    ? (prepared ?? []).filter(e => Number.isSafeInteger(e.ts) && e.ts >= replayWindow.warmupStartMs && e.ts < replayWindow.evaluationEndMs).sort((a, b) => a.ts - b.ts)
    : prepared!;
  const observations = new Map<string, Set<number>>();
  const replayDiagnostics: ReplayDiagnostics | undefined = replayWindow ? {
    ...replayWindow, minContextObservations: { ...replayWindow.minContextObservations },
    version: 1, warmupEvents: 0, evaluationEvents: 0,
    portfolioPolicy: 'reset-per-fold', readiness: { ready: false, observations: {}, missing: [] },
  } : undefined;
  const sealBoundary = () => {
    if (!replayDiagnostics || replayDiagnostics.boundarySnapshot) return;
    const counts: Record<string, number> = {};
    for (const tf of new Set([...Object.keys(replayDiagnostics.minContextObservations), ...observations.keys()])) {
      counts[tf] = observations.get(tf)?.size ?? 0;
    }
    const missing = Object.keys(replayDiagnostics.minContextObservations)
      .filter(tf => counts[tf] < replayDiagnostics.minContextObservations[tf]);
    replayDiagnostics.readiness = { ready: missing.length === 0, observations: counts, missing };
    replayDiagnostics.boundarySnapshot = {
      state: structuredClone(state), dailyStats: { ...dailyStats }, orders: trades.length, activeTrades: activeTrades.size,
    };
  };

  if (!validEntries || validEntries.length === 0) {
    sealBoundary();
    return { trades, totalEvents: 0, processedEvents: 0, startDate: '', endDate: '', ...(researchReport ? {researchReport}:{}), ...(executionReport ? { executionReport } : {}), ...(replayDiagnostics ? { replayDiagnostics } : {}) };
  }

  // 3. Procesar cronológicamente (sin hoistar SYNC_ZONES para evitar lookahead bias)
  const initialPrice = validEntries.find(e => (!replayWindow || e.ts < replayWindow.evaluationStartMs) && e.parsed?.currentPrice !== undefined)?.parsed?.currentPrice ?? 1;
  const pipSize = getPipValue(config.ticker, initialPrice);

  const total = validEntries.length;
  let lastProgressPct = 0;
  for (let i = 0; i < total; i++) {
    const entry = validEntries[i];
    let contextOnly = false;
    let hydrate = true;
    if (replayWindow && replayDiagnostics) {
      const warmup = entry.ts < replayWindow.evaluationStartMs;
      if (warmup) replayDiagnostics.warmupEvents++;
      else { sealBoundary(); replayDiagnostics.evaluationEvents++; }
      contextOnly = warmup || !replayDiagnostics.readiness.ready;
      if (entry.parsed?.prefix === 'PING_PRICE') {
        const tf = contextObservationTf(entry);
        hydrate = tf !== undefined;
        if (warmup && tf) {
          const seen = observations.get(tf) ?? new Set<number>();
          hydrate = !seen.has(entry.ts);
          if (hydrate) { seen.add(entry.ts); observations.set(tf, seen); }
        }
      }
    }
    if (hydrate) processAlert(entry, entry.ts, state, config, trades, activeTrades, dailyStats, pipSize, contextOnly);
    const pct = Math.floor((i / total) * 100);
    if (onProgress && pct > lastProgressPct && pct % 5 === 0) {
      lastProgressPct = pct;
      onProgress(pct, [...trades]);
    }
  }

  sealBoundary();

  // Close remaining active trades at closing price
  const lastEntry = validEntries[validEntries.length - 1];
  const closingPrice = state.lastPrice ?? lastEntry.parsed?.currentPrice;
  if (closingPrice !== undefined) {
    for (const [, trade] of activeTrades) {
      const slDistance = Math.abs(trade.originalSlPrice! - trade.entryPrice);
      if (trade.executionPolicy?.profile === 'microstructure_v1') {
        const ledger = (trade as ModeledTrade).executionBacktest!;
        const quote = modeledExecutionQuote({ ...config, spreadPips: (ledger.fillQuote.ask - ledger.fillQuote.bid) / trade.executionInstrument!.pipSize }, closingPrice, lastEntry.ts, trade.executionInstrument);
        if (quote) closeModeledTrade(trade, trade.direction === 'BUY' ? quote.bid : quote.ask, lastEntry.ts, 'FINAL_CENSOR');
        updateDailyStatsFromClose(trade, dailyStats, config);
        continue;
      }
      const pnlDistance = trade.direction === 'BUY'
        ? closingPrice - trade.entryPrice
        : trade.entryPrice - closingPrice;
      
      const pipSize = getPipValue(config.ticker, closingPrice);
      const riskPips = slDistance / pipSize;
      const cls = getAssetClass(config.ticker);
      const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
      const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker, closingPrice)) : 0;
      
      const censorMgmt = resolveBacktestMgmt(trade, config);
      const lockedPct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 * censorMgmt.partialPct : 0;
      const openPct = (pnlDistance / trade.entryPrice) * 100 * (trade.tp1Hit ? censorMgmt.remainderPct : 1.0);
      const slPct = (slDistance / trade.entryPrice) * 100;
      const grossR = slPct > 0 ? (lockedPct + openPct) / slPct : 0;

      trade.pnl = lockedPct + openPct;
      trade.rMultiple = (grossR - transactionCostR) * (trade.riskMult || 1.0);
      trade.result = trade.rMultiple > 0 ? 'WIN' : trade.rMultiple === 0 ? 'BE' : 'LOSS';
      trade.closeTimestamp = lastEntry.ts;
      trade.durationMin = Math.round((lastEntry.ts - trade.timestamp) / 60000);
      updateDailyStatsFromClose(trade, dailyStats, config);
    }
  }
  activeTrades.clear();

  if (onProgress) onProgress(100, [...trades]);

  return {
    trades,
    totalEvents: validEntries.length,
    processedEvents: total,
    startDate: new Date(validEntries[0].ts).toISOString().split('T')[0],
    endDate: new Date(validEntries[validEntries.length - 1].ts).toISOString().split('T')[0],
    // 🛡️ ML F3: rechazos del gate ML (walk-forward) — visible en el reporte del optimizador
    mlRejected: _mlCtx.rejected,
    mlGateEnabled: !!mlGateCfg?.enabled,
    ...(researchReport ? {researchReport}:{}),
    ...(executionReport ? { executionReport } : {}),
    ...(replayDiagnostics ? { replayDiagnostics } : {}),
  };
}

// --- PROCESS SINGLE ALERT (ported from backend processTradingAlert) ---

function preParseAlert(alertText: string): ParsedAlert | undefined {
  const eventTime = Number(alertText.match(/TS:\s*(\d+)/i)?.[1] ?? 0);
  const envelope = parseExecutionEnvelope(alertText, eventTime);
  alertText = envelope.text;
  const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
  const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());
  if (parts.length < 2) return undefined;

  const prefix = parts[0].toUpperCase();
  const upperText = alertText.toUpperCase();

  const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
  let eventTf = tfMatch ? tfMatch[1].toUpperCase() : 'UNKNOWN';
  if (eventTf === 'M5') eventTf = '5';
  if (eventTf === 'M15') eventTf = '15';
  if (eventTf === 'M3') eventTf = '3';
  if (eventTf === 'H1') eventTf = '60';
  if (eventTf === 'H4') eventTf = '240';
  if (eventTf === 'D1') eventTf = 'D';
  
  const readableTf = parseTF(eventTf);


  let currentDirection: 'BUY' | 'SELL' | null = null;
  if (upperText.includes('BUY') || upperText.includes('BULLISH')) currentDirection = 'BUY';
  else if (upperText.includes('SELL') || upperText.includes('BEARISH')) currentDirection = 'SELL';

  const parsed: any = { prefix, eventTf, readableTf, currentDirection };

  if (prefix === 'SYNC_ZONES') {
    const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
    if (trendMatch) parsed.trendMatch = trendMatch[1].toUpperCase();
    if (alertText.includes('Payload:')) {
      const afterPayload = alertText.substring(alertText.indexOf('Payload:') + 8);
      const payloadStr = afterPayload.split(/\s*\|\s*TS:/)[0].trim().replace(/""/g, '"');
      try {
        parsed.rawZones = JSON.parse(payloadStr);
      } catch { /* ignore */ }
    }
  }

  if (prefix === 'HEARTBEAT') {
    const biasMatch = alertText.match(/Bias:\s*(BUY|SELL|NEUTRAL)/i);
    if (biasMatch) parsed.biasMatch = biasMatch[1].toUpperCase();
  }

  if (prefix === 'PING_PRICE') {
    const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
    if (priceMatch) parsed.currentPrice = parseFloat(priceMatch[1]);
    const highMatch = alertText.match(/High:\s*([0-9.]+)/i);
    const lowMatch = alertText.match(/Low:\s*([0-9.]+)/i);
    if (highMatch) parsed.highPrice = parseFloat(highMatch[1]);
    if (lowMatch) parsed.lowPrice = parseFloat(lowMatch[1]);
  }
  
  if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS' || prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
    const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
    if (originMatch) parsed.origin = parseFloat(originMatch[1]);
    const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
    if (priceMatch) parsed.currentPrice = parseFloat(priceMatch[1]);
  }
  
  if (upperText.includes('VWAP UNDER')) parsed.vwapUnder = true;
  if (upperText.includes('VWAP OVER')) parsed.vwapOver = true;

  if (envelope.observation) parsed.executionObservation = envelope.observation;
  if (envelope.reason) parsed.executionContextReason = envelope.reason;
  return parsed;
}

function getArgentinaDayStr(nowMs: number): string {
  // Para ASIA: anclar el día de trading a las 17:00 ART (convención FX: el día cambia al cierre de NY):
  const d = new Date(nowMs - 3 * 3600e3 - 17 * 3600e3);
  return d.toISOString().split('T')[0];
}

// 🆕 sep-2026 (Capa 1 del optimizador del motor): multiplicadores por familia de zona
// × sesión, tuneados por el hyperopt (config.zoneWeights). 0 = desactivar la familia
// en esa sesión; default 1 = comportamiento actual. Paridad exacta con trading.ts.
function zoneWeightMult(config: BacktestConfig, family: string, session: string): number {
  const zw = (config as any).zoneWeights;
  if (!zw || typeof zw !== 'object') return 1;
  const perFam = zw[family];
  if (!perFam || typeof perFam !== 'object') return 1;
  const v = perFam[session];
  return typeof v === 'number' ? v : 1;
}

function processAlert(
  entry: LogEntry, nowMs: number, state: RadarState,
  config: BacktestConfig, trades: BacktestTrade[],
  activeTrades: Map<string, BacktestTrade>,
  dailyStats: DailyStats,
  pipSize: number,
  contextOnly = false
) {
  const envelope = parseExecutionEnvelope(entry.line, nowMs);
  const p = entry.line.includes('EX1:') ? preParseAlert(entry.line) : entry.parsed;
  if (!p) return;
  const executionPolicy = resolveExecutionPolicy(config.executionPolicy);
  const experimental = executionPolicy.profile === 'microstructure_v1';
  const contextReason = (p as ParsedAlert & { executionContextReason?: string }).executionContextReason ?? envelope.reason;
  if (experimental && contextReason) {
    console.warn(`[EXECUTION_BT] WAIT_DATA ${contextReason} at ${nowMs}`);
    return;
  }
  const modeledQuote = experimental ? modeledExecutionQuote(config, p.currentPrice, nowMs) : undefined;
  if (experimental) {
    const incoming = p.executionObservation ?? envelope.observation;
    if (incoming) {
      const result = incoming.ticker === config.ticker ? ingestExecutionContext(state, incoming, nowMs) : { accepted: false, reason: 'ticker_mismatch' };
      if (!result.accepted) {
        console.warn(`[EXECUTION_BT] WAIT_DATA ${result.reason} at ${nowMs}`);
        return;
      }
    }
    // A quote-only observation never supplies OHLC/ATR/tick activity.
    if (modeledQuote) ingestExecutionContext(state, { schema: 1, ticker: config.ticker,
      tf: incoming?.tf ?? p.eventTf, observedAtMs: nowMs, quote: modeledQuote }, nowMs);
  }
  const { prefix, eventTf, readableTf, currentDirection } = p;
  const duration = ({'5':300000,'15':900000,'30':1800000,'60':3600000,'240':14400000,D:86400000,'1D':86400000,W:604800000,'1W':604800000} as Record<string,number>)[eventTf] ?? NaN;
  const snapshot = experimental ? getExecutionSnapshot(state, eventTf, nowMs) : undefined;
  const observationInterval = {startMs:Math.min(nowMs-duration, snapshot?.bar?.openTimeMs ?? nowMs, snapshot?.closedBar?.openTimeMs ?? nowMs),endMs:nowMs};
  const rolloverFreeze = buildRolloverFreezeContext(config.ticker, observationInterval.startMs, observationInterval.endMs,
    config.rolloverPolicy?.profile === 'rollover_triage_v1' ? config.rolloverPolicy : undefined);
  const signalsFrozen = rolloverFreeze?.metadataAvailable ? shouldFreezeRolloverObservation(observationInterval.startMs, observationInterval.endMs, rolloverFreeze) : false;
  if (signalsFrozen && prefix !== 'PING_PRICE') return; // this branch has no position/risk processing

  const alertText = envelope.text;
  const upperText = alertText.toUpperCase();

  // --- TICK DENSITY (ACTIVITY PROXY) ---
  if (!contextOnly && !experimental && !signalsFrozen) {
  state.tickTimes = (state.tickTimes ?? []).filter(t => nowMs - t < 3600000);
  state.tickTimes.push(nowMs);
  const density = state.tickTimes.length;
  const a = 1 / 50;
  state.densityMedian = state.densityMedian === undefined ? density 
    : state.densityMedian + a * (density - state.densityMedian);
  }

  // Extract VWAP status globally for the event timeframe
  const vwapMatch = upperText.match(/VWAP:\s*(UNDER|OVER)/);
  if (!signalsFrozen && vwapMatch && eventTf) {
    if (!state.vwapStatus) state.vwapStatus = {};
    if (!state.vwapTs) state.vwapTs = {};
    state.vwapStatus[eventTf] = vwapMatch[1];
    state.vwapTs[eventTf] = nowMs;
  }
  const ticker = config.ticker;
  const todayStr = getArgentinaDayStr(nowMs);
  const currentSession = getSessionForTimestamp(nowMs);
  const sessionId = `${todayStr}-${currentSession}`;

  if (!contextOnly) {
  if (dailyStats.currentDayStr !== todayStr) {
    dailyStats.currentDayStr = todayStr;
    dailyStats.pnlR = 0;
    dailyStats.peakPnlR = 0;
    dailyStats.consecutiveLosses = 0;
    dailyStats.streakKillswitchUntil = 0;
    dailyStats.tradeCount = 0;
    dailyStats.dailyBuys = 0;
    dailyStats.dailySells = 0;
    dailyStats.isKilled = false;
  }

  if (dailyStats.currentSessionStr !== sessionId) {
    dailyStats.currentSessionStr = sessionId;
    dailyStats.sellLossCount = 0;
    dailyStats.buyLossCount = 0;
    dailyStats.sessionTradeCount = 0;
    dailyStats.sessionBuyLossStreak = 0;
    dailyStats.sessionSellLossStreak = 0;
  }


  if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
  if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
  // 🧹 GC por TTL por timeframe (sustituye al reset de 48h; nowMs es tiempo simulado de vela)
  if (!signalsFrozen) {
    gcScore(state.scoreBuy, nowMs);
    gcScore(state.scoreSell, nowMs);
  }
  }

  // --- SYNC_ZONES ---
  if (prefix === 'SYNC_ZONES') {
    if (!alertText.includes('Payload:')) return;
    const sourceTf = eventTf;

    if (p.trendMatch) {
      if (!state.biasTs) state.biasTs = {};
      state.marketBias[sourceTf] = p.trendMatch;
      state.biasTs[sourceTf] = nowMs;
    }

    // 🆕 sep-2026 reconstrucción bias HTF: en el live el bias de 4H/1H/D viene del engine SMC
    // con tendencia real; en el backtest el SYNC sale NEUTRAL casi siempre (engine offline sin
    // estructura) → las penalizaciones/bonos macro nunca se ejercían. Derivamos el bias del
    // SMA de las velas del TF para restaurar la paridad.
    const htBuf = state.htfCloses?.[sourceTf];
    if (htBuf && htBuf.length >= 8 && (p.trendMatch === 'NEUTRAL' || !p.trendMatch)) {
      const sma = htBuf.reduce((a: number, b: number) => a + b, 0) / htBuf.length;
      const derived = htBuf[htBuf.length - 1] > sma ? 'BUY' : 'SELL';
      if (!state.biasTs) state.biasTs = {};
      state.marketBias[sourceTf] = derived;
      state.biasTs[sourceTf] = nowMs;
      const dl = (state as any).htfDeriveLog = (state as any).htfDeriveLog || {};
      if ((dl[sourceTf] = (dl[sourceTf] || 0) + 1) <= 2) {
        console.log(`[BIAS-DERIVE] ${sourceTf}: SYNC NEUTRAL → bias derivado ${derived} (SMA=${sma.toFixed(5)}, close=${htBuf[htBuf.length-1]})`);
      }
    }

    try {
      const rawZones = p.rawZones as Record<string, unknown>[];
      if (!rawZones) return;
      const nativeZoneSync = isNativeZoneAlert(alertText)
        || rawZones.some(rz => !!rz && typeof rz === 'object' && ('t' in rz || 'tf' in rz));
      const parsedZones: RadarZone[] = rawZones.map(raw => {
        const z = normalizeZone(raw);
        z.medal = canonicalZoneMedal(z.medal);
        return z;
      }).filter(z => z.top !== undefined && z.btm !== undefined && z.dir !== undefined);
      parsedZones.forEach(z => { z.tf = sourceTf; z.createdAt = nowMs; });

      if (!nativeZoneSync && state.lastSyncDate !== todayStr) {
        state.zones = [];
        state.lastSyncDate = todayStr;
      }
      state.zones = state.zones.filter(z => z.tf !== sourceTf);
      state.zones.push(...parsedZones);
    } catch { /* invalid JSON */ }
    return;
  }

  // --- PING_PRICE ---
  if (prefix === 'PING_PRICE') {
    if (p.currentPrice === undefined) return;
    const currentPrice = p.currentPrice;
    const highPrice = p.highPrice !== undefined ? p.highPrice : currentPrice;
    const lowPrice = p.lowPrice !== undefined ? p.lowPrice : currentPrice;

    // 🆕 sep-2026 reconstrucción bias HTF: buffer de closes por TF (para derivar bias
    // cuando el SYNC es NEUTRAL). Solo TFs macro: 60/240/D/W.
    if (!signalsFrozen && (eventTf === '60' || eventTf === '240' || eventTf === 'D' || eventTf === '1D' || eventTf === 'W' || eventTf === '1W')) {
      if (!state.htfCloses) state.htfCloses = {};
      const buf = (state.htfCloses[eventTf] = state.htfCloses[eventTf] || []);
      buf.push(currentPrice);
      if (buf.length > 60) buf.shift();
    }

    // 🆕 sep-2026 climax por rango: guardar high/low de la última vela por TF (detección
    // de vela de climax con 2×ATR en el SMART — medible en backtest, paridad con live).
    if (!signalsFrozen) {
    if (!state.htfHighLow) state.htfHighLow = {};
    state.htfHighLow[eventTf] = [highPrice, lowPrice];

    if (!experimental) {
      // 🛡️ Paridad ATR: solo alimentar Wilder-14 con el TF de ejecución primario ('5', o '15'/'3' si no existe '5').
      // Evita que velas H1/H4/D1 contaminen state.atr14 con rangos multi-día y saltos de prevClose entre TFs.
      const stAny = state as any;
      if (eventTf === '5') stAny.atrPrimaryTf = '5';
      const atrPrimaryTf = stAny.atrPrimaryTf ?? ((eventTf === '15' || eventTf === '3') ? eventTf : null);
      if (atrPrimaryTf && eventTf === atrPrimaryTf) {
        const prevClose = rolloverFreeze
          ? (rolloverCleanCloses.get(state) ?? currentPrice)
          : (stAny.atrPrevClose ?? state.lastPrice ?? currentPrice);
        const tr = Math.max(highPrice - lowPrice, Math.abs(highPrice - prevClose), Math.abs(lowPrice - prevClose));
        if (state.atr14 === undefined) {
          state.atrSeed = (state.atrSeed ?? 0) + tr;
          state.atrSamples = (state.atrSamples ?? 0) + 1;
          if (state.atrSamples >= 14) state.atr14 = state.atrSeed / 14;
        } else {
          state.atr14 = (state.atr14 * 13 + tr) / 14;
        }
        stAny.atrPrevClose = currentPrice;
      }
    } else {
      state.atr14 = getExecutionSnapshot(state, p.executionObservation?.tf ?? eventTf, nowMs)?.atr14;
    }

    } // signal-only hydration; raw prices/exits continue below
    const previousPrice = state.lastPrice;
    state.lastPrice = currentPrice;
    state.previousPrice = rolloverFreeze ? (rolloverCleanCloses.get(state) ?? null) : previousPrice;
    if(rolloverFreeze && !signalsFrozen)rolloverCleanCloses.set(state,currentPrice);

    // Same causal price/ATR/HTF hydration, before any scoring, leg or order.
    if (contextOnly) return;

    // Evaluate impulse legs

    const currentSession = getSessionForTimestamp(nowMs);
    const sessionConfig = config.sessions?.[currentSession] ?? config.sessions?.['ALL'];
    const ctx = { config, currentSession, sessionConfig, rolloverFreeze, observationInterval };

    const buyRes = evaluateImpulseCore(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs, ctx);
    state.activeImpulseBuy = buyRes.updatedLeg;
    if (buyRes.newTrade && buyRes.oteData) createTrade({ ...buyRes.oteData, ...buyRes.newTrade }, nowMs, trades, activeTrades, dailyStats, config, state);

    const sellRes = evaluateImpulseCore(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs, ctx);
    state.activeImpulseSell = sellRes.updatedLeg;
    if (sellRes.newTrade && sellRes.oteData) createTrade({ ...sellRes.oteData, ...sellRes.newTrade }, nowMs, trades, activeTrades, dailyStats, config, state);


    // Evaluate each native macro TF/direction, preserving the existing lifecycle.
    updateMacroImpulses(state, highPrice, lowPrice, nowMs, rolloverFreeze, observationInterval);

    // Evaluate active trades TP/SL
    for (const [tradeId, trade] of activeTrades) {
      if (config.rolloverPolicy?.profile === 'rollover_triage_v1') {
        const input = config.rolloverTriageContexts?.[`${ticker}:${trade.id}:${nowMs}`];
        const matches = input && input.profile === 'rollover_triage_v1' && input.ticker === ticker && input.tradeId === trade.id
          && input.nowMs === nowMs && input.direction === trade.direction && input.entryPrice === trade.entryPrice
          && input.initialSlPrice === trade.initialSlPrice && input.initialRiskPrice === trade.rolloverInitialRiskPrice
          && input.currentSlPrice === trade.slPrice && !!config.rolloverPolicy.triage;
        const proposal = matches ? evaluateRolloverTriage({...structuredClone(input),config:config.rolloverPolicy.triage!,
          ...(config.rolloverPolicy.peakSpread?{peakSpread:config.rolloverPolicy.peakSpread}:{})})
          : {action:'HOLD' as const,reason:'unavailable_bilateral_asof_trade_context'};
        // Existing CSV execution has no real Ask/cost stream or bilateral confirmation model.
        // Keep proposal telemetry separate: never relabel a policy intent as an executed amend/fill.
        (trade.rolloverTriage ??= []).push({nowMs,execution:'PROPOSAL_ONLY',proposal});
      }
      if (trade.executionPolicy?.profile === 'microstructure_v1') {
        const ledger = (trade as ModeledTrade).executionBacktest!;
        const quote = modeledExecutionQuote({ ...config, spreadPips: (ledger.fillQuote.ask - ledger.fillQuote.bid) / trade.executionInstrument!.pipSize }, currentPrice, nowMs, trade.executionInstrument);
        const tf = (trade.tf ?? eventTf).replace(/[^0-9]/g, '') || eventTf;
        if (quote && manageModeledTrade(trade, quote, getExecutionSnapshot(state, tf, nowMs), nowMs, ticker)) {
          activeTrades.delete(tradeId);
          updateDailyStatsFromClose(trade, dailyStats, config);
        }
        continue;
      }
      const tradeAge = nowMs - trade.timestamp;
      if (tradeAge < 5000) continue;

      const mgmt = resolveBacktestMgmt(trade, config);
      const { partialPct, remainderPct, slAfterTp1Mode, tp15BeEnabled, atrTrailEnabled } = mgmt;

      // 🆕 ROI TIME-DECAY (paridad con trading.ts:2070 per-gatillo → raíz)
      const roiTable = mgmt.minimalRoi;
      if (roiTable && Object.keys(roiTable).length > 0 && !trade.tp1Hit) {
        const tradeAgeMin = tradeAge / 60000;
        const thresholds = Object.keys(roiTable).map(k => parseInt(k, 10)).sort((a, b) => b - a);
        let effectiveROI = 0;
        let roiLabel: string | null = null;
        for (const t of thresholds) {
          if (tradeAgeMin >= t) {
            effectiveROI = roiTable[String(t)];
            roiLabel = effectiveROI === 0 ? 'breakeven' : `${t}m_${(effectiveROI * 100).toFixed(1)}%`;
            break;
          }
        }
        if (effectiveROI > 0 && roiLabel) {
          const pnlPct = trade.direction === 'BUY'
            ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
            : (trade.entryPrice - currentPrice) / trade.entryPrice * 100;
          if (pnlPct >= effectiveROI * 100) {
            (trade as any).roiDecayApplied = roiLabel;
            const originalSl = trade.originalSlPrice ?? trade.slPrice;
            const slDistPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
            const grossR = slDistPct > 0 ? parseFloat((pnlPct / slDistPct).toFixed(4)) : 0;
            // 🔧 FIX: cobrar comisión round-turn (consistente con el resto de exits)
            const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
            const cls = getAssetClass(config.ticker);
            const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
            const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker, currentPrice)) : 0;
            trade.result = 'WIN';
            trade.pnl = pnlPct;
            trade.rMultiple = (grossR - transactionCostR) * (trade.riskMult || 1.0);
            trade.closeTimestamp = nowMs;
            trade.durationMin = Math.round(tradeAge / 60000);
            activeTrades.delete(tradeId);
            updateDailyStatsFromClose(trade, dailyStats, config);
            continue;
          }
        } else if (effectiveROI === 0 && !(trade as any).roiDecayApplied) {
          (trade as any).roiDecayApplied = 'breakeven';
          trade.slPrice = btBreakevenBuffer(config.ticker, trade.entryPrice, trade.direction);
        }
      }

      const MAX_HOLD_MS = config.maxHoldMin ? config.maxHoldMin * 60000 : Infinity;
      if (tradeAge >= MAX_HOLD_MS) {
        const pnlDist = trade.direction === 'BUY'
          ? currentPrice - trade.entryPrice
          : trade.entryPrice - currentPrice;
        
        const originalSl = trade.originalSlPrice ?? trade.slPrice;
        const slDist = Math.abs(originalSl - trade.entryPrice);
        
        const riskPips = slDist / pipSize;
        const cls = getAssetClass(config.ticker);
        const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
        const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker, currentPrice)) : 0;

        const lockedPct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 * partialPct : 0;
        const openPct = (pnlDist / trade.entryPrice) * 100 * (trade.tp1Hit ? remainderPct : 1.0);
        const slPct = (slDist / trade.entryPrice) * 100;

        trade.pnl = lockedPct + openPct;
        trade.rMultiple = slPct > 0 ? ((lockedPct + openPct) / slPct - transactionCostR) * (trade.riskMult || 1.0) : 0;
        trade.result = trade.rMultiple > 0 ? 'WIN' : trade.rMultiple === 0 ? 'BE' : 'LOSS';
        
        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round(tradeAge / 60000);
        activeTrades.delete(tradeId);
        updateDailyStatsFromClose(trade, dailyStats, config);
        continue;
      }

      // 1) SL con niveles de apertura de barra (path desconocido => peor caso)
      const slAtBarOpen = trade.slPrice;
      const slHitFirst = trade.direction === 'BUY' ? lowPrice <= slAtBarOpen : highPrice >= slAtBarOpen;
      if (slHitFirst) {
        const isPartialClose = trade.tp1Hit;
        const cls = getAssetClass(config.ticker);
        const latencyMs = config.latencyMs ?? defaultFrictionConfig[cls].latencyMs;
        const exitSlip = (latencyMs / 50) * 0.1 * pipSize;
        const slFill = trade.direction === 'BUY' ? trade.slPrice - exitSlip : trade.slPrice + exitSlip;

        const slPnlPct = trade.direction === 'BUY' 
          ? (slFill - trade.entryPrice) / trade.entryPrice * 100 
          : (trade.entryPrice - slFill) / trade.entryPrice * 100;
        const pnlTp1Pct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 : 0;
        const finalPnlPct = isPartialClose ? (pnlTp1Pct * partialPct + slPnlPct * remainderPct) : slPnlPct;
        const finalResult = finalPnlPct > 0 ? 'WIN' : finalPnlPct === 0 ? 'BE' : 'LOSS';

        trade.result = finalResult;
        trade.pnl = finalPnlPct;
        trade.resultTp2 = finalResult;
        trade.pnlTp2 = finalPnlPct;
        
        const originalSl = trade.originalSlPrice ?? trade.slPrice;
        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
        
        // 🆕 COSTOS DE TRANSACCIÓN (Mejora 6)
        const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
        const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
        const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker)) : 0;
        
        const grossR = initialSlLossPct > 0 ? finalPnlPct / initialSlLossPct : 0;
        trade.rMultiple = initialSlLossPct > 0 ? (grossR - transactionCostR) * (trade.riskMult || 1.0) : 0;
        
        if (!isPartialClose) {
          trade.resultTp1 = 'LOSS';
          trade.pnlTp1 = -initialSlLossPct;
          trade.rMultipleTp1 = undefined; // Don't show confusing -50 in TP1
          trade.rMultipleTp2 = undefined; // Don't show confusing -50 in TP2
        } else {
          trade.rMultipleTp2 = initialSlLossPct > 0 ? slPnlPct / initialSlLossPct : 0.0;
        }

        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
        activeTrades.delete(tradeId);
        updateDailyStatsFromClose(trade, dailyStats, config);
        continue;
      }

      // 2) solo si no hubo SL: TP1, trailing BE, TP2


      // TP1
      if (!trade.tp1Hit) {
        const tp1Hit = trade.direction === 'BUY' ? highPrice >= trade.tp1Price : lowPrice <= trade.tp1Price;
        if (tp1Hit) {
          trade.tp1Hit = true;
          const originalSl = trade.originalSlPrice ?? trade.slPrice;
          const slLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
          // Tras TP1: ajuste del SL según slAfterTp1 ('midpoint' default | 'breakeven' | 'none')
          if (slAfterTp1Mode === 'midpoint') {
            trade.slPrice = originalSl + (trade.entryPrice - originalSl) * 0.5;
            trade.slHalfwayHit = true;
          } else if (slAfterTp1Mode === 'breakeven') {
            trade.slPrice = btBreakevenBuffer(config.ticker, trade.entryPrice, trade.direction);
          }
            
          trade.resultTp1 = 'WIN';
          trade.pnlTp1 = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
          
          const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
          const cls = getAssetClass(config.ticker);
          const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
          const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker)) : 0;
          
          const grossR = slLossPct > 0 ? trade.pnlTp1 / slLossPct : 1.0;
          trade.rMultipleTp1 = ((grossR * partialPct) - (transactionCostR * partialPct)) * (trade.riskMult || 1.0);
        }
      }

      // TP1.5 (Trailing a BE diferido)
      if (trade.tp1Hit && !trade.tp1_5Hit && tp15BeEnabled) {
        const tp1_5Price = trade.direction === 'BUY' 
          ? trade.tp1Price + Math.abs(trade.tp1Price - trade.entryPrice) * 0.5
          : trade.tp1Price - Math.abs(trade.tp1Price - trade.entryPrice) * 0.5;
        const tp1_5Hit = trade.direction === 'BUY' ? highPrice >= tp1_5Price : lowPrice <= tp1_5Price;
        if (tp1_5Hit) {
          trade.tp1_5Hit = true;
          trade.slPrice = btBreakevenBuffer(config.ticker, trade.entryPrice, trade.direction);
        }
      }

      // 🔧 FIX conservador: guardar SL antes del trail para detectar si la vela ambigua violó el SL VIEJO (High/Low mismo tick optimista)
      const slBeforeTrail = trade.slPrice;
      // Complemento PING: trailing continuo post-TP1 por distancia (paridad con trading.ts:2508-2538: cota en entryPrice)
      if (trade.tp1Hit && atrTrailEnabled) {
        const atrThreshold = (state.atr14 ?? 0) * 1.5;
        const ratchetStep = (state.atr14 ?? 0) * 0.25;
        if (trade.direction === 'BUY') {
          let atrTrailSL = highPrice - atrThreshold;
          if (atrTrailSL > trade.entryPrice) atrTrailSL = trade.entryPrice;
          if (atrTrailSL > trade.slPrice + ratchetStep) {
            trade.slPrice = atrTrailSL;
          }
        } else {
          let atrTrailSL = lowPrice + atrThreshold;
          if (atrTrailSL < trade.entryPrice) atrTrailSL = trade.entryPrice;
          if (atrTrailSL < trade.slPrice - ratchetStep) {
            trade.slPrice = atrTrailSL;
          }
        }
      }

      // Chequeo de vela ambigua: si en la misma vela se alcanzó TP1 o TP1.5 (modificando el SL) y también se violó el nuevo SL
      if (trade.tp1Hit) {
        const slViolated = trade.direction === 'BUY' ? lowPrice <= trade.slPrice : highPrice >= trade.slPrice;
        // 🔧 FIX conservador: si la vela violó el SL VIEJO (pre-trail), el trade se detiene en ese SL, no en el trail
        const slViolatedOld = trade.direction === 'BUY' ? lowPrice <= slBeforeTrail : highPrice >= slBeforeTrail;
        const effectiveSl = (slViolatedOld && trade.slPrice !== slBeforeTrail) ? slBeforeTrail : trade.slPrice;
        if (slViolated || (slViolatedOld && trade.slPrice !== slBeforeTrail)) {
          trade.resultTp2 = 'LOSS';
          const slPnlPct = trade.direction === 'BUY' 
            ? (effectiveSl - trade.entryPrice) / trade.entryPrice * 100 
            : (trade.entryPrice - effectiveSl) / trade.entryPrice * 100;
          trade.pnl = trade.pnlTp1! * partialPct + slPnlPct * remainderPct;
          trade.pnlTp2 = trade.pnl;
          
          const originalSl = trade.originalSlPrice ?? trade.slPrice;
          const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
          
          const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
          const cls = getAssetClass(config.ticker);
          const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
          const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker)) : 0;
          
          const grossR = initialSlLossPct > 0 ? trade.pnl / initialSlLossPct : 0;
          trade.rMultiple = (grossR - transactionCostR) * (trade.riskMult || 1.0);
          trade.result = trade.rMultiple > 0 ? 'WIN' : trade.rMultiple === 0 ? 'BE' : 'LOSS'; // 🔧 FIX: result derivado del R real (antes hardcodeado 'WIN')
          
          trade.closeTimestamp = nowMs;
          trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
          activeTrades.delete(tradeId);
          updateDailyStatsFromClose(trade, dailyStats, config);
          continue;
        }
      }
      // TP2
      if (trade.tp2Price > 0) {
        const tp2Hit = trade.direction === 'BUY' ? highPrice >= trade.tp2Price : lowPrice <= trade.tp2Price;
        if (tp2Hit) {
          trade.result = 'WIN';
          trade.resultTp2 = 'WIN';
          const pnlTp1 = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
          const pnlTp2 = Math.abs(trade.tp2Price - trade.entryPrice) / trade.entryPrice * 100;
          const finalPnl = trade.tp1Hit ? (pnlTp1 * partialPct + pnlTp2 * remainderPct) : pnlTp2;
          
          trade.pnl = finalPnl;
          trade.pnlTp2 = finalPnl;
          const originalSl = trade.originalSlPrice ?? trade.slPrice;
          const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
          
          // 🆕 COSTOS DE TRANSACCIÓN (Mejora 6)
          const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
          const cls = getAssetClass(config.ticker);
          const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
          const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker)) : 0;
          
          const grossR = initialSlLossPct > 0 ? finalPnl / initialSlLossPct : 0;
          trade.rMultiple = initialSlLossPct > 0 ? (grossR - transactionCostR) * (trade.riskMult || 1.0) : 0;
          
          const grossRTp2 = initialSlLossPct > 0 ? pnlTp2 / initialSlLossPct : 0;
          trade.rMultipleTp2 = initialSlLossPct > 0 ? ((grossRTp2 * remainderPct) - (transactionCostR * remainderPct)) * (trade.riskMult || 1.0) : 0;
          trade.closeTimestamp = nowMs;
          trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
          activeTrades.delete(tradeId);
          updateDailyStatsFromClose(trade, dailyStats, config);
          continue;
        }
      }



    }

    // Zone touching (scoring — paridad exacta de buffer y guardas con trading.ts:2798-2816)
    const buffer = getBuffer(ticker, currentPrice);
    const validZones: RadarZone[] = [];
    const touchedThisPing: { zone: RadarZone; eventName: string; pts: number }[] = [];

    for (const zone of state.zones) {
      if (zone.createdAt && (nowMs - zone.createdAt) >= (MAX_ZONE_AGE_MS[zone.tf || '60'] || 14400000)) continue;
      validZones.push(zone);

      if (currentPrice <= (zone.top + buffer) && currentPrice >= (zone.btm - buffer)) {
        const enteredFromAbove = previousPrice !== null && previousPrice > zone.top;
        const enteredFromBelow = previousPrice !== null && previousPrice < zone.btm;
        const isValid = (zone.dir === 'BUY' && enteredFromAbove) || (zone.dir === 'SELL' && enteredFromBelow);
        if (!isValid && previousPrice !== null) continue;

        const activeScore = zone.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
        if (hasLegacyUnresolvedZoneEvidence(activeScore, zone.tf || eventTf)) continue;
        const zTf = parseTF(zone.tf || '');
        const basePts = zone.score !== undefined ? zone.score : 2;
        
        let confluenceMultiplier = 1.0;
        let confluenceTFs: string[] = [];
        for (const otherZone of state.zones) {
            if (otherZone === zone) continue;
            if (otherZone.dir !== zone.dir) continue;
            if (otherZone.tf === zone.tf) continue;
            const overlaps = !(otherZone.top < zone.btm || otherZone.btm > zone.top);
            if (overlaps && !confluenceTFs.includes(otherZone.tf || '')) {
                confluenceTFs.push(otherZone.tf || '');
            }
        }
        if (confluenceTFs.length >= 3) confluenceMultiplier = 2.5;
        else if (confluenceTFs.length >= 2) confluenceMultiplier = 2.0;
        else if (confluenceTFs.length >= 1) confluenceMultiplier = 1.5;

        const tfMult = zTf === '4H' ? 2 : zTf === '1H' ? 1.5 : 1;
        const eventName = zone.medal?.includes('God') ? `💎_GOD_ZONE_${zTf}` :
                          zone.medal?.includes('CHoCH') ? `🎯_Silver_Bullet_${zTf}` :
                          zone.medal?.includes('Breaker') ? `♻️_Breaker_${zTf}` :
                          `OB_${zone.medal}_${zTf}`;
        // 🆕 sep-2026 (Capa 1): multiplicador por familia × sesión (config.zoneWeights)
        const zoneFamily = zone.medal?.includes('God') ? 'GOD' :
                           zone.medal?.includes('CHoCH') ? 'SB' :
                           zone.medal?.includes('Breaker') ? 'BREAKER' : 'OB';
        const zwMult = zoneWeightMult(config, zoneFamily, currentSession);
        const pts = Math.floor(basePts * tfMult * confluenceMultiplier * zwMult);
        if (addScoreEvent(activeScore, { id: eventName, pts, tf: zone.tf || eventTf, ts: nowMs })) {
          touchedThisPing.push({ zone, eventName, pts });
        }
      }
    }

    for (const dir of ['BUY', 'SELL'] as const) {
        const dirZones = touchedThisPing.filter(t => t.zone.dir === dir);
        if (dirZones.length < 2) continue;

        const activeScore = dir === 'BUY' ? state.scoreBuy : state.scoreSell;
        const uniqueTFs = new Set(dirZones.map(t => t.zone.tf));
        const tfCount = uniqueTFs.size;

        if (tfCount >= 2) {
            const zonesOverlap = dirZones.some((a, i) =>
                dirZones.some((b, j) => i !== j && a.zone.tf !== b.zone.tf && !(a.zone.top < b.zone.btm || a.zone.btm > b.zone.top))
            );
            if (!zonesOverlap) continue;

            let confluenceBonus = tfCount === 4 ? 10 : tfCount === 3 ? 7 : 4;
            const tfList = [...uniqueTFs].map(t => parseTF(t || '')).sort((a: any, b: any) => {
                const order: Record<string, number> = { '5M': 0, '15M': 1, '1H': 2, '4H': 3, 'D': 4 };
                return (order[b] || 0) - (order[a] || 0);
            }).join('+');

            const eventName = `🧲_CONFLUENCIA_${tfCount}TF_${tfList}`;
            // TF del evento = el de mayor jerarquía entre las zonas en confluencia
            const confTf = [...uniqueTFs].reduce((best, t) => (TF_RANK[t || ''] ?? 0) > (TF_RANK[best || ''] ?? 0) ? t : best, [...uniqueTFs][0] || eventTf);
            addScoreEvent(activeScore, { id: eventName, pts: confluenceBonus, tf: confTf || eventTf, ts: nowMs });
        }
    }

    state.zones = validZones;
    return;
  }

  if (contextOnly && prefix !== 'EVENTO_CHOCH' && prefix !== 'EVENTO_BOS' && prefix !== 'ZONE_BROKEN') return;

  // --- EVENTS WITH DIRECTION ---
  if (!currentDirection) return;
  const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
  const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
  let addedPoints = 0;
  let addedEventId: string | null = null;

  if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') {
    if (!state.biasTs) state.biasTs = {};
    state.marketBias[eventTf] = currentDirection;
    state.biasTs[eventTf] = nowMs;
    // Bias is context; pre-boundary structure must not create a pending setup.
    if (contextOnly) return;

    // 💥 Invalidación estructural acotada: el CHoCH/BOS borra del score CONTRARIO
    // los eventos de TF de igual o menor jerarquía que el gatillo
    structuralInvalidate(oppositeScore, eventTf, nowMs);

    const priceMatchTop = alertText.match(/Precio:\s*([0-9.]+)/i);
    const actualPriceTop = priceMatchTop ? parseFloat(priceMatchTop[1]) : state.lastPrice || 0;
    // Paridad con vivo (trading.ts:2906): actualizar state.lastPrice con el cierre de la vela de ruptura
    // antes de evaluar la entrada directa (en los CSV exportados EVENTO_CHOCH antecede a PING_PRICE).
    if (priceMatchTop && actualPriceTop) state.lastPrice = actualPriceTop;

    if (eventTf === '5' || eventTf === '15') {
      const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
      const actualPrice = actualPriceTop;
      
      // 🆕 FIX 2.5: Registrar explícitamente el CHOCH/BOS contrario en el score opuesto para permitir invalidación
      // (pts 0: es un marcador estructural, no puntúa; se añade tras structuralInvalidate para sobrevivir)
      const eventKey = `${prefix}_${readableTf}`;
      addScoreEvent(oppositeScore, { id: eventKey, pts: 0, tf: eventTf, ts: nowMs });

      if (originMatch && actualPrice) {
        const newOrigin = parseFloat(originMatch[1]);
        const isBuy = currentDirection === 'BUY';
        const activeLeg = isBuy ? state.activeImpulseBuy : state.activeImpulseSell;

        let shouldCreateNew = true;
        if (activeLeg) {
          const isInside = actualPrice > Math.min(activeLeg.origin, activeLeg.extreme) && actualPrice < Math.max(activeLeg.origin, activeLeg.extreme);
          if (isInside) shouldCreateNew = false;
          if (activeLeg.createdAt && (nowMs - activeLeg.createdAt) < 3 * 60 * 1000) shouldCreateNew = false;
        }

        const impulseRange = Math.abs(actualPrice - newOrigin);
        const minRange = getMinImpulseRange(ticker, actualPrice);
        if (impulseRange < minRange) shouldCreateNew = false;

        if (shouldCreateNew) {
          let macroTarget: number | null = null;
          if (isBuy && state.activeImpulseSell) { macroTarget = state.activeImpulseSell.origin; state.activeImpulseSell = null; }
          else if (!isBuy && state.activeImpulseBuy) { macroTarget = state.activeImpulseBuy.origin; state.activeImpulseBuy = null; }

          const newLeg: ImpulseLeg = {
            dir: currentDirection, origin: newOrigin, extreme: actualPrice,
            createdAt: nowMs, tp2: macroTarget, oteScored: false,
          };
          if (isBuy) {
            state.activeImpulseBuy = newLeg;
            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              if (trade.executionPolicy?.profile === 'microstructure_v1') {
                if (trade.direction === currentDirection && p.executionObservation?.breakBar?.closed) {
                  (trade as ModeledTrade).executionBacktest!.latestStructuralOrigin = { price: newOrigin, direction: currentDirection, tf: eventTf, eventAtMs: nowMs, availableAtMs: nowMs };
                }
                continue;
              }
              const stEnabled = resolveBacktestMgmt(trade, config).structuralTrailEnabled;
              if (!stEnabled) continue;
              if (trade.direction === 'BUY' && trade.tp1Hit && !trade.closeTimestamp) {
                const atrTrail = (state.atr14 ?? Math.abs(actualPrice - newOrigin) * 0.3) * 0.5;
                const structuralBuffer = Math.max(2 * (config.spreadPips ?? 0.1) * pipSize, atrTrail);
                const trailedSL = newOrigin - structuralBuffer;
                // Ratchet con paso mínimo: solo mover si mejora ≥ 0.25×ATR
                if (trailedSL > trade.slPrice + atrTrail * 0.5) trade.slPrice = trailedSL;
              }
            }
          } else {
            state.activeImpulseSell = newLeg;
            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              if (trade.executionPolicy?.profile === 'microstructure_v1') {
                if (trade.direction === currentDirection && p.executionObservation?.breakBar?.closed) {
                  (trade as ModeledTrade).executionBacktest!.latestStructuralOrigin = { price: newOrigin, direction: currentDirection, tf: eventTf, eventAtMs: nowMs, availableAtMs: nowMs };
                }
                continue;
              }
              const stEnabled = resolveBacktestMgmt(trade, config).structuralTrailEnabled;
              if (!stEnabled) continue;
              if (trade.direction === 'SELL' && trade.tp1Hit && !trade.closeTimestamp) {
                const atrTrail = (state.atr14 ?? Math.abs(actualPrice - newOrigin) * 0.3) * 0.5;
                const structuralBuffer = Math.max(2 * (config.spreadPips ?? 0.1) * pipSize, atrTrail);
                const trailedSL = newOrigin + structuralBuffer;
                // Ratchet con paso mínimo: solo mover si mejora ≥ 0.25×ATR
                if (trailedSL < trade.slPrice - atrTrail * 0.5) trade.slPrice = trailedSL;
              }
            }
          }
        }
      }
    }
    // Independent of execution-leg creation: M15 is macro context for M5.
    if (eventTf === '15' || eventTf === '60' || eventTf === '240' || eventTf === 'D') {
      const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
      const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
      const actualPrice = priceMatch ? parseFloat(priceMatch[1]) : state.lastPrice || 0;
      if (originMatch && actualPrice) {
        const newOrigin = parseFloat(originMatch[1]);
        const newMacroLeg: ImpulseLeg = {
          dir: currentDirection, origin: newOrigin, extreme: actualPrice,
          createdAt: nowMs, oteScored: false,
        };
        recordMacroImpulse(state, eventTf, newMacroLeg);
      }
    }
    // Paridad con vivo (trading.ts:3049-3050): ponderación por TF_WEIGHT.
    const basePoints = prefix === 'EVENTO_CHOCH' ? 3 : 2;
    addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
    addedEventId = `${prefix === 'EVENTO_CHOCH' ? 'CHoCH' : 'BOS'}_${readableTf}`;
  }
  else if (prefix === 'ZONE_BROKEN') {
    const nativeBroken = parseNativeZoneBreak(alertText);
    const topMatch = alertText.match(/(?:^|\|)\s*Top:\s*([0-9.+-]+)/i);
    const btmMatch = alertText.match(/(?:^|\|)\s*Btm:\s*([0-9.+-]+)/i);
    const explicitTop = topMatch ? Number(topMatch[1]) : NaN;
    const explicitBtm = btmMatch ? Number(btmMatch[1]) : NaN;
    const hasExplicitBounds = Number.isFinite(explicitTop) && Number.isFinite(explicitBtm) && explicitTop >= explicitBtm;

    activeScore.events = activeScore.events.filter(e => {
      if (e.id.includes(`_${readableTf}`) && (
        e.id.startsWith('OB_') || e.id.startsWith('💎_GOD_ZONE_') ||
        e.id.startsWith('🎯_Silver_Bullet_') || e.id.startsWith('♻️_Breaker_') ||
        e.id.startsWith('POC_Volume_') || e.id.startsWith('🎯_ZoneTouched_') ||
        e.id.startsWith('Breaker_')
      )) {
        return false;
      }
      return true;
    });
    refreshScoreCache(activeScore, nowMs);

    state.zones = state.zones.filter(z => {
      if (nativeBroken) return !matchesNativeBrokenZone(z, eventTf, nativeBroken);
      if (z.tf !== eventTf) return true;
      if (hasExplicitBounds) {
        return !(z.dir === currentDirection && Math.abs(z.top - explicitTop) <= 1e-5 && Math.abs(z.btm - explicitBtm) <= 1e-5);
      }
      if (currentDirection === 'BUY' && z.dir === 'BUY') return true;
      if (currentDirection === 'SELL' && z.dir === 'SELL') return true;
      return false;
    });
    return;
  }
  else if (prefix === 'SWEEP_BROKEN' || prefix === 'DIV_BROKEN') {
    if (prefix === 'SWEEP_BROKEN') {
      activeScore.events = activeScore.events.filter(e => {
        if (e.id === `🩸_V-Shape_Absorb_${readableTf}` || e.id === `Sweep_${readableTf}_Absorcion`) return false;
        if (e.id === `Sweep_${readableTf}`) return false;
        if (e.id === `📉_TL_Sweep_${readableTf}`) return false;
        if (e.id === `🩸_LIQ_GRAB_${readableTf}`) return false;
        return !e.id.includes(`Sweep_${readableTf}`);
      });
    } else {
      activeScore.events = activeScore.events.filter(e => !e.id.startsWith(`DIV_${readableTf}`));
    }
    refreshScoreCache(activeScore, nowMs);
    return;
  }
  else if (prefix === 'TOUCH_ZONE') {
    const ptMatch = alertText.match(/Puntos:\s*(\d+)/i);
    const dynamicPts = ptMatch ? parseInt(ptMatch[1], 10) : 0;
    if (upperText.includes('BREAKER')) {
      if (!activeScore.events.some(e => e.id === `Breaker_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 3; addedEventId = `Breaker_${readableTf}`; }
    } else if (upperText.includes('PLATINO') || upperText.includes('POC')) {
      if (!activeScore.events.some(e => e.id === `POC_Volume_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 4; addedEventId = `POC_Volume_${readableTf}`; }
    } else if (upperText.includes('GOD_ZONE') || upperText.includes('ORO')) {
      if (!activeScore.events.some(e => e.id === `OB_Gold_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 3; addedEventId = `OB_Gold_${readableTf}`; }
    } else {
      if (!activeScore.events.some(e => e.id === `OB_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 2; addedEventId = `OB_${readableTf}`; }
    }
  }
  else if (prefix === 'EVENTO_SMC_DIV') {
    if (!activeScore.events.some(e => e.id === `DIV_${readableTf}`)) {
      const dynamicScoreMatch = alertText.match(/Score:\s*([0-9]+)/i);
      const parsedDivScore = dynamicScoreMatch ? parseInt(dynamicScoreMatch[1], 10) : 4;
      let divPts = parsedDivScore > 0 ? parsedDivScore : 4;
      if (eventTf === 'D') divPts = 0;
      else if (eventTf === '240') divPts = Math.min(divPts, 2);
      addedPoints = Math.round(divPts * zoneWeightMult(config, 'DIV', currentSession));
      addedEventId = `DIV_${readableTf}`;
    }
  }
  else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
    if (!activeScore.events.some(e => e.id === `Sweep_${readableTf}` || e.id === `🩸_V-Shape_Absorb_${readableTf}`)) {
      const basePoints = upperText.includes('ABSORCION') ? 6 : 3;
      const sweepMult = zoneWeightMult(config, 'SWEEP', currentSession);
      addedPoints = Math.round(basePoints * (TF_WEIGHT[eventTf] || 1) * sweepMult);
      addedEventId = upperText.includes('ABSORCION') ? `🩸_V-Shape_Absorb_${readableTf}` : `Sweep_${readableTf}`;
    }
  }
  else if (prefix === 'LIQ_GRAB') {
    const eventName = `🩸_LIQ_GRAB_${readableTf}`;
    if (!activeScore.events.some(e => e.id === eventName)) {
      addedPoints = 4 * (TF_WEIGHT[eventTf] || 1);
      addedEventId = eventName;
    }
  }
  else if (prefix === 'ZONE_TOUCHED') {
    const zoneMedal = canonicalZoneMedal(alertText.match(/Medal:\s*([\w🚀♻️💎]+)/i)?.[1]) ?? 'OB';
    const zoneScore = parseInt(alertText.match(/Score:\s*([0-9]+)/i)?.[1] || '2', 10);
    const eventName = `🎯_ZoneTouched_${zoneMedal}_${readableTf}`;
    if (!hasLegacyUnresolvedZoneEvidence(activeScore, eventTf) && !activeScore.events.some(e => e.id === eventName)) {
      const basePoints = zoneScore >= 9 ? 5 : zoneScore >= 7 ? 4 : zoneScore >= 5 ? 3 : 2;
      addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
      addedEventId = eventName;
    }
  }
  else if (prefix === 'EVENTO_SWEEP_TL') {
    if (!activeScore.events.some(e => e.id === `📉_TL_Sweep_${readableTf}`)) {
      addedPoints = 2;
      addedEventId = `📉_TL_Sweep_${readableTf}`;
    }
    if (oppositeScore.events.some(e => e.id === `📉_TL_Sweep_${readableTf}`)) {
      oppositeScore.events = oppositeScore.events.filter(e => e.id !== `📉_TL_Sweep_${readableTf}`);
      refreshScoreCache(oppositeScore, nowMs);
    }
  }
  else if (prefix === 'HEARTBEAT') {
    state.lastHeartbeat = nowMs;
    return;
  }

  if (addedPoints > 0 && addedEventId) {
    if (addedPoints > 50) addedPoints = 50;
    addScoreEvent(activeScore, { id: addedEventId, pts: addedPoints, tf: eventTf, ts: nowMs });
  }

  // 🆕 FIX PERF: Limitar tamaño de arrays de eventos para evitar crecimiento infinito O(N)
  if (state.scoreBuy.events.length > 50) state.scoreBuy.events = state.scoreBuy.events.slice(-50);
  if (state.scoreSell.events.length > 50) state.scoreSell.events = state.scoreSell.events.slice(-50);

  // --- LATE RE-VALIDATION (ported from live) ---
  if (prefix !== 'EVENTO_CHOCH' && prefix !== 'EVENTO_BOS' && currentDirection) {
    const pendingLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
    if (pendingLeg && !pendingLeg.isValidated && pendingLeg.chochPoints) {
      const hasZoneNow = activeScore.events.some(e =>
        e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
        e.id.includes('Sweep_') || e.id.includes('DIV_') || e.id.includes('TL_Sweep_') ||
        e.id.includes('ZoneTouched_') || e.id.includes('Silver_Bullet_')
      );
      if (hasZoneNow) {
        const origStructEvs = (pendingLeg.chochEvents || []).filter(e =>
          e.includes('🚀') || e.includes('🔨') || /^(?:EVENTO_)?(?:CHoCH|CHOCH|BOS)_/i.test(e)
        );
        pendingLeg.isValidated = true;
        pendingLeg.chochEvents = [...activeScore.events.map(e => e.id), ...(origStructEvs.length ? origStructEvs : [`CHoCH_${readableTf}`])];

        const lateLegEvs = pendingLeg.chochEvents || [];
        const lateEntryEv = lateLegEvs.find((e: string) => e.includes('🚀') || e.includes('🔨'));
        const lateStructEv = lateEntryEv ?? lateLegEvs.find((e: string) => /^(?:EVENTO_)?(?:CHoCH|CHOCH|BOS)_/i.test(e));
        const lateLegFam = lateStructEv?.toUpperCase().includes('BOS') ? 'BOS' : 'CHoCH';
        const canFireChoch = lateLegFam === 'BOS'
          ? (config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART')
          : (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
        const lateMinPts = currentDirection === 'BUY'
          ? (config.minBuyPoints ?? (config as any).minPointsForBuy ?? 4)
          : (config.minSellPoints ?? (config as any).minPointsForSell ?? 4);
        const lateTotalPts = pendingLeg.chochPoints!;
        const cooldownOk = nowMs - (state.lastSniperAlert ?? 0) >= ((config as any).sniperCooldownMs ?? 180000);

        const lateLegTfUpper = lateStructEv?.match(/_(\d+M|1H|4H|D|W)$/i)?.[1]?.toUpperCase() ?? '5M';
        const lateLegTf = lateLegTfUpper.toLowerCase();
        const lateSessionCfg = (config.sessions as any)?.[currentSession] ?? (config.sessions as any)?.['ALL'];
        const lateTriggerKey = `${lateLegFam === 'BOS' ? 'bos' : 'choch'}${lateLegTf}`;
        const lateTriggerCfg = (lateSessionCfg as any)?.[lateTriggerKey];
        let lateTriggerEnabled = true;
        let lateMinPtsG = lateMinPts;
        if (lateTriggerCfg) {
            lateTriggerEnabled = lateTriggerCfg.enabled ?? true;
            lateMinPtsG = currentDirection === 'BUY'
                ? (lateTriggerCfg.minScoreBuy ?? lateTriggerCfg.minScore ?? lateMinPts)
                : (lateTriggerCfg.minScoreSell ?? lateTriggerCfg.minScore ?? lateMinPts);
        }
        const lateSessionEnabled = (config as any).sessionEnabled !== false;

        if (canFireChoch && lateSessionEnabled && lateTriggerEnabled && cooldownOk && lateTotalPts >= lateMinPtsG) {
            const dec = getDecimals(ticker);
            const rawLateBuf = lateTriggerCfg?.slBuff != null
              ? lateTriggerCfg.slBuff
              : (lateSessionCfg?.slBufferPercent ?? config.slBufferPercent ?? 0.1);
            let slBuf = calculateDynamicSlBuffer(ticker, pendingLeg.origin, rawLateBuf);
            const minPipLate = getMinPipDistance(ticker);
            if (slBuf < minPipLate) slBuf = minPipLate;
            const adjSL = currentDirection === 'BUY' ? pendingLeg.origin - slBuf : pendingLeg.origin + slBuf;
            const fixedRR = lateTriggerCfg?.tp2 ?? lateSessionCfg?.fixedRR ?? (config as any).fixedRR ?? 1.5;
            const curPrice = state.lastPrice ?? pendingLeg.extreme;
            const rDist = Math.abs(curPrice - adjSL);

            // SMART: verificar distancia excesiva al origen (igual que live)
            let fireNow = true;
            if (experimental && executionPolicy.smart && config.entryTrigger === 'SMART') {
                const decision = pendingLeg.executionDecision ?? routeModeledSmart(pendingLeg, state, config, eventTf, nowMs, rDist,
                  curPrice + (currentDirection === 'BUY' ? 1 : -1) * rDist * fixedRR, p.executionObservation);
                fireNow = decision.takeDirectNow;
            } else if (config.entryTrigger === 'SMART') {
                const maxRisk = (config as any).maxSmartRiskPercent !== undefined ? (config as any).maxSmartRiskPercent : 0.15;
                const pctLimit = curPrice * (maxRisk / 100);
                let atr = 0;
                for (let i = state.zones.length - 1; i >= 0; i--) { if (state.zones[i].atr) { atr = state.zones[i].atr!; break; } }
                if (rDist > (atr > 0 ? atr * 1.5 : pctLimit)) fireNow = false;
            }

            const biasGateLate = (config as any).biasGateStrict === true
                && (state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL')
                && (state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL');
            if (biasGateLate) fireNow = false;

            if (fireNow) {
                const tId = Math.random().toString(36).substring(2, 8).toUpperCase();
                if (experimental && (!Number.isFinite(Number(fixedRR)) || Number(fixedRR) <= 0)) return;
                const fTP1 = currentDirection === 'BUY' ? curPrice + rDist : curPrice - rDist;
                const fTP2 = currentDirection === 'BUY' ? curPrice + (rDist * fixedRR) : curPrice - (rDist * fixedRR);
                createTrade({
                    tradeId: tId, direction: currentDirection,
                    entryPrice: curPrice,
                    stopLoss: adjSL.toFixed(dec), tp1: fTP1.toFixed(dec), tp2: fTP2.toFixed(dec),
                    points: lateTotalPts, events: pendingLeg.chochEvents || [],
                    isChochEntry: true,
                    execTrigger: lateTriggerKey,
                    mgmtOverrides: extractMgmtOverrides(lateTriggerCfg),
                    tf: lateLegTfUpper || readableTf,
                }, nowMs, trades, activeTrades, dailyStats, config, state);
                // Cooldown y reset idéntico al path directo (y al live)
                state.lastSniperAlert = nowMs;
                activeScore.events = []; refreshScoreCache(activeScore, nowMs);
                const oppScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
                oppScore.events = []; refreshScoreCache(oppScore, nowMs);
                if (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'SMART') pendingLeg.oteScored = true;
            }
        }
      }
    }
  }

  // --- CHoCH/BOS TRIGGER VALIDATION ---
  if ((prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') && (eventTf === '5' || eventTf === '15')) {
    if (nowMs - (state.lastSniperAlert ?? 0) < ((config as any).sniperCooldownMs ?? 180000)) return;

    const BIAS_TTL: Record<string, number> = { '5': 2*3600e3, '15': 4*3600e3, '60': 8*3600e3, '240': 48*3600e3, '1D': 120*3600e3, 'D': 120*3600e3, '4H': 48*3600e3, '1H': 8*3600e3 };
    const freshBias = (tf: string) => (nowMs - (state.biasTs?.[tf] ?? 0) < (BIAS_TTL[tf] ?? 24*3600e3)) ? state.marketBias?.[tf] : undefined;
    const mb240 = freshBias('240'); const mb60 = freshBias('60'); const mbD = freshBias('D') || freshBias('1D');
    
    // 🛡️ sep-2026: bono de alineación parametrizado por activo (biasConfluence, Paso 1).
    // Default = escalonado macro: 3/3 (D+4H+1H) = +5, 2/3 = +2, ≤1/3 = 0 (paridad con el vivo).
    // El set puede incluir TFs rápidos ('5','15'): el TF del gatillo cuenta como alineado
    // con la dirección por definición. El optimizador puede sortear esta config por activo.
    const bc = (config as any).biasConfluence ?? DEFAULT_BIAS_CONFLUENCE;
    const biasAlignedFor = (tf: string): boolean => {
        if (tf === eventTf) return true; // el gatillo es el bias más fresco de su TF
        const fb = tf === 'D' ? (freshBias('D') || freshBias('1D')) : freshBias(tf);
        return fb === currentDirection;
    };
    const macroAlignedCount = bc.tfs.reduce((acc: number, tf: string) => acc + (biasAlignedFor(tf) ? 1 : 0), 0);
    const baseBiasPoints = macroAlignedCount >= bc.minForFull ? bc.fullPts
        : macroAlignedCount >= bc.minForHalf ? bc.halfPts : 0;
    const isDAgainst = mbD !== undefined && mbD !== currentDirection && mbD !== 'NEUTRAL';
    const is4HAgainst = mb240 !== undefined && mb240 !== currentDirection && mb240 !== 'NEUTRAL';
    const is1HAgainst = mb60 !== undefined && mb60 !== currentDirection && mb60 !== 'NEUTRAL';

    // Los bonus VWAP / Macro OTE entran como eventos (pts incluidos en computePoints), igual que en live
    // 🆕 sep-2026: peso VWAP por activo (hyperopt → Firestore vwapPts). Env VWAP_PTS pisa para A/B.
    const VWAP_PTS = Number(process.env.VWAP_PTS ?? (config as any).vwapPts ?? 2);
    if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') addScoreEvent(activeScore, { id: 'VWAP_Discount', pts: VWAP_PTS, tf: eventTf, ts: nowMs });
    else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') addScoreEvent(activeScore, { id: 'VWAP_Premium', pts: VWAP_PTS, tf: eventTf, ts: nowMs });

    // Paridad con vivo (trading.ts:3347 & 4830): el MCL direccional se evalúa al crear el trade
    // (createTrade usa sessionBuyLossStreak / sessionSellLossStreak sin fallback a ALL), no antes de validar el leg.
    const sessionConfig = config.sessions?.[currentSession] ?? config.sessions?.['ALL'];

    // Spatial backing (paridad de buffer con vivo trading.ts:3347)
    const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
    const chOrigin = activeLeg ? activeLeg.origin : null;
    const chExtreme = activeLeg ? activeLeg.extreme : null;
    const spatialBuffer = getBuffer(ticker, chOrigin ?? state.lastPrice ?? 0);

    let hasSpatialBacking = false;
    let spatialBonus = 0;
    const SPATIAL_WEIGHT: Record<string, number> = { '15': 1.0, '60': 1.5, '240': 2.0 };

    if (chOrigin) {
      for (const z of state.zones) {
        if (z.dir !== currentDirection) continue;
        if (chOrigin <= (z.top + spatialBuffer) && chOrigin >= (z.btm - spatialBuffer)) {
          hasSpatialBacking = true;
          spatialBonus = Math.max(spatialBonus, Math.round((SPATIAL_WEIGHT[z.tf || ''] || 1.0) * 5));
        }
      }
    }
    if (chOrigin !== null && chExtreme !== null) {
      const chLow = Math.min(chOrigin, chExtreme);
      const chHigh = Math.max(chOrigin, chExtreme);
      for (const z of state.zones) {
        if (z.dir !== currentDirection) continue;
        if (chHigh >= (z.btm - spatialBuffer) && chLow <= (z.top + spatialBuffer)) {
          hasSpatialBacking = true;
          spatialBonus = Math.max(spatialBonus, Math.round((SPATIAL_WEIGHT[z.tf || ''] || 1.0) * 5));
        }
      }
    }

    const directTrigger = resolveDirectTrigger({
      direction: currentDirection as 'BUY' | 'SELL',
      entryTrigger: config.entryTrigger,
      sessionConfig,
      isChoch: prefix === 'EVENTO_CHOCH',
      eventTf,
      assetMinBuy: config.minBuyPoints,
      assetMinSell: config.minSellPoints,
    });
    let triggerEnabled = directTrigger.triggerEnabled;
    let minPtsRequired = directTrigger.minPtsRequired;

    // Macro OTE bonus (ported from live): entra como evento (pts incluidos en computePoints)
    const activeMacroLeg = selectMacroImpulse(state, currentDirection, eventTf, nowMs);
    const chExtremePriceForMacro = chExtreme ?? state.lastPrice ?? 0;
    if (isInsideMacroOteZone(activeMacroLeg, chOrigin ?? NaN) || isInsideMacroOteZone(activeMacroLeg, chExtremePriceForMacro)) {
      addScoreEvent(activeScore, { id: 'Macro_OTE_Confluence', pts: 6, tf: eventTf, ts: nowMs });
    }

    // Puntaje final (FUENTE ÚNICA computeFinalScore, orden del vivo: espacial → bias → trampa).
    const chLowScore = chOrigin != null && chExtreme != null ? Math.min(chOrigin, chExtreme) : null;
    const chHighScore = chOrigin != null && chExtreme != null ? Math.max(chOrigin, chExtreme) : null;
    const trapZoneCount = (chLowScore !== null && chHighScore !== null) ? state.zones.filter(z =>
      z.dir !== currentDirection && z.top >= chLowScore && z.btm <= chHighScore
    ).length : 0;
    const hasSequentialBacking = activeScore.events.some(e =>
      e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
      e.id.includes('ZoneTouched_') || e.id.includes('OTE_') ||
      (e.id.includes('DIV_') && !e.id.includes('_3')) ||
      (e.id.includes('Sweep_') && !e.id.includes('_3')) ||
      (e.id.includes('TL_Sweep_') && !e.id.includes('_3'))
    );
    const score = computeFinalScore({
      computePointsValue: computePoints(activeScore, nowMs),
      baseBiasPoints,
      hasSpatialBacking,
      spatialBonus,
      hasSequentialBacking,
      isDAgainst,
      is4HAgainst,
      is1HAgainst,
      trapZoneCount,
      isCrypto: ticker.includes('BTC') || ticker.includes('ETH'),
      biasGateStrict: (config as any).biasGateStrict === true,
    });
    const totalPoints = score.totalPoints;
    const biasBlocked = score.biasBlocked;
    if ((config as any).biasGateStrict) console.log(`[BIASGATE-DBG] eval ${ticker} ${currentDirection} 4Hagainst=${is4HAgainst} 1Hagainst=${is1HAgainst}`);

    // Paridad con vivo: el vivo NO aplica scoreMultiplier ni ajuste de umbral por
    // expR de sesión. Estos eran exclusivos del backtest y causaban divergencia.
    // (removido: scoreMultiplier 0.6/0.8/1.3 y nudges de expR +2/+1/-1)

    // Crypto: reduce minPtsRequired by 1 (ported from live)
    const isCryptoTicker = ticker.includes('BTC') || ticker.includes('ETH');
    if (isCryptoTicker) minPtsRequired = Math.max(minPtsRequired - 1, 3);

    // Escalado de umbral removido: la calidad de la señal debe ser constante.
    // Riesgo fijo (anti-martingale eliminado para representatividad vs vivo).

    // Validate leg
    
    // Block moved up

    if (activeLeg) {
      // Paridad con vivo (trading.ts:3573-3585): ids de zona + bypass de score alto.
      const hasZoneConf = activeScore.events.some(e =>
        e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
        e.id.includes('Sweep_') || e.id.includes('DIV_') || e.id.includes('Silver_Bullet_') ||
        e.id.includes('ZoneTouched_') || e.id.includes('TL_Sweep_')
      );
      const highScoreBypass = Math.min(minPtsRequired, 8);
      const efectiveValidation = hasZoneConf || hasSpatialBacking || (totalPoints >= highScoreBypass);
      activeLeg.isValidated = efectiveValidation;
      activeLeg.chochPoints = totalPoints;
      activeLeg.chochEvents = [...activeScore.events.map(e => e.id), `${prefix}_${parseTF(eventTf)}`];
      activeLeg.bestZone = state.zones.filter(z => z.dir === currentDirection).sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

      if (efectiveValidation && triggerEnabled && !biasBlocked && totalPoints >= minPtsRequired) {
        const decimals = getDecimals(ticker);
        let tfSuffix = '15m';
        if (eventTf === '5') tfSuffix = '5m';
        else if (eventTf === '15') tfSuffix = '15m';
        else if (eventTf === '3') tfSuffix = '3m';
        else tfSuffix = parseTF(eventTf).toLowerCase();
        
        const tfKey = prefix === 'EVENTO_CHOCH' ? `choch${tfSuffix}` : `bos${tfSuffix}`;
        const tfConfig = sessionConfig?.[tfKey as keyof typeof sessionConfig] as any;
        const slBuff = tfConfig?.slBuff;
        const activeFixedRR = tfConfig?.tp2 ?? (sessionConfig as any)?.fixedRR ?? (config as any).fixedRR ?? 1.5;
        // Explicit RR zero is not target absence. Reject before price rounding can
        // turn an equal-entry request into a tiny favorable target.
        if (experimental && (!Number.isFinite(Number(activeFixedRR)) || Number(activeFixedRR) <= 0)) return;

        // 🔧 FIX: misma fórmula de SL que el vivo (calculateDynamicSlBuffer + piso getMinPipDistance)
        // Paridad con vivo (trading.ts:3576): slBuff=0 explícito NO cae a session/config.slBufferPercent.
        const rawBuffer = slBuff != null ? slBuff : ((sessionConfig as any)?.slBufferPercent ?? config.slBufferPercent ?? 0.1);
        let slBufferAmt = calculateDynamicSlBuffer(ticker, activeLeg.origin, rawBuffer);
        const minPipDist = getMinPipDistance(ticker);
        if (slBufferAmt < minPipDist) slBufferAmt = minPipDist;
        const adjustedSL = currentDirection === 'BUY'
          ? activeLeg.origin - slBufferAmt
          : activeLeg.origin + slBufferAmt;
        
        const stopLoss = adjustedSL.toFixed(decimals);
        const currentPrice = experimental && modeledQuote ? (currentDirection === 'BUY' ? modeledQuote.ask : modeledQuote.bid) : state.lastPrice ?? activeLeg.extreme;
        const riskDist = Math.abs(currentPrice - adjustedSL);
        const fixedTP1 = currentDirection === 'BUY' 
          ? currentPrice + riskDist 
          : currentPrice - riskDist;
        const tp1 = fixedTP1.toFixed(decimals);
        const fixedTP2 = currentDirection === 'BUY'
          ? currentPrice + (riskDist * activeFixedRR)
          : currentPrice - (riskDist * activeFixedRR);
        let tp2 = fixedTP2.toFixed(decimals);
        const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        let takeChoch = false;
        let disableOte = false;

        let oteSessionEnabled = false;
        if (sessionConfig) {
            const oteTfKeyChoch = `oteChoch${eventTf}m` as keyof typeof sessionConfig;
            const oteTfKeyBos = `oteBos${eventTf}m` as keyof typeof sessionConfig;

            if (prefix === 'EVENTO_CHOCH') {
                const tfConfig = sessionConfig[oteTfKeyChoch] as any;
                if (tfConfig) oteSessionEnabled = tfConfig.enabled ?? false;
                else if ((sessionConfig as any).oteChoch) oteSessionEnabled = (sessionConfig as any).oteChoch.enabled ?? false;
            } else {
                const tfConfig = sessionConfig[oteTfKeyBos] as any;
                if (tfConfig) oteSessionEnabled = tfConfig.enabled ?? false;
                else if ((sessionConfig as any).oteBos) oteSessionEnabled = (sessionConfig as any).oteBos.enabled ?? false;
            }
        } else {
            oteSessionEnabled = (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
        }

        if (experimental && executionPolicy.smart && config.entryTrigger === 'SMART') {
            const decision = routeModeledSmart(activeLeg, state, config, eventTf, nowMs, riskDist, Number(tp2), p.executionObservation);
            takeChoch = decision.takeDirectNow;
            disableOte = decision.takeDirectNow;
        } else if (config.entryTrigger === 'SMART') {
            const signalTfMinutes = (() => {
                const tf = parseTF(eventTf).toUpperCase();
                if (tf === 'D' || tf === '1D') return 1440;
                if (tf === 'W' || tf === '1W') return 10080;
                const val = parseInt(tf);
                if (!isNaN(val)) return tf.includes('H') ? val * 60 : val;
                return 0;
            })();
            const smartHhl = state.htfHighLow?.[eventTf];
            const smart = routeSmartEntry({
                direction: currentDirection as 'BUY' | 'SELL',
                currentSession, totalPoints, minPtsRequired, riskDist, currentPrice,
                signalTfMinutes, decimals, nowMs,
                zones: state.zones, biasTs: state.biasTs, atr14: state.atr14,
                climaxRange: smartHhl ? smartHhl[0] - smartHhl[1] : 0,
                alertLine: entry.line, config,
            });
            takeChoch = smart.takeChoch;
            disableOte = smart.disableOte;
        } else if (config.entryTrigger === 'OTE') {
            takeChoch = false;
            disableOte = false;
        } else if (config.entryTrigger === 'BOTH') {
            takeChoch = true;
            disableOte = !oteSessionEnabled;
        } else {
            // CHOCH Only
            takeChoch = true;
            disableOte = true;
        }

        if (takeChoch) {
            const readableTf = parseTF(eventTf);
            const oteData = {
              tradeId, direction: currentDirection,
              entryPrice: currentPrice,
              stopLoss, tp1, tp2, points: totalPoints, events: [...activeScore.events.map(e => e.id), `${prefix}_${readableTf}`],
              tf: readableTf,
              isChochEntry: true, // paridad con vivo: entrada directa CHoCH/BOS
              execTrigger: tfKey,
              mgmtOverrides: extractMgmtOverrides(tfConfig),
            };
            createTrade(oteData, nowMs, trades, activeTrades, dailyStats, config, state);
            
            // ✅ Cooldown y reset SOLO cuando el trade realmente se dispara (idéntico a live)
            state.lastSniperAlert = nowMs;
            activeScore.events = []; refreshScoreCache(activeScore, nowMs);
            oppositeScore.events = []; refreshScoreCache(oppositeScore, nowMs);
        } else if (!disableOte) {
            // Si va a esperar OTE, reseteamos score y ponemos cooldown, pero dejamos la pata habilitada
            state.lastSniperAlert = nowMs;
            activeScore.events = []; refreshScoreCache(activeScore, nowMs);
            oppositeScore.events = []; refreshScoreCache(oppositeScore, nowMs);
        }

        if (disableOte) activeLeg.oteScored = true;
      }
    }
  }
}

// --- CREATE TRADE ---
function minutesSinceSessionOpen(ts: number): number {
    const d = new Date(ts - 3 * 3600 * 1000);
    const t = d.getUTCHours() * 60 + d.getUTCMinutes();
    const session = getSessionForTimestamp(ts);
    const openMin = session === 'LONDON' ? 240 : session === 'NY' ? 630 : session === 'ASIA' ? 1260 : -1;
    if (openMin < 0) return Infinity;
    let m = t - openMin; if (m < 0) m += 1440;
    return m;
}

function createTrade(oteData: any, nowMs: number, trades: BacktestTrade[], activeTrades: Map<string, BacktestTrade>, dailyStats: DailyStats, config: BacktestConfig, state: any) {
  const executionPolicy = resolveExecutionPolicy(config.executionPolicy);
  const experimental = executionPolicy.profile === 'microstructure_v1';
  let requestedTp2Price: number | undefined;
  let overriddenTp2Price: number | undefined;
  const currentQuote: ExecutionQuote | undefined = state.executionContext?.quote;
  const fillQuote = experimental && currentQuote?.source === 'modeled' && currentQuote.timestampMs === nowMs ? currentQuote : undefined;
  if (experimental) {
    // This boundary covers direct CHOCH/BOS, late validation and Alpha OTE alike.
    // SMART is a routing ablation, never permission to bypass causal market data.
    const tf = oteData.executionTf ?? ({ '5M': '5', '15M': '15', '1H': '60', '4H': '240', '1D': 'D', '1W': 'W' } as Record<string, string>)[String(oteData.tf).toUpperCase()] ?? oteData.tf;
    const setup = tf ? getExecutionSnapshot(state, tf, nowMs) : undefined;
    if (!setup?.bar || !setup.closedBar?.closed || !Number.isFinite(setup.atr14) || !(setup.atr14! > 0)
        || setup.ticker !== config.ticker || setup.bar.tf !== setup.tf || setup.closedBar.tf !== setup.tf
        || !fillQuote || setup.quote?.source !== 'modeled' || setup.quote.timestampMs !== nowMs
        || !validateExecutionInstrument(config.executionInstrument) || config.executionInstrument.source !== 'explicit_model'
        || config.executionInstrument.ticker !== config.ticker) {
      console.warn(`[EXECUTION_BT] WAIT_DATA MISSING_CAUSAL_EXECUTION_CONTEXT_OR_INSTRUMENT at ${nowMs}`);
      return;
    }
    oteData = { ...oteData, entryPrice: oteData.direction === 'BUY' ? fillQuote.ask : fillQuote.bid };
    const sl = Number(oteData.stopLoss ?? oteData.slPrice);
    if (!Number.isFinite(sl) || sl <= 0 || (oteData.direction === 'BUY' ? sl >= oteData.entryPrice : sl <= oteData.entryPrice)) return;
    // Undefined alone means absent: explicit NaN/Infinity/zero must not become a default target.
    const rawTp2 = oteData.tp2 !== undefined ? oteData.tp2 : oteData.tp2Price;
    requestedTp2Price = rawTp2 === undefined ? undefined : Number(rawTp2);
    if (requestedTp2Price !== undefined && (!Number.isFinite(requestedTp2Price) || requestedTp2Price <= 0
        || (oteData.direction === 'BUY' ? requestedTp2Price <= oteData.entryPrice : requestedTp2Price >= oteData.entryPrice))) return;
  }
  // 🆕 PARIDAD (sep-2026): gates direccionales del vivo, portados con su semántica exacta.
  // El vivo los chequea ANTES de ejecutar (trading.ts: BLOCKED_SELL_LIMIT / BUY_LIMIT /
  // MCL_LIMIT). maxSells/maxBuysPerDay cuentan ENTRADAS de hoy por dirección;
  // maxBuyLosses/maxSellLosses por sesión cuentan la racha de pérdidas direccional.
  const dir = oteData.direction === 'BUY' ? 'BUY' : 'SELL';
  if (dir === 'BUY' && (config as any).maxBuysPerDay > 0 && dailyStats.dailyBuys >= (config as any).maxBuysPerDay) {
    return; // BUY bloqueado por tope diario de BUYs (paridad con vivo)
  }
  if (dir === 'SELL' && (config as any).maxSellsPerDay > 0 && dailyStats.dailySells >= (config as any).maxSellsPerDay) {
    return; // SELL bloqueado por tope diario de SELLs (paridad con vivo)
  }
  const sessKey = dailyStats.currentSessionStr.split('-').pop() ?? '';
  // 🛡️ Paridad exacta con el vivo: el check MCL de trading.ts usa SOLO
  // sessions[currentSession] (SIN fallback a ALL — ALL.maxBuyLosses es config muerta
  // en el vivo, no debe cobrar vida en el backtest).
  const sessCfg = sessKey ? ((config as any).sessions ?? {})[sessKey] : undefined;
  if (sessCfg) {
    const mcl = dir === 'BUY' ? sessCfg.maxBuyLosses : sessCfg.maxSellLosses;
    const streak = dir === 'BUY' ? dailyStats.sessionBuyLossStreak : dailyStats.sessionSellLossStreak;
    if (typeof mcl === 'number' && mcl > 0 && streak >= mcl) {
      return; // MCL direccional de sesión alcanzado (paridad con vivo)
    }
  }

  // Same per-symbol pause/DST calendar as live. Preserve the existing explicit
  // A/B flag: candle/event history cannot establish fresh Bid/Ask normalization.
  // This gate tests only the minimum calendar blackout, never a live spread thaw.
  if ((config as any).rolloverEntryBlock) {
    if (getRolloverCalendar(config.ticker, nowMs).entryWindow) return;
  }
  // ═══ TIMESFM FILTER (F1) — espejo del gate en dispatchOteSignal (src/db/trading.ts) ═══
  // Ubicado al inicio para que el modo collect registre TODOS los candles con trigger.
  const tfmRaw = (config as any).timesfm;
  if (tfmRaw && (tfmRaw.enabled || tfmRaw.collectOnly)) {
    const tfmCfg = resolveTimesfmConfig(tfmRaw);
    const tfMin = parseInt(String(oteData.tf || '15').replace(/\D/g, '')) || 15;
    const candleKey = timesfmCandleKey(nowMs, tfMin);
    if (tfmCfg.collectOnly) {
      appendTimesfmAudit(tfmCfg.collectPath, { ts: candleKey, ticker: config.ticker, tf: tfMin });
    } else {
      const fc = timesfmForecastAt ? timesfmForecastAt(nowMs, tfMin) : timesfmForecastCache?.get(candleKey);
      const atr = state.atr14 ?? 0;
      let decision: TimesfmDecision;
      if (!fc) {
        decision = { action: 'APPROVE', riskMult: 1.0, forecastDir: 'FLAT', highConviction: false, spreadAtr: 0, forecastMedian: 0, reason: 'DEGRADADO: sin forecast cacheado para esta vela', degraded: true };
      } else if (atr <= 0) {
        decision = { action: 'APPROVE', riskMult: 1.0, forecastDir: 'FLAT', highConviction: false, spreadAtr: 0, forecastMedian: 0, reason: 'DEGRADADO: ATR aún no inicializado', degraded: true };
      } else {
        decision = evaluateTimesfmFilter(fc, oteData.direction, oteData.entryPrice, atr, oteData.points, tfmCfg);
      }
      const auditRec: Record<string, unknown> = {
        ts: candleKey, nowMs, ticker: config.ticker, direction: oteData.direction,
        points: oteData.points, action: decision.action, riskMult: decision.riskMult,
        forecastDir: decision.forecastDir, spreadAtr: +decision.spreadAtr.toFixed(4),
        reason: decision.reason, degraded: decision.degraded, dryRun: tfmCfg.dryRun === true,
        tp2Dynamic: false,
      };
      if (tfmCfg.dryRun) {
        // F2 shadow: auditar sin aplicar — no bloquear ni tocar riskMult
      } else if (decision.action === 'REJECT') {
        appendTimesfmAudit(tfmCfg.auditPath, auditRec);
        return; // trade bloqueado por TimesFM
      } else {
        oteData.riskMult = decision.riskMult;
        oteData.timesfmAction = decision.action;
        oteData.timesfmDir = decision.forecastDir;
        oteData.timesfmSpreadAtr = +decision.spreadAtr.toFixed(4);
        // Fase C: TP2 dinámico por q90 (SL sigue estructural/slBuff por diseño).
        if (tfmCfg.tp2Dynamic === 'q90' && fc && !decision.degraded) {
          const dyn = resolveTp2FromForecast(fc, oteData.direction as 'BUY' | 'SELL', oteData.entryPrice, tfmCfg.tp2Q90Step ?? 2);
          if (dyn !== null) {
            oteData.tp2 = String(dyn);
            if (experimental) requestedTp2Price = dyn;
            oteData.tp2DynamicSource = 'q90';
            auditRec.tp2Dynamic = true;
            auditRec.tp2Price = dyn;
          }
        }
      }
      appendTimesfmAudit(tfmCfg.auditPath, auditRec);
    }
  }

  if (dailyStats.isKilled) return;
  if (nowMs < dailyStats.streakKillswitchUntil) return;

  const riskMult = oteData.riskMult ?? 1.0; // TimesFM F1 pudo haberlo ajustado arriba; default 1.0 (anti-martingale eliminado)
  oteData.riskMult = riskMult;

  const currentSession = getSessionForTimestamp(nowMs);
  if (config.sessionFilter && config.sessionFilter.length > 0) {
      if (!config.sessionFilter.includes(currentSession)) return;
  }

  const warmupMin = (config as any).sessionWarmupMin ?? 15;
  if ((currentSession === 'LONDON' || currentSession === 'NY') && minutesSinceSessionOpen(nowMs) < warmupMin) return;

  if (config.maxTradesPerSession && dailyStats.sessionTradeCount >= config.maxTradesPerSession) {
      return;
  }

  if (!config.disableNewsBlackout && isNewsBlackout(nowMs)) return;

  // (c) Guardia al crear el trade + eliminar defaults mágicos
  // El path de gatillo directo pasa `stopLoss` (string); el path OTE pasa `slPrice` (number)
  const guardSl = parseFloat(oteData.stopLoss ?? oteData.slPrice);
  if (!isFinite(guardSl) || guardSl === oteData.entryPrice) return;

  if (experimental) {
    // TimesFM may have replaced the request after the entry boundary. Validate the
    // actual requested target again, before caps or any reversal side effects.
    const sign = oteData.direction === 'BUY' ? 1 : -1;
    if (requestedTp2Price !== undefined && (!Number.isFinite(requestedTp2Price) || requestedTp2Price <= 0
        || sign * (requestedTp2Price - oteData.entryPrice) <= 0)) return;
    // With targets ablated this RR override is effective later, before the recap.
    // Validate its source and resulting geometry now; never let abs() repair it.
    if (!executionPolicy.targets && (config as any).tp2RR != null) {
      const rr = Number((config as any).tp2RR);
      const computedOverrideTp2 = oteData.entryPrice + sign * Math.abs(guardSl - oteData.entryPrice) * rr;
      if (!Number.isFinite(rr) || rr <= 0 || !Number.isFinite(computedOverrideTp2) || computedOverrideTp2 <= 0
          || sign * (computedOverrideTp2 - oteData.entryPrice) <= 0) return;
      overriddenTp2Price = computedOverrideTp2;
    }
  }

  // 🛡️ ANTI-PYRAMIDACIÓN & SAR
  let commitReversal: (() => boolean) | undefined;
  let existingTradeForTicker: BacktestTrade | undefined;
  for (const t of activeTrades.values()) {
    existingTradeForTicker = t;
    break; // En standalone backtester asumimos 1 ticker (el config.ticker actual)
  }

  if (existingTradeForTicker) {
    if (existingTradeForTicker.direction === oteData.direction) {
      return; // Bloqueo de piramidación
    } else {
      if (oteData.points > existingTradeForTicker.points) {
        // Eligibility is unchanged. Experimental candidates must finish all entry
        // validation/preparation before consuming the existing position; legacy
        // still commits here, including its historical later-rejection behavior.
        const reversalCandidate = existingTradeForTicker;
        commitReversal = () => {
          const existingTradeForTicker = reversalCandidate;
          if (existingTradeForTicker.executionPolicy?.profile === 'microstructure_v1') {
            const ledger = (existingTradeForTicker as ModeledTrade).executionBacktest!;
            const quote = modeledExecutionQuote({ ...config, spreadPips: (ledger.fillQuote.ask - ledger.fillQuote.bid) / existingTradeForTicker.executionInstrument!.pipSize }, state.lastPrice, nowMs, existingTradeForTicker.executionInstrument);
            if (!quote) return false;
            closeModeledTrade(existingTradeForTicker, existingTradeForTicker.direction === 'BUY' ? quote.bid : quote.ask, nowMs, 'REVERSAL');
          } else {
          // Ejecutar SAR (Reversión)
          const currentPrice = state.lastPrice ?? existingTradeForTicker.entryPrice;
          const originalSl = existingTradeForTicker.originalSlPrice ?? existingTradeForTicker.slPrice;
          const slDist = Math.abs(originalSl - existingTradeForTicker.entryPrice);
          const pnlDist = existingTradeForTicker.direction === 'BUY'
            ? currentPrice - existingTradeForTicker.entryPrice
            : existingTradeForTicker.entryPrice - currentPrice;

          const pipSize = getPipValue(config.ticker, currentPrice);
          const riskPips = slDist / pipSize;
          const cls = getAssetClass(config.ticker);
          const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
          const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker, currentPrice)) : 0;

          const sarMgmt = resolveBacktestMgmt(existingTradeForTicker, config);
          const partialPct = sarMgmt.partialPct;
          const remainderPct = sarMgmt.remainderPct;
          const lockedPct = existingTradeForTicker.tp1Hit ? Math.abs(existingTradeForTicker.tp1Price - existingTradeForTicker.entryPrice) / existingTradeForTicker.entryPrice * 100 * partialPct : 0;
          const openPct = (pnlDist / existingTradeForTicker.entryPrice) * 100 * (existingTradeForTicker.tp1Hit ? remainderPct : 1.0);
          const slPct = (slDist / existingTradeForTicker.entryPrice) * 100;

          existingTradeForTicker.pnl = lockedPct + openPct;
          existingTradeForTicker.rMultiple = slPct > 0 ? ((lockedPct + openPct) / slPct - transactionCostR) * (existingTradeForTicker.riskMult || 1.0) : 0;
          existingTradeForTicker.result = existingTradeForTicker.rMultiple > 0 ? 'WIN' : existingTradeForTicker.rMultiple === 0 ? 'BE' : 'LOSS';

          existingTradeForTicker.resultTp2 = 'REVERSAL';
          if (!existingTradeForTicker.tp1Hit) existingTradeForTicker.resultTp1 = 'REVERSAL';
          existingTradeForTicker.closeTimestamp = nowMs;
          existingTradeForTicker.durationMin = Math.round((nowMs - existingTradeForTicker.timestamp) / 60000);
          }
          activeTrades.delete(existingTradeForTicker.id);
          updateDailyStatsFromClose(existingTradeForTicker, dailyStats, config);
          return true;
        };
        if (!experimental && !commitReversal()) return;
      } else {
        return; // Contra-tendencia más débil, ignorar entrada
      }
    }
  }

  let trade: BacktestTrade = {
    id: oteData.tradeId || (oteData.id),
    timestamp: nowMs,
    direction: oteData.direction,
    entryPrice: oteData.entryPrice,
    tp1Price: parseFloat(oteData.tp1 || oteData.tp1Price),
    tp2Price: experimental && executionPolicy.targets ? requestedTp2Price ?? 0 : capTp2Price(config.ticker, oteData.direction, oteData.entryPrice, parseFloat(oteData.stopLoss || oteData.slPrice), parseFloat(oteData.tp2 || oteData.tp2Price) || 0),
    slPrice: parseFloat(oteData.stopLoss || oteData.slPrice),
    originalSlPrice: parseFloat(oteData.stopLoss || oteData.slPrice),
    points: oteData.points,
    events: oteData.events || [],
    grade: oteData.points >= 8 ? 'A+' : 'B',
    oteEntryUsed: oteData.oteEntryUsed,
    isChochEntry: oteData.isChochEntry === true ? true : false,
    // 🆕 sep-2026: gatillo real que ejecutó el trade (etiquetado honesto por gatillo)
    execTrigger: (oteData as any).execTrigger,
    tf: oteData.tf,
    riskMult: oteData.riskMult,
    timesfmAction: oteData.timesfmAction,
    timesfmDir: oteData.timesfmDir,
    timesfmSpreadAtr: oteData.timesfmSpreadAtr,
  };

  // 🧪 A/B de gestión (sep-2026): overrides de TP en R desde la config del backtest.
  // tp1RR / tp2RR re-calculan los TP como entry ± riskDist × RR (sin tocar AlphaModel vivo).
  // Default undefined = comportamiento actual (TPs del oteData).
  if (!(experimental && executionPolicy.targets) && ((config as any).tp1RR != null || (config as any).tp2RR != null)) {
    const riskDist = Math.abs(trade.slPrice - trade.entryPrice);
    if (riskDist > 0) {
      if ((config as any).tp1RR != null) {
        trade.tp1Price = trade.direction === 'BUY'
          ? trade.entryPrice + riskDist * (config as any).tp1RR
          : trade.entryPrice - riskDist * (config as any).tp1RR;
      }
      if ((config as any).tp2RR != null) {
        trade.tp2Price = experimental ? overriddenTp2Price! : trade.direction === 'BUY'
          ? trade.entryPrice + riskDist * (config as any).tp2RR
          : trade.entryPrice - riskDist * (config as any).tp2RR;
      }
    }
  }

  // 🛡️ Techo de TP2 de producción (sep-2026): aplica SIEMPRE, incluso sobre overrides tp2RR.
  if (!(experimental && executionPolicy.targets)) trade.tp2Price = capTp2Price(config.ticker, trade.direction, trade.entryPrice, trade.slPrice, trade.tp2Price);
  if (experimental && executionPolicy.targets) {
    const targets = computeExecutionTargets({ direction: trade.direction, entryPrice: trade.entryPrice,
      initialSlPrice: trade.slPrice, adr: getAdrPrice(config.ticker), regime: config.executionInstrument!.regime,
      structuralTp1Price: oteData.structuralTp1Price, requestedTp2Price });
    if (!targets.valid) return;
    trade.tp1Price = targets.tp1Price;
    trade.tp2Price = targets.tp2Price;
    oteData.executionPartialClosePct = targets.partialClosePct;
  }

  // 🛡️ ML F2: congelar las 12 features REALES del estado al momento de la entrada.
  // Usa exactamente extractFeatures de MLFilter.ts (la misma que evalúa el runtime),
  // para que train_ml_model.py entrene con features idénticas a las de producción
  // (reemplaza el POC anterior que generaba features sintéticas con random()).
  try {
    // Mapear el tf legible del trade ("5M","15M","1H","4H","D") a la clave que espera
    // extractFeatures/MLFilter ('5','15','60','240','240'). Los gatillos reales son 5m/15m.
    const tfReadable = (trade.tf || '15M').toUpperCase();
    let tfKey = '15';
    if (tfReadable === 'D') tfKey = '240';
    else if (tfReadable === '4H') tfKey = '240';
    else if (tfReadable === '1H') tfKey = '60';
    else tfKey = tfReadable.replace(/[^0-9]/g, '') || '15';
    const scoreKey = trade.direction === 'BUY' ? state.scoreBuy : state.scoreSell;
    const scorePts = scoreKey ? computePoints(scoreKey, nowMs) : 0;
    trade.mlFeatures = extractFeatures(
      state as any, trade.direction, nowMs,
      trade.points,      // chochPoints
      scorePts,          // scorePoints
      tfKey,             // tf
    ) as any;

    // 🛡️ ML F3 (sep-2026): gate ML idéntico al vivo (AlphaModel.ts:357-359) — walk-forward.
    // Solo aplica a trades posteriores al entrenamiento del modelo (trainedAt = mtime):
    // el modelo de la semana pasada evalúa la semana nueva, nunca su propio período de train.
    // Sin modelo o sin mlGate → comportamiento legacy (todo aprobado).
    // ���� PARIDAD 16-sep-2026: el gate del VIVO se extendió a TODOS los gatillos (directas
    // incluidas, ML GATE EXTENDIDO en trading.ts — OTE las veta AlphaModel, las directas el
    // dispatch). El motor gatea ahora TODAS las entradas (antes solo OTE_Retracement) para
    // que el sweep/hyperopt midan lo mismo que el vivo.
    if (_mlCtx?.cfg?.enabled && nowMs > (_mlCtx.cfg.trainedAt ?? 0)) {
      try {
        const mlPred = mlPredict(state as any, trade.direction, nowMs, trade.points, scorePts, tfKey, config.ticker);
        if (mlPred && !mlPred.approved) {
          _mlCtx.rejected++;
          return; // el filtro ML lo rechaza — mismo comportamiento que el vivo (solo OTE)
        }
      } catch (gateErr: any) {
        console.warn(`[ML-GATE] ⚠️ gate error: ${gateErr.message}`);
      }
    }
  } catch (e: any) {
    // No dejar que la captura de features rompa el backtest.
    console.warn(`[ML] ⚠️ No se pudieron congelar features del trade ${trade.id}: ${e.message}`);
  }

  if ((oteData as any).mgmtOverrides) (trade as any).mgmtOverrides = (oteData as any).mgmtOverrides;

  // Clasificar triggerType al crear el trade (único punto de verdad)
  const resolvedTrig = resolveTradeTriggerKey(trade);
  if (resolvedTrig) trade.triggerType = resolvedTrig;

  // --- FRICTION MODEL INTERCEPTION ---
  if (experimental) {
    const instrument = Object.freeze(structuredClone(config.executionInstrument!));
    const tf = (trade.tf ?? '15').replace(/[^0-9]/g, '') || '15';
    const family = trade.triggerType ?? `choch${tf}m`;
    const mgmt = structuredClone((config.sessions as any)?.[currentSession]?.[family] ?? oteData.mgmtOverrides ?? {});
    const rawPct = oteData.executionPartialClosePct ?? mgmt.partialClosePct ?? 0;
    const partialPct = rawPct > 1 ? rawPct / 100 : rawPct;
    const commission = config.commissionPerLot ?? instrument.commissionPerLotSideUsd;
    if (!Number.isFinite(partialPct) || partialPct < 0 || partialPct >= 1 || !Number.isFinite(commission) || commission < 0) return;
    trade.executionPolicy = Object.freeze({ ...executionPolicy });
    trade.executionInstrument = instrument;
    trade.initialSlPrice = trade.slPrice;
    trade.originalSlPrice = trade.slPrice;
    trade.executionState = createExecutionPositionState({ direction: trade.direction, entryPrice: trade.entryPrice,
      initialSlPrice: trade.slPrice, entryTimestampMs: nowMs });
    (trade as ModeledTrade).executionBacktest = {
      fillSource: 'MODELED', fillQuote: { ...fillQuote! }, managementOverrides: Object.freeze(mgmt),
      partialClosePct: partialPct, remainingFraction: 1, realizedPriceDist: 0,
      paidCommissionPrice: commission / instrument.pipValuePerLotUsd * instrument.pipSize,
      exitCommissionPerLotUsd: commission, maxHoldMin: config.maxHoldMin,
      minimalRoi: config.minimal_roi ? Object.freeze({ ...config.minimal_roi }) : undefined,
      lastProcessedMs: nowMs,
    };
    trade.events = [...trade.events, 'EXECUTION_microstructure_v1_MODELED'];
  } else {
  const clsFriction = getAssetClass(config.ticker);
  const customFriction = {
    baseSpreadPips: config.spreadPips !== undefined ? config.spreadPips : defaultFrictionConfig[clsFriction].baseSpreadPips,
    commissionPerLot: config.commissionPerLot !== undefined ? config.commissionPerLot : defaultFrictionConfig[clsFriction].commissionPerLot,
    latencyMs: 50,
    // 🛡️ sep-2026: pico rollover 20:29-21:00 UTC. undefined → default 19 en FrictionModel; 0 = off (A/B).
    rolloverPeakPips: config.rolloverPeakPips,
  };
  const activeLike = {
    tradeId: trade.id,
    ticker: config.ticker,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    tp1Price: trade.tp1Price,
    tp2Price: trade.tp2Price,
    slPrice: trade.slPrice,
    tp1Hit: false,
    tp2Hit: false,
    score: trade.points,
    timestamp: trade.timestamp,
  } as any; // Still cast as any since ActiveTrade is in backend types, but matches shape perfectly
  const frictionResult = evaluateNetTrade(activeLike, nowMs, customFriction);
  if (!frictionResult.approved) {
    // Si la fricción lo rechaza (ej. spread mayor al 40% del SL, o RR Neto < 0.2)
    // console.log('REJECTED BY FRICTION:', frictionResult.reason);
    return;
  }
  
  // Re-asignamos los precios que pudieron ser alterados por el spread/slippage
  trade.entryPrice = frictionResult.netTrade.entryPrice;
  trade.tp1Price = frictionResult.netTrade.tp1Price;
  trade.tp2Price = frictionResult.netTrade.tp2Price;
  trade.slPrice = frictionResult.netTrade.slPrice;
  }

  // All experimental target/ML/cost checks and execution-state construction are
  // complete. A failed SAR quote cannot create a new entry either.
  if (experimental && commitReversal && !commitReversal()) return;
  if (config.rolloverPolicy?.profile === 'rollover_triage_v1') {
    trade.initialSlPrice = trade.slPrice;
    trade.rolloverInitialRiskPrice = Math.abs(trade.entryPrice-trade.slPrice);
  }

  // 🆕 PARIDAD (sep-2026): sesión de ENTRADA del trade (para la racha direccional) + conteo diario.
  (trade as any).btSession = dailyStats.currentSessionStr;
  if (dir === 'BUY') dailyStats.dailyBuys++;
  else dailyStats.dailySells++;

  if (config.mlRegimeShadow === true) {
    const tf = ({'5M':'5','15M':'15','1H':'60','4H':'240','D':'D'} as Record<string,string>)[String(trade.tf).toUpperCase()] ?? String(trade.tf ?? '15');
    const sidecar = config.mlRegimeContexts?.[`${config.ticker}:${tf}:${trade.direction}:${nowMs}`];
    // Preserve every source timestamp; reject mismatched identities instead of retiming data.
    const valid = sidecar && sidecar.ticker === config.ticker && sidecar.tf === tf && sidecar.direction === trade.direction && sidecar.nowMs === nowMs;
    const family = trade.triggerType ?? `choch${tf}m`;
    const minimum = (config.sessions?.[currentSession] as any)?.[family]?.minScore ?? (trade.direction === 'BUY' ? config.minBuyPoints : config.minSellPoints);
    const bound = valid && sidecar.entry?.value.entryPrice === trade.entryPrice && sidecar.entry?.value.initialSL === trade.slPrice
      && sidecar.score?.value.points === trade.points && sidecar.score?.value.minRequired === minimum;
    trade.mlRegimeShadow = predictRegime(bound ? structuredClone(sidecar) : {schema:REGIME_FEATURE_SCHEMA,ticker:config.ticker,tf,direction:trade.direction,nowMs});
  }
  trades.push(trade);
  activeTrades.set(trade.id, trade);

  dailyStats.tradeCount++;
  dailyStats.sessionTradeCount++;

  if (config.maxTradesPerDay && dailyStats.tradeCount >= config.maxTradesPerDay) {
    dailyStats.isKilled = true;
  }
}

export function isNewsBlackout(ts: number): boolean {
  const d = new Date(ts);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  const inW = (a: number, b: number) => t >= a && t <= b;
  const usData = inW(12 * 60 + 25, 14 * 60 + 10);
  const fomc = inW(17 * 60 + 55, 18 * 60 + 15) || inW(18 * 60 + 55, 19 * 60 + 15);
  return usData || fomc;
}