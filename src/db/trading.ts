import { db } from './memory.js';
import { bot } from '../bot/telegram.js';
import { config, config as envConfig } from '../config.js';
import { logTrade, recordResult, sendDailyReview } from '../services/journal.js';
import * as rolloverBroker from '../services/ctrader.js';
import { runRolloverTriageExecution } from '../engine/RolloverTriageExecutor.js';
import { setRolloverLiveFillObserver } from '../engine/RolloverLiveFillRegistry.js';
import { getLastBidAsk, getRolloverQuote, syncScannerRoster, getLiveExecutionInstrument } from '../services/ctrader.js';
import * as fs from 'fs';

import { z } from 'zod';
import { RadarZone, ImpulseLeg, RadarState, ActiveTrade, AssetSessionConfigSchema, GlobalPortfolioConfig, SessionSchema, extractMgmtOverrides, DEFAULT_BIAS_CONFLUENCE, BiasConfluenceConfig } from '../engine/Types.js';

type SessionConfig = z.infer<typeof SessionSchema>;
import { StateStore, createStateStore } from '../engine/StateStore.js';

export const globalState = createStateStore();



import {
    emptyState, normalizeZone, TF_WEIGHT, evaluateImpulseCore, getDecimals, getMinPipDistance, calculateDynamicSlBuffer, evaluateMacroStretching, isInsideMacroOteZone,
    gcScore, addScoreEvent, computePoints, structuralInvalidate, refreshScoreCache, TF_RANK
} from '../engine/AlphaModel.js';

import { freezeTradeRiskForTrade, resolveTradeCloseAccounting, type TradeRiskSnapshot, type ClosedTradeAccounting } from '../engine/TradeRisk.js';
import { commitTradeCloseAccounting } from '../engine/TradeAccountingPersistence.js';
import { buildExecutionNotice } from '../engine/ExecutionNotice.js';
import { evaluateNetTrade, getPipValue, getAssetClass, defaultFrictionConfig } from '../engine/FrictionModel.js';
import { capTp2Price, getAdrPrice } from '../engine/tp2Cap.js';
import type { ExecutionPolicyInput, ExecutionPolicy, ExecutionInstrument, ExecutionQuote, ExecutionMarketSnapshot, ExecutionCostInput, ExecutionPositionState } from '../engine/ExecutionTypes.js';
import { resolveExecutionPolicy, evaluateSmartEntryRouting, createExecutionPositionState, advanceExecutionPositionState, evaluateDynamicBreakeven, computeMultiAssetTrailingSl, computeExecutionTargets, REGIME_PROFILES } from '../engine/ExecutionMicrostructure.js';
import { validateExecutionInstrument, estimatePendingExecutionCosts, validateExecutionStop } from '../engine/ExecutionCosts.js';
import { parseExecutionEnvelope, ingestExecutionContext, getExecutionSnapshot } from '../engine/ExecutionContext.js';
import { setMLGateOverride } from '../engine/MLFilter.js';
import { predictRegime, regimeUnavailable, REGIME_FEATURE_SCHEMA, REGIME_VELOCITY_PROFILE, type RegimeContextInput } from '../engine/MLRegimeFeatures.js';
import { resolveTimesfmConfig, appendTimesfmAudit, resolveTp2FromForecast, type TimesfmDecision, type TimesfmFilterConfig } from '../engine/TimesfmFilter.js';
import { fetchLiveTimesfmDecision, configureTimesfmLiveCache, resetTimesfmLiveCache } from '../engine/TimesfmLiveCacheNode.js';
import { buildRolloverSignalContext, type RolloverRuntimePolicy } from '../engine/RolloverRuntimeContext.js';
import { shouldFreezeRolloverObservation } from '../engine/RolloverTriagePolicy.js';
import { evaluateCorrelationGate, resolveCorrelationConfig, appendCorrelationAudit, syncCorrTickers } from '../services/correlation.js';

import { tickFlow } from '../engine/TickFlow.js';
import { getRolloverCalendar, evaluateRolloverEntryGate, isSpreadNormalized } from '../engine/RolloverSpreadGate.js';
import { getRolloverAssetClass, getRolloverSpreadReference } from '../engine/RolloverSpreadReference.js';
import { telemetry } from '../services/telemetry.js';

import {
    hasPendingExecutionIncident, invalidateRiskCache, evaluateGlobalRisk, evaluateAssetRisk, getFxDayStartMs, countDailySellsForTicker as pmCountDailySells, countDailyBuysForTicker as pmCountDailyBuys, countConsecutiveLossesForAsset
} from '../engine/PortfolioModel.js';

// 🏥 Export para healthcheck


// 🔄 v7.0: Firestore Write Buffers (Debouncing & Batching)
const dirtyStates = new Map<string, RadarState>();
let stateFlushTimeout: NodeJS.Timeout | null = null;

// 🆕 Radar v2: último veredicto TimesFM por ticker (para el dashboard, sin Firestore)
const lastTfmByTicker = new Map<string, { action: string; riskMult: number; degraded: boolean; dryRun: boolean; ts: number }>();

// 🛡️ Dedupe de journal: un gatillo puede llegar dos veces en <1s (2 eventos SMC del
// mismo quiebre) y cada dispatch creaba un doc → trades duplicados en la bitácora.
const journalDedupe = new Map<string, number>();

/** Capture only the exact, verified NEW broker position. Never call during adoption. */
export function captureRolloverVerifiedFill(trade: ActiveTrade, position: any, policy: RolloverRuntimePolicy | undefined, nowMs: number): boolean {
    if (trade.rolloverFill || trade.isBacktest || !trade.ctraderPositionId || String(position?.positionId) !== trade.ctraderPositionId) return false;
    const td = position.tradeData;
    const side = td?.tradeSide ?? td?.direction;
    const direction = side === 1 || side === 'BUY' ? 'BUY' : side === 2 || side === 'SELL' ? 'SELL' : null;
    const entryPrice = Number(td?.openPrice ?? position.price), initialSlPrice = Number(position.stopLoss);
    const openedAtMs = Number(td?.openTimestamp), volume = Number(td?.volume);
    const initialRiskPrice = (trade.direction === 'BUY' ? 1 : -1) * (entryPrice - initialSlPrice);
    if (direction !== trade.direction || ![entryPrice,initialSlPrice,initialRiskPrice,openedAtMs,volume].every(v => Number.isFinite(v) && v > 0)
        || !Number.isFinite(nowMs) || openedAtMs > nowMs) return false;
    trade.rolloverFill = { schema: 1, positionId: trade.ctraderPositionId, positionKey: `${trade.ctraderPositionId}:${openedAtMs}`,
        ticker: trade.ticker, direction: trade.direction, openedAtMs, capturedAtMs: nowMs, entryPrice, initialSlPrice, initialRiskPrice,
        policy: structuredClone(policy ?? { profile: 'legacy' }) };
    return true;
}

/** Shared broker success boundary: automatic AND confirmation-button orders. */
async function handleVerifiedRolloverFill(event: import('../engine/RolloverLiveFillRegistry.js').RolloverVerifiedFillEvent): Promise<void> {
    const trade = globalState.activeTrades.get(event.tradeId);
    const policy = structuredClone(getConfigForTicker(event.ticker,event.nowMs).rolloverPolicy);
    if (!trade || trade.isBacktest || trade.rolloverFill || trade.ticker !== event.ticker || (trade as any).adopted
        || policy?.profile !== 'rollover_triage_v1' || (trade.ctraderPositionId && trade.ctraderPositionId !== event.positionId)) return;
    trade.ctraderPositionId = event.positionId;
    try {
        const position = await event.readPosition();
        if (!captureRolloverVerifiedFill(trade,position,policy,event.nowMs)) return;
        trade.rolloverTriageState = {pending:null,widenReference:null};
        trade.rolloverTriageTracked = true;
        trade.rolloverTriageDurable = false;
        rolloverTriageRecords.set(event.tradeId,trade);
        await persistLiveRolloverRecord(event.tradeId,trade,undefined,'FILL');
    } catch (error: any) {
        trade.rolloverTriageDurable = false;
        console.error('[ROLLOVER] Verified fill storage unavailable; no new mutation until durable retry:',error.message);
    }
}
setRolloverLiveFillObserver(handleVerifiedRolloverFill);

/** Called only after an acknowledged NEW fill, never by hydration/adoption. */
export function freezeExecutionFill(trade: ActiveTrade, input: { policy: ExecutionPolicy; instrument?: ExecutionInstrument; executedPrice?: number; filledAtMs: number; lots?: number; quote?: ExecutionQuote }): boolean {
    if (trade.executionState || input.policy.profile !== 'microstructure_v1' || !validateExecutionInstrument(input.instrument)
        || input.instrument.ticker !== trade.ticker || !(input.executedPrice! > 0) || !Number.isFinite(input.executedPrice)
        || !(input.lots! > 0) || !Number.isFinite(input.lots) || !(trade.initialSlPrice! > 0)) return false;
    const q = input.quote;
    if (!q || q.source !== 'broker' || ![q.bid,q.ask,q.timestampMs].every(Number.isFinite) || !(q.bid > 0 && q.ask >= q.bid) || input.filledAtMs < q.timestampMs || input.filledAtMs - q.timestampMs > 10000) return false;
    try {
        const state = createExecutionPositionState({ direction: trade.direction, entryPrice: input.executedPrice!, initialSlPrice: trade.initialSlPrice!, entryTimestampMs: input.filledAtMs });
        trade.entryPrice = input.executedPrice!;
        trade.executionPolicy = { ...input.policy };
        trade.executionInstrument = { ...input.instrument };
        trade.executionState = state;
        (trade as any).executionLots = input.lots;
        return true;
    } catch { return false; }
}

/** Real setup adapter: the break and Wilder ATR must have the same closed-bar vintage. */
export function routeExecutionSetup(state: RadarState, leg: ImpulseLeg, config: any, tf: string, nowMs: number, currentPrice: number, initialSlPrice: number, requestedTp2Price: number) {
    const snapshot = getExecutionSnapshot(state, tf, nowMs);
    const waiting = (reason: string) => ({ mode: 'WAIT_DATA' as const, takeDirectNow: false, requiresCloseConfirmation: false, reason });
    let decision;
    if (!leg.executionSnapshot?.breakBar || !leg.executionSnapshot.impulse || !snapshot?.breakBar || !snapshot.closedBar
        || leg.executionSnapshot.impulse.createdAtMs !== snapshot.impulse?.createdAtMs
        || leg.executionSnapshot.breakBar.openTimeMs !== snapshot.breakBar.openTimeMs || snapshot.breakBar.tf !== snapshot.closedBar.tf
        || snapshot.breakBar.openTimeMs !== snapshot.closedBar.openTimeMs || !snapshot.impulse
        || snapshot.impulse.direction !== leg.dir || snapshot.impulse.origin !== leg.origin || snapshot.impulse.extreme !== leg.extreme) {
        decision = waiting('WAIT_DATA_BREAK_ATR_VINTAGE_OR_IMPULSE');
    } else {
        const direction = leg.dir;
        const riskDist = Math.abs(currentPrice - initialSlPrice);
        let plannedTp2Price = requestedTp2Price;
        const policy = resolveExecutionPolicy(config.executionPolicy);
        // Validate the original request before a legacy abs-distance cap can flip its side.
        if (policy.profile === 'microstructure_v1' && requestedTp2Price !== undefined
            && (!Number.isFinite(requestedTp2Price) || (direction === 'BUY' ? requestedTp2Price-currentPrice : currentPrice-requestedTp2Price) <= 0)) {
            decision = waiting('WAIT_DATA_UNFAVORABLE_PLANNED_TP2');
        } else if (policy.targets) {
            const instrument = config.executionInstrument;
            const targets = validateExecutionInstrument(instrument) && instrument.ticker === snapshot.ticker
                ? computeExecutionTargets({ direction, entryPrice: currentPrice, initialSlPrice, requestedTp2Price, regime: instrument.regime, adr: getAdrPrice(snapshot.ticker) }) : undefined;
            if (!targets?.valid) decision = waiting('WAIT_DATA_TARGET_INSTRUMENT');
            else plannedTp2Price = targets.tp2Price;
        } else plannedTp2Price = capTp2Price(snapshot.ticker, direction, currentPrice, initialSlPrice, requestedTp2Price);
        if (!decision) {
            const distances = state.zones.filter(z => z.dir !== direction).map(z => direction === 'BUY' ? z.btm-currentPrice : currentPrice-z.top).filter(d => Number.isFinite(d) && d > 0);
            decision = evaluateSmartEntryRouting({ ticker: snapshot.ticker, direction, nowMs, currentPrice,
                originPrice: snapshot.impulse.origin, extremePrice: snapshot.impulse.extreme, riskDist,
                atr14: snapshot.atr14, adr: getAdrPrice(snapshot.ticker), plannedTp2Price,
                ...(distances.length ? { rewardToOppositeZone: Math.min(...distances) } : {}),
                breakBar: snapshot.breakBar, impulseCreatedAtMs: snapshot.impulse.createdAtMs,
                fvgs: snapshot.fvgs, tickActivity: snapshot.tickActivity,
                htfAligned: ['60','240','D'].filter(key => state.marketBias[key] === direction
                    && nowMs - (state.biasTs?.[key] ?? 0) < ({ '60': 8, '240': 48, D: 120 }[key]! * 3600e3)).length });
        }
    }
    leg.executionDecision = decision;
    leg.executionDecisionAtMs = nowMs;
    if (snapshot && decision.mode !== 'WAIT_DATA') leg.executionSnapshot = JSON.parse(JSON.stringify(snapshot));
    return decision;
}

interface ExecutionBrokerBoundary {
    now(): number;
    quote(): ExecutionQuote | undefined;
    rolloverBlocked(): boolean;
    accounting(): Promise<ExecutionCostInput | undefined>;
    /** Boolean false is ambiguous; only an explicit rejected status proves no close was accepted. */
    partial(percent: number): Promise<boolean | { status: 'confirmed' | 'unconfirmed' | 'rejected' }>;
    readProtection(): Promise<{ exists: boolean; stopLoss: number | null } | null>;
    amend(price: number, beforeAmend: () => boolean): Promise<boolean>;
    persist(fields: Record<string, unknown>): Promise<void>;
}

/** Live boundary shared by PING management and offline VM tests; no broker success is presumed. */
export async function manageExecutionPosition(trade: ActiveTrade, snapshot: ExecutionMarketSnapshot | undefined, nowMs: number, partialClosePct: number, boundary: ExecutionBrokerBoundary): Promise<string> {
    const policy = trade.executionPolicy, instrument = trade.executionInstrument;
    if (!trade.executionState || trade.executionState.schema !== 1 || trade.executionState.profile !== 'microstructure_v1'
        || policy?.profile !== 'microstructure_v1') return 'LEGACY_POSITION';
    if (!validateExecutionInstrument(instrument) || instrument.ticker !== trade.ticker) return 'UNKNOWN_COST_METADATA';
    const q = boundary.quote();
    if (!q || q.source !== 'broker' || ![q.bid,q.ask,q.timestampMs].every(Number.isFinite) || !(q.bid > 0 && q.ask >= q.bid) || q.timestampMs <= trade.executionState.entryTimestampMs || q.timestampMs > nowMs || nowMs-q.timestampMs > 10000) return 'WAIT_DATA_QUOTE';
    const executable = trade.direction === 'BUY' ? q.bid : q.ask;
    const touched = trade.tp1Price > 0 && (trade.direction === 'BUY' ? executable >= trade.tp1Price : executable <= trade.tp1Price);
    const next = advanceExecutionPositionState(trade.executionState, { direction: trade.direction, entryPrice: trade.entryPrice, quote: q, nowMs, tp1Touched: touched });
    await boundary.persist({ executionState: next });
    trade.executionState = next;
    if (boundary.rolloverBlocked()) return 'ROLLOVER_BLOCKED';
    let accounting = await boundary.accounting();
    if ((policy.management || policy.trailing) && next.tp1Touched && !next.partialConfirmed && partialClosePct > 0 && partialClosePct < 1) {
        // Persist intent before broker side effect. An uncertain acknowledgement must not duplicate the partial.
        if (!(trade as any).executionPartialPending) {
            if (!accounting || !(accounting.remainingLots > 0)) return 'UNKNOWN_REMAINING_QUANTITY';
            const beforeLots = accounting.remainingLots;
            await boundary.persist({ executionPartialPending: true, executionPartialBeforeLots: beforeLots });
            (trade as any).executionPartialPending = true;
            (trade as any).executionPartialBeforeLots = beforeLots;
            const success = await boundary.partial(Math.round(partialClosePct * 100));
            // The legacy boolean API also returns false after an accepted close whose
            // readback timed out. Keep the durable intent until observed volume reconciles it.
            if (typeof success === 'object' && success.status === 'rejected') {
                await boundary.persist({ executionPartialPending: false });
                (trade as any).executionPartialPending = false;
                return 'PARTIAL_REJECTED';
            }
            if (success !== true && (typeof success !== 'object' || success.status !== 'confirmed')) return 'WAIT_PARTIAL_READBACK';
        }
        accounting = await boundary.accounting();
        if (!accounting || !(accounting.remainingLots > 0 && accounting.remainingLots < (trade as any).executionPartialBeforeLots)) return 'WAIT_PARTIAL_READBACK';
        const confirmed = { ...next, partialConfirmed: true };
        await boundary.persist({ executionState: confirmed, tp1Hit: true, executionPartialPending: false, executionRemainingLots: accounting.remainingLots });
        trade.executionState = confirmed;
        trade.tp1Hit = true;
        (trade as any).executionPartialPending = false;
    }
    const costs = accounting ? estimatePendingExecutionCosts({ ...accounting, instrument }) : undefined;
    if (!costs?.valid) return costs?.reason ?? 'UNKNOWN_COST_METADATA';
    const state = trade.executionState;
    let candidate = trade.slPrice, stage: ExecutionPositionState['stage'] = state.stage;
    if (policy.management) {
        const result = evaluateDynamicBreakeven({ ticker: trade.ticker, direction: trade.direction, entryPrice: trade.entryPrice,
            currentSlPrice: trade.slPrice, currentQuote: q, instrument, state, atr14: snapshot?.atr14, adr: getAdrPrice(trade.ticker),
            nowMs, pendingCostPrice: costs.pendingCostPrice, rolloverBlocked: boundary.rolloverBlocked() });
        if (result.shouldUpdateSl) { candidate = result.newSlPrice; stage = result.stage; }
    }
    // Never trail on a net stage proposed in this observation; require the persisted previous stage.
    if (policy.trailing && state.stage === 'NET_PROTECTION_ESTIMATE') {
        const impulse = snapshot?.impulse;
        candidate = computeMultiAssetTrailingSl({ ticker: trade.ticker, direction: trade.direction, entryPrice: trade.entryPrice,
            currentSlPrice: candidate, tp2Price: trade.tp2Price, currentQuote: q, instrument, state, atr14: snapshot?.atr14, nowMs,
            rolloverBlocked: boundary.rolloverBlocked(), latestStructuralOrigin: impulse && snapshot?.breakBar ? {
                price: impulse.origin, direction: impulse.direction, tf: snapshot.tf, eventAtMs: snapshot.breakBar.closeTimeMs, availableAtMs: snapshot.breakBar.availableAtMs } : undefined });
    }
    const valid = validateExecutionStop({ direction: trade.direction, candidateSl: candidate, currentSl: trade.slPrice, quote: q, instrument, nowMs });
    if (!valid.valid || boundary.rolloverBlocked()) return valid.reason;
    const before = await boundary.readProtection();
    if (!before?.exists || before.stopLoss === null) return 'WAIT_BROKER_PROTECTION';
    // Recovery after an earlier accepted amend whose immediate readback/persist was unavailable.
    if (Math.abs(before.stopLoss-valid.price) <= instrument.tickSize/2) {
        const recovered = { ...trade.executionState, stage, lastConfirmedSlPrice: before.stopLoss };
        await boundary.persist({ slPrice: before.stopLoss, executionState: recovered });
        trade.slPrice = before.stopLoss; trade.executionState = recovered;
        return stage;
    }
    // A/D/restore or another manager may already have stronger protection. Never loosen it.
    const baseline = trade.direction === 'BUY' ? Math.max(trade.slPrice, before.stopLoss) : Math.min(trade.slPrice, before.stopLoss);
    const beforeAmend = () => {
        const quote = boundary.quote(), at = boundary.now();
        return !boundary.rolloverBlocked() && !!quote && validateExecutionStop({ direction: trade.direction, candidateSl: valid.price,
            currentSl: baseline, quote, instrument, nowMs: at }).valid;
    };
    if (!beforeAmend() || !await boundary.amend(valid.price, beforeAmend)) return 'AMEND_REJECTED';
    const readback = await boundary.readProtection();
    if (!readback?.exists || readback.stopLoss === null || Math.abs(readback.stopLoss-valid.price) > instrument.tickSize/2) return 'AMEND_UNCONFIRMED';
    const confirmed = { ...trade.executionState, stage, lastConfirmedSlPrice: readback.stopLoss };
    await boundary.persist({ slPrice: readback.stopLoss, executionState: confirmed });
    trade.slPrice = readback.stopLoss;
    trade.executionState = confirmed;
    return stage;
}

/** 🆕 Radar v2: estado operativo del bot por activo (killswitches, sesión, cooldown, posición, TimesFM) */
function buildBotStatus(ticker: string, s: any): any {
    const now = Date.now();
    const cfg: any = globalState.assetSessionConfigs.get(ticker);
    const ks: string[] = [];
    if (now < globalState.streakKillswitchUntil) ks.push('racha');
    if (now < globalState.vixKillswitchUntil) ks.push('VIX');
    if (now < globalState.globalPortfolioKillswitchUntil) ks.push('portfolio');
    const session = getCurrentSession(now);
    const sessionTriggers: any = (cfg?.sessions as any)?.[session] ?? (cfg?.sessions as any)?.['ALL'];
    const anyTriggerOn = Object.values(sessionTriggers ?? {}).some((t: any) => t?.enabled !== false);
    const sessionOff = session === 'OFF' || (sessionTriggers !== undefined && !anyTriggerOn);
    const sniperMs = (cfg as any)?.sniperCooldownMs ?? (globalState.dynamicBotConfig as any)?.sniperCooldownMs ?? 180000;
    const cooldown = now - (s.lastSniperAlert ?? 0) < sniperMs;
    let position: any = null;
    for (const t of globalState.activeTrades.values()) {
        if (t.ticker === ticker && !t.isBacktest) {
            // 🛡️ 16-sep-2026: el R va contra el SL ESTRUCTURAL ORIGINAL (initial/original), nunca
            // contra el SL vigente (que se mueve a breakeven/trailing → riesgo degenerado → R gigante).
            const initSl = t.initialSlPrice ?? t.originalSlPrice ?? t.slPrice;
            const risk = initSl != null ? Math.abs(t.entryPrice - initSl) : 0;
            const eps = Math.max(0.1, Math.abs(t.entryPrice) * 0.0005); // riesgo degenerado → null
            const pnlR = s.lastPrice != null && risk > eps
                ? (t.direction === 'BUY' ? (s.lastPrice - t.entryPrice) / risk : (t.entryPrice - s.lastPrice) / risk)
                : null;
            position = { direction: t.direction, pnlR: pnlR == null ? null : +pnlR.toFixed(2), managementMode: t.managementMode };
            break;
        }
    }
    const tfm = lastTfmByTicker.get(ticker);
    const ba = getLastBidAsk(ticker);
    // Unidad de spread por tipo de activo (1 pip forex = 0.0001, JPY = 0.01,
    // oro/petróleo en centavos, índices en puntos, crypto en USD).
    const tu = ticker.toUpperCase();
    let unitSize = 0.0001; let unitLabel = 'pips';
    if (tu.includes('JPY')) { unitSize = 0.01; unitLabel = 'pips'; }
    else if (tu.includes('XAU') || tu.includes('XAG')) { unitSize = 0.01; unitLabel = 'cents'; }
    else if (tu === 'US500' || tu.includes('NAS') || tu.includes('US30') || tu.includes('SPX') || tu.includes('GER') || tu.includes('DE40') || tu.includes('DAX')) { unitSize = 1; unitLabel = 'pts'; }
    else if (tu.includes('USOIL') || tu.includes('WTI') || tu.includes('OIL')) { unitSize = 0.01; unitLabel = 'cents'; }
    else if (tu.includes('BTC') || tu.includes('ETH')) { unitSize = 1; unitLabel = 'USD'; }
    return {
        ks: ks.length ? ks : null,
        session,
        sessionOff,
        cooldown,
        enabled: cfg?.enabled !== false,
        position,
        tfm: tfm && now - tfm.ts < 15 * 60 * 1000 ? tfm : null,
        spreadPips: ba ? +((ba.ask - ba.bid) / unitSize).toFixed(1) : null,
        spreadUnit: unitLabel,
    };
}

// 🆕 27-sep-2026: sizing fraccional por sesión (sizing_weekly_proposal → bot_config.sizingFactors).
// Factor 0.4..1.6 multiplica el riesgo del trade en esa sesión; default 1 (sin efecto).
export function getSessionSizingFactor(session: string): number {
    const f = (globalState.dynamicBotConfig as any).sizingFactors?.[session];
    return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : 1;
}

function scheduleStateSave(ticker: string, state: RadarState) {
    // 🔧 Reemplazo de Firebase: guardar radar states en archivo JSON local
    // Elimina ~777K escrituras/día de Firestore. La cuota se libera para journal + trades.
    dirtyStates.set(ticker, { ...state });
    if (!stateFlushTimeout) {
        stateFlushTimeout = setTimeout(() => {
            stateFlushTimeout = null;
            if (dirtyStates.size === 0) return;
            const toSave = new Map(dirtyStates);
            dirtyStates.clear();
            // Guardar a archivo JSON local + broadcast WebSocket al dashboard
            try {
                for (const [t, s] of toSave.entries()) {
                    // 🆕 Radar v2: adjuntar estado operativo del bot (killswitches, sesión, cooldown, posición, TimesFM)
                    const enriched = { ...s, botStatus: buildBotStatus(t, s) };
                    fs.writeFileSync(`radar_states_${t}.json`, JSON.stringify(enriched), 'utf8');
                }
                // Broadcast via WebSocket (ya existe en puerto 8081)
                import('../services/ws_server.js').then(({ broadcastRadarState }) => {
                    for (const [t, s] of toSave.entries()) {
                        broadcastRadarState(t, { ...s, botStatus: buildBotStatus(t, s) });
                    }
                }).catch(() => {});
            } catch (e: any) {
                // Silencioso — si falla el disco, no crashea el bot
            }
        }, 5000); // cada 5 segundos (antes era 1s a Firebase)
    }
}

let rawSignalsBuffer: any[] = [];
let signalFlushTimeout: NodeJS.Timeout | null = null;

function scheduleRawSignalSave(data: any) {
    return; // Disabled to save Firestore quota
    rawSignalsBuffer.push(data);
    if (!signalFlushTimeout) {
        signalFlushTimeout = setTimeout(() => {
            signalFlushTimeout = null;
            if (rawSignalsBuffer.length === 0) return;
            if (!db) return;

            // Limit to 490 per batch to avoid Firestore limits
            const chunks = [];
            while (rawSignalsBuffer.length > 0) {
                chunks.push(rawSignalsBuffer.splice(0, 490));
            }

            for (const chunk of chunks) {
                const batch = db.batch();
                for (const sig of chunk) {
                    const ref = db.collection('raw_signals').doc();
                    batch.set(ref, sig);
                }
                batch.commit().catch((e: any) => console.error('[FIREBASE] Error in signals batch commit:', e.message));
            }
        }, 2000);
    }
}

export const getActiveTradeCount = () => globalState.activeTrades.size;
export const getLastPingTime = () => globalState.lastPingTime;

// 👻 RECONCILIACIÓN cTrader ↔ RAM/Firestore: si el stream de cTrader pierde un evento
// de cierre (desconexión, token expirado), la posición queda "fantasma" en activeTrades
// y congela al activo (anti-piramidación + "mantiene operación actual"). Este reconciler
// compara las posiciones REALMENTE abiertas en cTrader contra activeTrades y finaliza
// fantasmas consultando el historial real de la posición.
let lastReconcileTs = 0;

// Broker-verified close: full volume, deduped deals, per-deal money scale and immutable opening risk.
async function resolveClosedFromDeals(positionId: string, trade: any): Promise<ClosedTradeAccounting | null> {
    try {
        const broker = await import('../services/ctrader.js');
        const deals = await broker.getDealsByPosition(positionId);
        // Old display getter silently defaults to USD. Only verified metadata establishes the denominator currency.
        const currency = (broker as any).getVerifiedAccountCurrency?.() ?? null;
        return resolveTradeCloseAccounting(positionId, trade, deals, currency);
    } catch (e: any) {
        console.warn(`[RECONCILE] no se pudo leer historial de posID ${positionId}: ${e.message}`);
        return null;
    }
}

/** 🛡️ 24-sep-2026: resuelve el PnL REAL de una posición recién cerrada por SAR/reversión.
 *  closePosition() cierra en el broker pero el deal puede tardar unos segundos en
 *  propagarse a la historia — por eso reintenta con backoff. Antes el cierre SAR solo
 *  escribía recordResult('REVERSAL') sin PnL y el trade quedaba para SIEMPRE con '—'
 *  en el Diario (el reconcile de arranque no lo revisa: el doc de active_trades ya
 *  estaba borrado). Medido 23-sep-2026: 2 reversiones sin PnL real en el journal. */
export async function finalizeClosedPositionFromDeals(positionId: string, trade: any): Promise<ClosedTradeAccounting | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
        const resolved = await resolveClosedFromDeals(positionId, trade);
        if (resolved) return resolved;
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
    return null;
}

// Keep the RAM entry-only hold across broker history, durable accounting and active cleanup.
async function completeLiveTradeClose(trade: ActiveTrade, store: StateStore, extra: Record<string, unknown> = {}, accounting?: ClosedTradeAccounting): Promise<boolean> {
    (trade as any).closeAccountingPending = true;
    extra = { ...(trade as any).closeAccountingExtra, ...extra };
    (trade as any).closeAccountingExtra = extra;
    invalidateRiskCache();
    try {
        if (!trade.ctraderPositionId) throw new Error('CLOSE_ACCOUNTING_PENDING: broker position identity unavailable');
        const resolved = accounting ?? await finalizeClosedPositionFromDeals(String(trade.ctraderPositionId), trade);
        if (!resolved) throw new Error('CLOSE_ACCOUNTING_PENDING: broker history incomplete');
        (trade as any).brokerCloseConfirmed = true; // Complete broker deals, not an entry incident, prove closure.
        await commitTradeCloseAccounting(db, trade.journalId!, resolved, extra);
        await db!.collection('active_trades').doc(trade.tradeId).delete();
        Object.assign(trade, { executionIncidentPending: false, executionUncertain: false, closeAccountingPending: false, executionFillUnverified: false });
        store.activeTrades.delete(trade.tradeId);
        return true;
    } catch (error: any) {
        (trade as any).closeAccountingPending = true;
        console.warn(`[ACCOUNTING] ${trade.ticker} #${trade.tradeId}: close retained for retry: ${error.message}`);
        if (db) {
            // A journal-only recovery may have no active doc yet. Persist the full
            // retry identity/immutable evidence, not a flag-only restart tombstone.
            const retained = JSON.parse(JSON.stringify({ ...trade, closeAccountingPending: true, closeAccountingExtra: extra }));
            const activeRef: import('firebase-admin').firestore.DocumentReference = db.collection('active_trades').doc(trade.tradeId);
            try {
                await db.runTransaction(async (tx: import('firebase-admin').firestore.Transaction) => {
                    const existing = (await tx.get(activeRef)).data();
                    if (existing) {
                        for (const key of ['tradeId', 'journalId', 'ticker', 'direction', 'ctraderPositionId',
                            'riskSnapshot', 'riskAmountAccount', 'accountCurrency', 'initialSlPrice', 'originalSlPrice']) {
                            if (existing[key] != null && retained[key] != null && JSON.stringify(existing[key]) !== JSON.stringify(retained[key])) {
                                throw new Error(`CLOSE_ACCOUNTING_PENDING: conflicting recovery ${key}`);
                            }
                        }
                    }
                    tx.set(activeRef, retained, { merge: true });
                });
            } catch (error: any) { console.warn(`[ACCOUNTING] recovery identity retained in RAM: ${error.message}`); }
            if (trade.journalId) await db.collection('trade_journal').doc(trade.journalId).set({ closeAccountingPending: true }, { merge: true }).catch(() => {});
        }
        return false;
    } finally { invalidateRiskCache(); }
}

// 🛑 16-sep-2026: registro de señales BLOQUEADAS para el contrafactual semanal
// (scripts/blocked_signals_eval.ts simula qué habría pasado con cada una usando
// velas M5 reales de cTrader). Un JSONL por señal, con los parámetros completos.
function logBlockedSignal(reason: string, o: any, ts: number): void {
    if (!o || !o.ticker) return;
    try {
        fs.appendFileSync('/opt/JARVIS/logs/blocked_signals.jsonl', JSON.stringify({
            ts, ticker: o.ticker, direction: o.direction, reason,
            points: o.points, entry: o.entryPrice,
            sl: parseFloat(o.stopLoss), tp1: parseFloat(o.tp1), tp2: parseFloat(o.tp2),
            isChochEntry: o.isChochEntry === true,
        }) + '\n');
    } catch { /* best-effort */ }
}

export async function reconcileCTraderPositions(): Promise<void> {
    try {
        if (Date.now() - lastReconcileTs < 5 * 60 * 1000) return; // throttle 5 min
        lastReconcileTs = Date.now();
        const { getOpenPositions, getDealsByPosition, isCTraderReady } = await import('../services/ctrader.js');
        // 🆕 FIX (ago-2026): si cTrader NO está conectado, getOpenPositions() devuelve [] en silencio
        // y la pasada de fantasmas marcaba como CERRADAS posiciones que siguen VIVAS
        // (falsos BREAKEVEN + borrado de active_trades en cada arranque).
        if (!isCTraderReady()) {
            lastReconcileTs = 0; // permitir reintento inmediato al conectarse (hook en connectCTrader)
            console.log('[RECONCILE] ⏸️ cTrader no conectado — se omite esta pasada (evita falsos fantasmas).');
            return;
        }
        const open = await getOpenPositions();
        if (!Array.isArray(open)) throw new Error('Broker positions unavailable; reconciliation skipped');
        if (await loadRolloverJournalPending() === false) throw new Error('Journal safety unavailable; reconciliation skipped');
        console.log(`[RECONCILE] run: activeTrades=${globalState.activeTrades.size} | posiciones abiertas en cTrader=${open.length}${open.length ? ' → ' + open.map((p: any) => String(p.positionId)).join(',') : ''}`);
        if (globalState.activeTrades.size === 0 && open.length === 0) {
            console.log('[RECONCILE] RAM y cTrader vacíos; se auditan journals pendientes igualmente.');
        }
        const openIds = new Set(open.map((p: any) => String(p.positionId)));
        const GRACE_MS = 5 * 60 * 1000;

        // 🛡️ FIX (30-sep-2026): barrido de huérfanos SIN ejecución — trades activos sin
        // posID (bloqueados por killswitch pre-ejecución, confirmaciones nunca tocadas,
        // etc.) que quedaron colgados en RAM/Firestore para siempre (caso real: EMR98C
        // XAUUSD y R33DI4 GBPJPY del 28-sep). Antigüedad > 2h → eliminar y marcar SKIP.
        const nowTs = Date.now();
        for (const [ramId, ramTrade] of [...globalState.activeTrades.entries()]) {
            if (ramTrade.isBacktest || ramTrade.ctraderPositionId || hasPendingExecutionIncident(ramTrade as any) || rolloverDWideMap.has(ramId)) continue;
            const ageMs = nowTs - Number(ramTrade.timestamp || 0);
            if (ageMs > 2 * 60 * 60 * 1000) {
                console.log(`[RECONCILE] 🧹 Huérfano sin ejecución #${ramId} (${ramTrade.ticker}, ${(ageMs / 3600000).toFixed(1)}h) eliminado de active_trades.`);
                globalState.activeTrades.delete(ramId);
                if (db) {
                    db.collection('active_trades').doc(ramId).delete().catch(() => { });
                    const jid = (ramTrade as any).journalId;
                    // Age without a position id is not broker evidence of a rejected/unsubmitted order.
                    if (jid) db.collection('trade_journal').doc(jid).update({ staleSignalExpired: true }).catch(() => { });
                }
            }
        }

        for (const trade of [...globalState.activeTrades.values()]) {
            if (trade.isBacktest || !trade.ctraderPositionId) continue;
            if (Date.now() - trade.timestamp < GRACE_MS) continue; // recién abierto → gracia
            if (openIds.has(String(trade.ctraderPositionId))) continue;
            console.log(`[RECONCILE] 👻 Posición fantasma ${trade.ticker} #${trade.tradeId} (posID ${trade.ctraderPositionId}) — consultando historial real...`);
            let pnl = 0;
            let result = 'BREAKEVEN';
            let slHit = false;
            (trade as any).closeAccountingPending = true;
            invalidateRiskCache();
            const resolved = await resolveClosedFromDeals(trade.ctraderPositionId!, trade);
            if (!resolved) {
                console.warn(`[RECONCILE] ⚠️ Historial incompleto para posID ${trade.ctraderPositionId} — se conserva pendiente, sin fabricar resultado.`);
                continue;
            }
            pnl = resolved.pnl; result = resolved.result; slHit = resolved.slHit;
            const rMultiple = resolved.rMultiple;
            const journalId = trade.journalId;
            if (db && journalId) {
                // A manual annotation is not permission to discard broker accounting obligations.
                const jSnap = await db.collection('trade_journal').doc(journalId).get();
                if (jSnap?.data()?.manualResult) {
                    console.warn(`[RECONCILE] #${journalId}: resultado manual en conflicto; se conserva pendiente.`);
                    continue;
                }
            }
            if (!await completeLiveTradeClose(trade, globalState, { reconciled: true }, resolved)) { lastReconcileTs = 0; continue; }
            if (db) {
                // 🆕 Dedupe: otros docs abiertos con el mismo posID son duplicados de este cierre.
                try {
                    const dupSnap = await db.collection('trade_journal')
                        .where('ctraderPositionId', '==', trade.ctraderPositionId)
                        .limit(10).get();
                    for (const d of dupSnap.docs) {
                        if (d.id === journalId) continue;
                        const x = d.data();
                        if (!x.result && x.mode !== 'backtesting') {
                            await d.ref.update({ duplicateOf: journalId });
                            console.log(`[RECONCILE] 🧹 Duplicado abierto #${d.id} marcado duplicateOf #${journalId} (posID ${trade.ctraderPositionId}).`);
                        }
                    }
                } catch (e: any) {
                    console.warn(`[RECONCILE] ⚠️ dedupe falló para posID ${trade.ctraderPositionId}: ${e.message}`);
                }
            }
            console.log(`[RECONCILE] ✅ ${trade.ticker} #${trade.tradeId} finalizado como ${result} (pnl=$${pnl.toFixed(2)}, ${rMultiple}R)`);
        }

        // 🆕 Reapertura general: docs del journal con result cuya posición SIGUE viva en cTrader.
        // (Cubre también trades gestionados en RAM, no solo adoptados — ej. SKAAQ2 cerrado en
        // journal por error de stream pero abierto en el broker.)
        if (db) {
            try {
                for (const pid of openIds) {
                    const jSnap = await db.collection('trade_journal')
                        .where('ctraderPositionId', '==', pid)
                        .limit(10).get();
                    for (const d of jSnap.docs) {
                        const x = d.data();
                        if (x.result && !x.reopened) {
                            await d.ref.update({ result: null, closedAt: null, rMultiple: null, slHit: null, reopened: true, reopenedAt: Date.now() });
                            console.log(`[RECONCILE] 🔓 Journal #${d.id} (posID ${pid}) reabierto: posición viva en el broker.`);
                        }
                    }
                }
                // 🆕 docs viejos sin ctraderPositionId: reabrir por id del trade en RAM
                for (const t of [...globalState.activeTrades.values()]) {
                    if (!t.ctraderPositionId || !openIds.has(String(t.ctraderPositionId))) continue;
                    const jid = t.journalId || t.tradeId;
                    if (!jid) continue;
                    const dSnap = await db.collection('trade_journal').doc(jid).get();
                    const x = dSnap.data();
                    if (x && x.result && !x.reopened) {
                        await dSnap.ref.update({ result: null, closedAt: null, rMultiple: null, slHit: null, reopened: true, reopenedAt: Date.now() });
                        console.log(`[RECONCILE] 🔓 Journal #${jid} reabierto (trade en RAM con posición viva, doc sin posID).`);
                    }
                }
            } catch (e: any) {
                console.warn('[RECONCILE] error en reapertura general:', e.message);
            }
        }

        // 🐣 Adopción de HUÉRFANOS: posiciones abiertas en cTrader sin trade en RAM
        // (ej. el bot perdió el trade en un reinicio, o el cierre no se registró y quedó
        // una posición viva sin gestión). Se re-adopta con los niveles REALES de cTrader.
        const knownIds = new Set([...globalState.activeTrades.values()].map(t => t.ctraderPositionId && String(t.ctraderPositionId)).filter(Boolean));
        for (const p of open) {
            const pid = String(p.positionId);
            if (knownIds.has(pid)) continue;
            console.log(`[RECONCILE] 🐣 Huérfano RAW: ${JSON.stringify(p).slice(0, 600)}`);
            const td: any = p.tradeData || {};
            const side = (td.tradeSide ?? td.direction) as any;
            const dirNum = typeof side === 'number' ? side : String(side || '').toUpperCase();
            const dir = dirNum === 1 || dirNum === 'BUY' ? 'BUY' : dirNum === 2 || dirNum === 'SELL' ? 'SELL' : null;
            if (!dir) { console.warn('[RECONCILE] sin dirección clara — no se adopta'); continue; }
            const entry = Number(td.openPrice ?? p.price ?? 0) || null;
            const slPrice = Number(p.stopLoss ?? 0) || null;
            const tpPrice = Number(p.takeProfit ?? 0) || null;
            const openTs = Number(td.openTimestamp ?? Date.now()) || Date.now();
            // Resolver símbolo desde symbolId (el payload de posición no trae el nombre)
            let sym = String(p.symbolName || td.symbolName || p.ticker || '').toUpperCase();
            if (!sym && td.symbolId != null) {
                try {
                    const { getSymbolName } = await import('../services/ctrader.js');
                    sym = (await getSymbolName(Number(td.symbolId))).toUpperCase();
                } catch { }
            }
            console.log(`[RECONCILE] 🐣 Huérfano: sym='${sym}' ${dir} posID=${pid} entry=${entry} SL=${slPrice} TP=${tpPrice} label=${td.label || ''}`);
            if (entry == null) { console.warn('[RECONCILE] sin precio de entrada — no se adopta'); continue; }
            if (!sym) { console.warn('[RECONCILE] sin símbolo — no se adopta'); continue; }

            // 🛡️ FIX C v3: antes de adoptar, reconciliar el journal para esta posición:
            // 1) docs con result pero posición VIVA en el broker → resultado inválido → REABRIR.
            // 2) varios docs abiertos con el mismo posID → mergear (queda uno).
            let existingJournalId: string | null = null;
            let existingJournalData: any = null;
            if (db) {
                try {
                    const dupSnap = await db.collection('trade_journal')
                        .where('ctraderPositionId', '==', pid)
                        .limit(10).get();
                    const openDocs: any[] = [];
                    for (const d of dupSnap.docs) {
                        const x = d.data();
                        if (x.result && !x.reopened) {
                            // journal dice cerrado pero el broker tiene la posición viva → reabrir
                            await d.ref.update({
                                result: null, closedAt: null, rMultiple: null, slHit: null,
                                reopened: true, reopenedAt: Date.now(),
                            });
                            console.log(`[RECONCILE] 🔓 Journal #${d.id} (posID ${pid}) reabierto: la posición SIGUE viva en el broker.`);
                            openDocs.push({ id: d.id, x });
                            existingJournalId = existingJournalId ?? d.id;
                        } else if (!x.result && x.mode !== 'backtesting') {
                            openDocs.push({ id: d.id, x });
                        }
                    }
                    // si hay más de un doc abierto para el mismo posID → mergear
                    if (openDocs.length > 1) {
                        const labelMatch = openDocs.find(o => td.label && String(td.label).toUpperCase() === String(o.id).toUpperCase());
                        const keeper = labelMatch ?? openDocs.sort((a, b) => Number(a.x.timestamp ?? 0) - Number(b.x.timestamp ?? 0))[0];
                        existingJournalId = keeper.id;
                        for (const o of openDocs) {
                            if (o.id !== keeper.id) {
                                await db.collection('trade_journal').doc(o.id).update({ duplicateOf: keeper.id }).catch(() => {});
                                console.log(`[RECONCILE] 🧹 Duplicado abierto #${o.id} mergeado a #${keeper.id} (posID ${pid}).`);
                            }
                        }
                    } else if (openDocs.length === 1) {
                        existingJournalId = openDocs[0].id;
                    }
                    existingJournalData = openDocs.find(o => o.id === existingJournalId)?.x ?? null;
                } catch (e: any) {
                    console.warn(`[RECONCILE] ⚠️ no se pudo chequear duplicado de journal: ${e.message}`);
                }
            }
            if (existingJournalId) {
                console.log(`[RECONCILE] ♻️ Posición ${sym} ${dir} posID=${pid} ya tiene journal abierto #${existingJournalId} — re-enlazando en vez de duplicar.`);
            }
            // 🆕 FIX (ago-2026): eliminar gemelos zombie antes de adoptar. Tras un reinicio,
            // un trade rehidratado sin ctraderPositionId sigue en RAM y manda notificaciones
            // fantasma mientras no puede tocar cTrader. Si la posición que vamos a adoptar
            // ya tiene un gemelo así (mismo journal o label), se lo saca de RAM y Firestore
            // para que la posición se gestione UNA sola vez, con niveles reales del broker.
            const twinLabel = String(td.label || '').toUpperCase();
            for (const [ramId, ramTrade] of [...globalState.activeTrades.entries()]) {
                if (ramTrade.ctraderPositionId) continue;
                const isTwin = (existingJournalId && (ramTrade.journalId === existingJournalId || ramId === existingJournalId))
                    || (twinLabel && ramId === twinLabel);
                if (isTwin) {
                    globalState.activeTrades.delete(ramId);
                    if (db) db.collection('active_trades').doc(ramId).delete().catch(() => { });
                    console.log(`[RECONCILE] 🧟 Eliminado gemelo zombie #${ramId} de la posición ${pid} (se gestiona con niveles reales).`);
                }
            }
            // Si la posición tiene label del bot, se adopta con ese id (vincula con el historial)
            const tradeId = (existingJournalData?.rolloverFill?.positionId === pid && existingJournalData?.rolloverTriageIdentity?.tradeId)
                || existingJournalId || ((td.label && /^[A-Z0-9]{6}$/.test(td.label)) ? td.label : `ADOPT${pid}`);
            const now = Date.now();
            const trade: any = {
                tradeId, ticker: sym, direction: dir as 'BUY' | 'SELL',
                entryPrice: entry, slPrice: slPrice ?? entry, tp1Price: tpPrice ?? entry,
                tp2Price: capTp2Price(sym, dir as 'BUY' | 'SELL', entry, slPrice ?? entry, tpPrice ?? entry), originalSlPrice: slPrice ?? entry,
                timestamp: now, score: 0, ctraderPositionId: pid,
                adopted: true, adoptedFromCTrader: true, openTs,
                journalId: existingJournalId ?? tradeId,
                ...Object.fromEntries(Object.entries(existingJournalData ?? {}).filter(([key]) => key.startsWith('rollover'))),
            };
            // Recover opening evidence, never infer initial risk from the current (possibly trailed) stop.
            for (const key of ['riskSnapshot','accountCurrency','riskAmountAccount','riskAccountingStatus','riskAccountingProvenance','riskBudgetAccount','requestedRiskPercent',
                'initialSlPrice','originalSlPrice','executionUncertain','executionIncidentPending','closeAccountingPending','executionFillUnverified']) {
                if (existingJournalData?.[key] !== undefined) trade[key] = existingJournalData[key];
            }
            if (freezeTradeRiskForTrade(trade) && Math.abs(trade.riskSnapshot.entryPrice - entry) <= Math.max(1, entry) * 1e-12) {
                trade.initialSlPrice = trade.riskSnapshot.initialSlPrice;
                trade.originalSlPrice = trade.riskSnapshot.initialSlPrice;
                trade.riskAmountAccount = trade.riskSnapshot.riskAmountAccount;
                trade.riskAccountingProvenance = trade.riskSnapshot.source;
            } else {
                // A valid snapshot for a different actual entry is still mismatched evidence.
                if (trade.riskAccountingStatus === 'VERIFIED') trade.riskAccountingStatus = 'INVALID';
                // A legacy position can be managed, but cannot invent a historical denominator.
                const original = existingJournalData?.originalSlPrice ?? existingJournalData?.initialSlPrice;
                if (Number.isFinite(original) && original > 0) trade.originalSlPrice = original;
                else delete trade.originalSlPrice;
            }
            // Restore only an already-versioned position; current asset configuration is NEVER an adoption source.
            if (existingJournalData?.executionState?.schema === 1 && existingJournalData?.executionPolicy?.profile === 'microstructure_v1') {
                const frozen = existingJournalData, execution = frozen.executionState;
                const knownInitial = Number(frozen.initialSlPrice);
                if (validateExecutionInstrument(frozen.executionInstrument) && frozen.executionInstrument.ticker === sym
                    && execution.profile === 'microstructure_v1' && Number.isFinite(knownInitial) && knownInitial > 0
                    && knownInitial === execution.initialSlPrice && Number.isFinite(execution.initialRiskDist) && execution.initialRiskDist > 0
                    && Math.abs(Math.abs(entry-knownInitial)-execution.initialRiskDist) <= frozen.executionInstrument.tickSize/2) {
                    Object.assign(trade, JSON.parse(JSON.stringify(Object.fromEntries(['executionState','executionPolicy','executionInstrument','executionLots',
                        'executionRemainingLots','executionPartialPending','executionPartialBeforeLots','executionTf','initialSlPrice','mgmtOverrides']
                        .filter(key => frozen[key] !== undefined).map(key => [key,frozen[key]])))));
                    if (Number.isFinite(frozen.tp1Price) && frozen.tp1Price > 0) trade.tp1Price = frozen.tp1Price;
                    if (Number.isFinite(frozen.tp2Price) && frozen.tp2Price >= 0) trade.tp2Price = frozen.tp2Price;
                    trade.tp1Hit = execution.partialConfirmed === true;
                } else trade.executionFillUnverified = true;
            }
            // Journal-only boot recovery may use a prior trade id; migrate safety identity.
            for (const [pendingId, pending] of rolloverDWideMap) {
                if (String(pending.positionId) !== pid) continue;
                Object.assign(trade, { rolloverDWidened: true, rolloverDSlOriginal: pending.orig, rolloverDSlWide: pending.wide, rolloverDRestoreTries: pending.tries, rolloverDNextRetryAt: pending.nextRetryAt ?? 0, rolloverDWidenedAt: pending.at, rolloverDPositionId: pid, rolloverDTicker: sym, rolloverDDirection: dir });
                if (pending.journalId) trade.journalId = pending.journalId;
                if (pendingId !== tradeId) rolloverDWideMap.delete(pendingId);
                break;
            }
            rehydrateRolloverPending(tradeId, trade);
            globalState.activeTrades.set(tradeId, trade);
            if (db) {
                db.collection('active_trades').doc(tradeId).set(trade, { merge: true }).catch(() => {});
                db.collection('trade_journal').doc(tradeId).set({
                    id: tradeId, ticker: sym, direction: dir, grade: 'Reconciliado',
                    points: 0, timestamp: openTs, entryPrice: entry, slPrice: slPrice ?? entry,
                    tp1Price: tpPrice ?? entry, tp2Price: tpPrice ?? entry,
                    ctraderStatus: 'EXECUTED', adopted: true,
                    ctraderPositionId: pid,
                }, { merge: true }).catch(() => {});
            }
            console.log(`[RECONCILE] ✅ Adoptada posición ${sym} ${dir} posID=${pid} como #${tradeId} (gestión reanudada)`);
        }

        // 🆕 Journal abiertos huérfanos: docs sin result cuya posición ya NO está en cTrader
        // ni en RAM (ej. reinicio perdió el trade). Se resuelven con los deals reales del broker.
        if (db) {
            try {
                const openJournals = await db.collection('trade_journal')
                    .where('result', '==', null)
                    .limit(100).get();
                for (const docSnap of openJournals.docs) {
                    const x = docSnap.data();
                    const pid = x.ctraderPositionId ? String(x.ctraderPositionId) : '';
                    if (!pid) continue;
                    if (openIds.has(pid)) continue; // sigue abierta en el broker
                    const inRam = [...globalState.activeTrades.values()].some(t => t.ctraderPositionId && String(t.ctraderPositionId) === pid);
                    if (inRam) continue; // la RAM la gestiona
                    if (Date.now() - Number(x.timestamp ?? 0) < 5 * 60 * 1000) continue; // gracia
                    const resolved = await resolveClosedFromDeals(pid, x);
                    if (!resolved) continue; // sin deal de cierre → dejar abierto, no fabricar
                    const recoveryId = x.tradeId || docSnap.id;
                    if (globalState.activeTrades.has(recoveryId)) continue; // Never replace another management identity.
                    const recoveryTrade = { ...x, tradeId: recoveryId, journalId: docSnap.id, closeAccountingPending: true } as ActiveTrade;
                    globalState.activeTrades.set(recoveryId, recoveryTrade);
                    if (!await completeLiveTradeClose(recoveryTrade, globalState, { reconciled: true }, resolved)) { lastReconcileTs = 0; continue; }
                    console.log(`[RECONCILE] 📖 Journal abierto #${docSnap.id} (posID ${pid}) resuelto con deals: ${resolved.result} (${resolved.rMultiple}R)`);
                }
            } catch (e: any) {
                console.warn('[RECONCILE] error escaneando journals abiertos:', e.message);
            }
        }
    } catch (e: any) {
        lastReconcileTs = 0; // Failed read/write is not a completed pass.
        console.warn('[RECONCILE] error:', e.message);
    }
}


// 🆕 v7.0: Consolidación de Cuenta & Portfolio Global







// Detecta la sesión actual basándose en hora de Argentina (UTC-3)

/**
 * 🛡️ ago-2026 — Buffer de fricción para el SL de breakeven.
 * El fill de un stop paga el spread del lado de cierre: un SL clavado en el entry
 * cierra en negativo chico (fuga medida: −0.15..−0.47 USD por trade BE).
 * Con buffer = max(spread real bid/ask, spread modelado por clase) el fill queda ≈ 0 neto.
 */
function breakevenBufferPrice(ticker: string, entryPrice: number, direction: 'BUY' | 'SELL'): number {
    const pipSize = getPipValue(ticker, entryPrice);
    const cls = getAssetClass(ticker);
    let buffer = (defaultFrictionConfig[cls]?.baseSpreadPips ?? 1) * pipSize;
    const ba = getLastBidAsk(ticker);
    if (ba && Number.isFinite(ba.ask) && Number.isFinite(ba.bid) && ba.ask > ba.bid) {
        buffer = Math.max(buffer, ba.ask - ba.bid);
    }
    return direction === 'BUY' ? entryPrice + buffer : entryPrice - buffer;
}

/**
 * 🆕 ROI Time-Decay: devuelve el profit mínimo requerido (%) según la antigüedad del trade.
 * 
 * @param tradeAgeMinutes minutos desde apertura
 * @param roiTable ej: {"0": 0.015, "30": 0.005, "60": 0}  // decimal: 0.015 = 1.5%
 * @returns [roiPercent, label] — si tradeAge ≥ threshold, devuelve el ROI correspondiente.
 *          Si no hay tabla o está vacía, devuelve [0, null] (sin efecto).
 */
function getEffectiveROI(tradeAgeMinutes: number, roiTable?: Record<string, number>): [number, string | null] {
    if (!roiTable || Object.keys(roiTable).length === 0) return [0, null];
    // Ordenar thresholds de mayor a menor (ej: ["60","30","0"])
    const thresholds = Object.keys(roiTable)
        .map(k => parseInt(k, 10))
        .sort((a, b) => b - a);
    for (const thresholdMin of thresholds) {
        if (tradeAgeMinutes >= thresholdMin) {
            const roi = roiTable[String(thresholdMin)];
            const label = roi === 0 ? 'breakeven' : `${thresholdMin}m_${(roi * 100).toFixed(1)}%`;
            return [roi, label];
        }
    }
    return [0, null];
}

function computeConfluenceTFs(zones: RadarZone[]): Map<RadarZone, string[]> {
    const byDir = new Map<string, RadarZone[]>();
    for (const z of zones) {
        const list = byDir.get(z.dir) ?? [];
        list.push(z);
        byDir.set(z.dir, list);
    }
    const result = new Map<RadarZone, string[]>();
    for (const group of byDir.values()) {
        for (const zone of group) {
            const tfs: string[] = [];
            for (const other of group) {
                if (other === zone || other.tf === zone.tf) continue;
                if (!(other.top < zone.btm || other.btm > zone.top) && !tfs.includes(other.tf || '')) {
                    tfs.push(other.tf || '');
                }
            }
            result.set(zone, tfs);
        }
    }
    return result;
}
function minutesSinceSessionOpen(ts: number): number {
    const d = new Date(ts - 3 * 3600 * 1000);
    const t = d.getUTCHours() * 60 + d.getUTCMinutes();
    const session = getCurrentSession(ts);
    const openMin = session === 'LONDON' ? 240 : session === 'NY' ? 630 : session === 'ASIA' ? 1260 : -1;
    if (openMin < 0) return Infinity;
    let m = t - openMin; if (m < 0) m += 1440;
    return m;
}

function getCurrentSession(nowMs?: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' {
    const now = nowMs ? new Date(nowMs) : new Date();

    // 📅 Verificar si es fin de semana en Argentina (Sábado o Domingo)
    const dayName = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' });
    if (dayName === 'Sat' || dayName === 'Sun') {
        return 'OFF';
    }

    const arStr = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', minute: 'numeric', hour12: false });
    const [hourStr, minStr] = arStr.split(':');
    const h = parseInt(hourStr);
    const m = parseInt(minStr || '0');
    const t = h + m / 60;
    if (t >= 21 || t < 4) return 'ASIA';
    if (t >= 4 && t < 10.5) return 'LONDON';
    if (t >= 10.5 && t < 17) return 'NY';
    return 'OFF';
}

// 🆕 sep-2026 (Capa 1 del optimizador del motor): multiplicadores por familia de zona
// × sesión (config.zoneWeights, tuneado por el hyperopt). 0 = desactivar la familia en
// esa sesión; default 1 = comportamiento actual. Paridad exacta con backtestEngine.
function zoneWeightMultLive(config: any, family: string, session: string): number {
    const zw = (config as any)?.zoneWeights;
    if (!zw || typeof zw !== 'object') return 1;
    const perFam = zw[family];
    if (!perFam || typeof perFam !== 'object') return 1;
    const v = perFam[session];
    return typeof v === 'number' ? v : 1;
}

// Resuelve la config para un ticker: ticker+session > ticker+ALL > global
function getConfigForTicker(ticker: string, nowMs?: number): typeof globalState.dynamicBotConfig & {
    sessionEnabled: boolean;
    maxSellsPerDay: number;
    sellScorePenalty: number;
    maxBuysPerDay: number;
    buyScorePenalty: number;
    partialClosePct?: number;
    slAfterTp1?: 'midpoint' | 'breakeven' | 'none';
    tp15BeEnabled?: boolean;
    atrTrailEnabled?: boolean;
    structuralTrailEnabled?: boolean;
    tp1StructuralMinRR?: number;
    /** 🆕 ROI time-decay: {"0":0.015,"30":0.005,"60":0} */
    minimal_roi?: Record<string, number>;
    /** 🆕 Límites de riesgo por activo (asset_configs/{ticker}) */
    maxDailyLossR?: number;
    dailyProfitTargetR?: number;
    maxConsecutiveLosses?: number;
    maxTradesPerDay?: number;
    trailingDrawdownR?: number;
    /** 🏇 RIDER mode config */
    riderEnabled?: boolean;
    riderTf?: string;
    /** 🆕 TimesFM F1/F2: bloque de config del filtro (asset_configs/{ticker}.timesfm) */
    timesfm?: any;
    /** 🧲 Filtro de correlación cross-asset EWMA (asset_configs/{ticker}.correlationFilter) */
    correlationFilter?: any;
    /** 🛡️ sep-2026 Paso 1: confluencia de bias por activo (bono de alineación parametrizado) */
    biasConfluence?: BiasConfluenceConfig;
    rolloverEntryBlock?: boolean;
    rolloverPolicy?: RolloverRuntimePolicy;
    mlRegimeShadow?: boolean;
    /** 🆕 T6 (oct-2026): pesos de zona × sesión (hyperopt, 6 familias × 4 sesiones) */
    zoneWeights?: Record<string, Record<string, number>>;
    executionPolicy?: ExecutionPolicyInput;
    executionInstrument?: ExecutionInstrument;
    /** 🆕 T6 (oct-2026): peso VWAP por activo (hyperopt, rango 2-6) */
    vwapPts?: number;
    sessions?: Record<string, {
        choch5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
        choch15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
        bos5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
        bos15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number };
        oteChoch5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
        oteChoch15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
        oteBos5m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
        oteBos15m?: { enabled: boolean; minScore?: number; minScoreBuy?: number; minScoreSell?: number; entryPercent?: number };
        // Legacy fallback keys
        choch?: { enabled: boolean; minScore: number };
        bos?: { enabled: boolean; minScore: number };
        oteChoch?: { enabled: boolean; minScore: number; entryPercent?: number };
        oteBos?: { enabled: boolean; minScore: number; entryPercent?: number };
        maxSellLosses?: number;
        maxBuyLosses?: number;
        slBufferPercent?: number;
        fixedRR?: number;
    }>;
} {
    const session = getCurrentSession(nowMs);

    // 💤 Si la sesión es OFF, ahora se ignora el bloqueo y se asume la configuración por defecto/ALL.

    // El nuevo AdminPanel guarda la configuración directamente bajo el ID del ticker (ej. NAS100)
    // y maneja las sesiones dentro del campo `sessions`.
    const config = globalState.assetSessionConfigs.get(ticker) || globalState.assetSessionConfigs.get(`${ticker}_${session}`) || globalState.assetSessionConfigs.get(`${ticker}_ALL`);

    if (config) {
        console.log(`[CONFIG] 📋 Usando config de: ${ticker}`);
        // 🆕 FIX: el panel exporta la sesión OFF como 'ALL' — fallback para horas fuera de sesión
        const sessionConfig = config.sessions ? ((config.sessions as any)[session] ?? (config.sessions as any)['ALL']) : undefined;
        return {
            ...globalState.dynamicBotConfig,
            minPointsForBuy: config.minPointsForBuy ?? globalState.dynamicBotConfig.minPointsForBuy,
            minPointsForSell: config.minPointsForSell ?? globalState.dynamicBotConfig.minPointsForSell,
            slBufferPercent: sessionConfig?.slBufferPercent ?? config.slBufferPercent ?? globalState.dynamicBotConfig.slBufferPercent,
            fixedRR: sessionConfig?.fixedRR ?? config.fixedRR ?? globalState.dynamicBotConfig.fixedRR,
            oteEntryPercent: config.oteEntryPercent ?? globalState.dynamicBotConfig.oteEntryPercent,
            entryTrigger: config.entryTrigger ?? globalState.dynamicBotConfig.entryTrigger,
            sessionEnabled: (config.enabled ?? true) && !(config as any).disabledReason,
            maxSellsPerDay: config.maxSellsPerDay ?? 0,
            sellScorePenalty: config.sellScorePenalty ?? 0,
            maxBuysPerDay: config.maxBuysPerDay ?? 0,
            buyScorePenalty: config.buyScorePenalty ?? 0,
            rolloverEntryBlock: (config as any).rolloverEntryBlock !== false,
            partialClosePct: config.partialClosePct,
            executionPolicy: config.executionPolicy,
            executionInstrument: validateExecutionInstrument(config.executionInstrument) ? config.executionInstrument : undefined,
            slAfterTp1: config.slAfterTp1,
            tp15BeEnabled: config.tp15BeEnabled,
            atrTrailEnabled: config.atrTrailEnabled,
            structuralTrailEnabled: config.structuralTrailEnabled,
            tp1StructuralMinRR: config.tp1StructuralMinRR,
            minimal_roi: config.minimal_roi as Record<string, number> | undefined,
            maxDailyLossR: (config as any).maxDailyLossR,
            dailyProfitTargetR: (config as any).dailyProfitTargetR,
            maxConsecutiveLosses: (config as any).maxConsecutiveLosses,
            maxTradesPerDay: (config as any).maxTradesPerDay,
            trailingDrawdownR: (config as any).trailingDrawdownR,
            riderEnabled: config.riderEnabled as boolean | undefined,
            riderTf: config.riderTf as string | undefined,
            rolloverPolicy: (config as any).rolloverPolicy,
            mlRegimeShadow: (config as any).mlRegimeShadow,
            timesfm: (config as any).timesfm, // 🆕 F1/F2: filtro direccional TimesFM (asset_configs/{ticker}.timesfm)
            correlationFilter: (config as any).correlationFilter, // 🧲 filtro de correlación cross-asset
            biasConfluence: (config as any).biasConfluence, // 🛡️ sep-2026 Paso 1: confluencia de bias por activo
            zoneWeights: (config as any).zoneWeights, // 🆕 T6: pesos de zona × sesión (hyperopt) — zoneWeightMultLive los lee
            vwapPts: (config as any).vwapPts, // 🆕 T6: peso VWAP por activo (hyperopt) — vwapPtsLive lo lee
            sessions: config.sessions as any
        };
    }

    // Fallback — 🛡️ FAIL-CLOSED: un ticker sin config válida NO opera con defaults.
    return { ...globalState.dynamicBotConfig, sessionEnabled: false, maxSellsPerDay: 0, sellScorePenalty: 0, maxBuysPerDay: 0, buyScorePenalty: 0 };
}

/** Independent telemetry only: legacy12 score/gate/features and sizing are untouched. */
function evaluateLiveRegimeShadow(ticker: string, state: RadarState, signal: any, nowMs: number, cfg: { mlRegimeShadow?: boolean }) {
    if (cfg.mlRegimeShadow !== true) return undefined;
    try {
    const rawTf = String(signal.executionTf ?? signal.tf ?? '').toUpperCase();
    const tf = ({ M3:'3', '3M':'3', M5:'5', '5M':'5', M15:'15', '15M':'15', H1:'60', H4:'240', D1:'D' } as Record<string,string>)[rawTf] ?? rawTf;
    const quote = getLastBidAsk(ticker, nowMs);
    const velocity = tickFlow.getTickVelocitySnapshot(ticker, nowMs);
    const input: RegimeContextInput = { ...state.mlRegimeObservations,
        schema: REGIME_FEATURE_SCHEMA, ticker, tf, direction: signal.direction, nowMs,
        // These are observations made at this actual signal boundary, not invented historical vintages.
        entry: { value: { entryPrice: Number(signal.entryPrice), initialSL: Number(signal.stopLoss) },
            observedAtMs: nowMs, availableAtMs: nowMs, maxAgeMs: 10000, provenance: 'live-signal-initial-stop/v1', source: 'signal-initial-stop' },
        quote: quote ? { value: { bid: quote.bid, ask: quote.ask }, units: 'price', observedAtMs: quote.ts,
            availableAtMs: nowMs, maxAgeMs: 10000, provenance: 'live-broker-quote-read/v1' } : undefined,
        price: quote ? { value: signal.direction === 'BUY' ? quote.ask : quote.bid, observedAtMs: quote.ts,
            availableAtMs: nowMs, maxAgeMs: 10000, provenance: 'live-executable-price-read/v1' } : undefined,
        velocity: velocity && velocity.samples > 50 ? { value: { zScore: velocity.zScore }, observedAtMs: velocity.observedAtMs,
            availableAtMs: velocity.availableAtMs, maxAgeMs: 10000, provenance: 'tickflow-decision-snapshot/v1',
            samples: velocity.samples, baselineVarianceMs2: velocity.baselineVarianceMs2,
            baselineHourUtc: velocity.baselineHourUtc, profile: REGIME_VELOCITY_PROFILE } : undefined,
    };
    return predictRegime(input);
    } catch { return regimeUnavailable('live-shadow-observation-unavailable'); }
}

// 🧠 INICIALIZACIÓN DE LA MEMORIA (Carga los trades de Firebase si el servidor se reinicia)
const unsubscribers: (() => void)[] = [];
// 🛡️ Auditoría T1: aviso único por doc de config inválido (fail-closed)
const invalidConfigNotified = new Set<string>();
const experimentalRuntimeRegistrations = new Map<string, { signature: string; cfg: TimesfmFilterConfig }>();
/** Lifecycle only: never register/invalidate the RAM cache from a signal trigger. */
function configureExperimentalRuntime(ticker: string, asset: any): void {
    const cfg = resolveTimesfmConfig(asset?.timesfm);
    if (asset?.enabled === false || asset?.sessionEnabled === false) cfg.enabled = false;
    const signature = JSON.stringify(cfg);
    const previous = experimentalRuntimeRegistrations.get(ticker);
    if (previous?.signature !== signature) {
        if (previous) for (const tfMinutes of [5, 15])
            configureTimesfmLiveCache({ ticker, tfMinutes, cfg: { ...previous.cfg, enabled: false } });
        for (const tfMinutes of [5, 15]) configureTimesfmLiveCache({ ticker, tfMinutes, cfg });
        experimentalRuntimeRegistrations.set(ticker, { signature, cfg });
    }
    (globalState.smcManager as any)?.configureRolloverPolicy?.(ticker, asset?.rolloverPolicy);
}

if (db) {
    try {
        db.collection('active_trades').get().catch((e: any) => {
            console.error('[RADAR] Active memory unavailable; recovering journal safety:', e.message);
            return null;
        }).then(async (snap: any) => {
            snap?.forEach((doc: any) => {
                const restored = structuredClone(doc.data() as ActiveTrade);
                freezeTradeRiskForTrade(restored);
                globalState.activeTrades.set(doc.id, restored);
                // 🛡️ Regla D: recuperar SL ensanchados del rollover si el bot se reinició en la ventana
                const x = doc.data() as any;
                rehydrateRolloverPending(doc.id, x);
            });
            console.log(`[RADAR] 🧠 Memoria restaurada: ${globalState.activeTrades.size} trades activos cargados.`);
            await loadRolloverJournalPending();
            // Boot only schedules evidence-based recovery; never assumes normal spread.
            if (rolloverDWideMap.size > 0 || rolloverTriageRecords.size > 0) {
                runRolloverCycle(Date.now()).catch((e: any) => console.error('[ROLLOVER] ❌ Recovery post-restart:', e.message));
            }

            // 🏇 Inyectar SMCManager para consultas HTF (RIDER mode y otros usos futuros)
            import('../engine/smc/SMCManager.js').then(({ smcManager }) => {
                globalState.smcManager = smcManager;
                for (const [ticker, asset] of globalState.assetSessionConfigs) configureExperimentalRuntime(ticker, asset);
                console.log('[RIDER] 🏇 SMCManager inyectado en StateStore — RIDER mode disponible.');
            }).catch(() => { /* SMCManager no disponible (modo solo Pine logs) */ });

            // 🧠 Inicializar ML Filter (carga modelo específico del ticker si existe)
            import('../engine/MLFilterNode.js').then(({ initMLFilter }) => {
                initMLFilter();
                console.log('[ML] 🧠 MLFilter inicializado.');
            }).catch(() => { /* MLFilter no disponible */ });
        });

        unsubscribers.push(db.collection('app_settings').doc('global').onSnapshot((snap: any) => {
            if (snap.exists) globalState.globalKillswitches = snap.data()?.killswitches || {};
        }));
        unsubscribers.push(db.collection('app_settings').doc('bot_config').onSnapshot((snap: any) => {
            if (snap.exists) {
                const data = snap.data() || {};
                globalState.dynamicBotConfig = {
                    sniperCooldownMs: Number.isFinite(Number(data.sniperCooldownMs)) ? Number(data.sniperCooldownMs) : globalState.dynamicBotConfig.sniperCooldownMs,
                    minPointsForBuy: Number.isFinite(Number(data.minPointsForBuy)) ? Number(data.minPointsForBuy) : globalState.dynamicBotConfig.minPointsForBuy,
                    minPointsForSell: Number.isFinite(Number(data.minPointsForSell)) ? Number(data.minPointsForSell) : globalState.dynamicBotConfig.minPointsForSell,
                    baseRiskPercentage: Number.isFinite(Number(data.baseRiskPercentage)) ? Number(data.baseRiskPercentage) : globalState.dynamicBotConfig.baseRiskPercentage,
                    slBufferPercent: data.slBufferPercent !== undefined ? Number(data.slBufferPercent) : globalState.dynamicBotConfig.slBufferPercent,
                    fixedRR: data.fixedRR !== undefined ? Number(data.fixedRR) : globalState.dynamicBotConfig.fixedRR,
                    oteEntryPercent: data.oteEntryPercent !== undefined ? Number(data.oteEntryPercent) : globalState.dynamicBotConfig.oteEntryPercent,
                    entryTrigger: data.entryTrigger || globalState.dynamicBotConfig.entryTrigger,
                    autoTrading: data.autoTrading !== undefined ? data.autoTrading : globalState.dynamicBotConfig.autoTrading,
                    maxSmartRiskPercent: data.maxSmartRiskPercent !== undefined ? Number(data.maxSmartRiskPercent) : globalState.dynamicBotConfig.maxSmartRiskPercent
                };
                // 🆕 27-sep-2026: sizing fraccional por sesión (auto-aplicado por apply_weekly).
                (globalState.dynamicBotConfig as any).sizingFactors = (data as any).sizingFactors ?? (globalState.dynamicBotConfig as any).sizingFactors;
            }
        }));

        // 🆕 v6.0: Listener para configs por activo+sesión
        unsubscribers.push(db.collection('asset_configs').onSnapshot((snap: FirebaseFirestore.QuerySnapshot) => {
            const runtimeIds = new Set<string>();
            snap.forEach(doc => {
                runtimeIds.add(doc.id);
                if (doc.id === 'GLOBAL') {
                    const data = doc.data() || {};
                    globalState.globalPortfolioConfig = {
                        maxDailyLossR: Number.isFinite(Number(data.maxDailyLossR)) ? Number(data.maxDailyLossR) : 0,
                        dailyProfitTargetR: Number.isFinite(Number(data.dailyProfitTargetR)) ? Number(data.dailyProfitTargetR) : 0,
                        maxTradesPerDay: Number.isFinite(Number(data.maxTradesPerDay)) ? Number(data.maxTradesPerDay) : 0,
                        maxConsecutiveLosses: Number.isFinite(Number(data.maxConsecutiveLosses)) ? Number(data.maxConsecutiveLosses) : 0,
                        trailingDrawdownR: Number.isFinite(Number(data.trailingDrawdownR)) ? Number(data.trailingDrawdownR) : 0,
                        enabled: data.enabled === true,
                        disabledSessions: Array.isArray(data.disabledSessions) ? data.disabledSessions : []
                    };
                    console.log('[CONFIG] 🧠 Configuración del Portfolio Global cargada:', globalState.globalPortfolioConfig);
                    return;
                }
                const parsed = AssetSessionConfigSchema.safeParse(doc.data());
                if (!parsed.success) {
                    // 🛡️ FAIL-CLOSED: doc inválido → bloquear el activo (antes caía al fallback y operaba con defaults).
                    console.error(`[CONFIG] ❌ asset_configs/${doc.id} INVÁLIDO → activo BLOQUEADO:`, JSON.stringify(parsed.error.format()));
                    globalState.assetSessionConfigs.set(doc.id, {
                        ...((globalState.assetSessionConfigs.get(doc.id) as any) ?? {}),
                        enabled: false,
                        disabledReason: 'CONFIG_INVALID (schema Zod) — ver JARVIS-error.log',
                    } as any);
                    configureExperimentalRuntime(doc.id, { enabled: false });
                    if (!invalidConfigNotified.has(doc.id)) {
                        invalidConfigNotified.add(doc.id);
                        sendTelegramAlert(`🚨 <b>[CONFIG INVÁLIDA] ${doc.id}</b>\nasset_configs/${doc.id} no pasa el schema → activo BLOQUEADO hasta corregirlo.`).catch(() => { });
                    }
                    return;
                }
                const data = parsed.data;
                // Pure validation only: never writes or enables a live profile.
                resolveExecutionPolicy(data.executionPolicy);
                globalState.assetSessionConfigs.set(doc.id, {
                    minPointsForBuy: data.minPointsForBuy || globalState.dynamicBotConfig.minPointsForBuy,
                    minPointsForSell: data.minPointsForSell || globalState.dynamicBotConfig.minPointsForSell,
                    slBufferPercent: data.slBufferPercent !== undefined ? data.slBufferPercent : globalState.dynamicBotConfig.slBufferPercent,
                    fixedRR: data.fixedRR !== undefined ? data.fixedRR : globalState.dynamicBotConfig.fixedRR,
                    oteEntryPercent: data.oteEntryPercent !== undefined ? data.oteEntryPercent : globalState.dynamicBotConfig.oteEntryPercent,
                    entryTrigger: data.entryTrigger || globalState.dynamicBotConfig.entryTrigger,
                    enabled: data.enabled === true, // 🛡️ opt-in explícito: docs sin 'enabled' NO operan
                    maxSellsPerDay: data.maxSellsPerDay || 0,
                    sellScorePenalty: data.sellScorePenalty || 0,
                    maxBuysPerDay: data.maxBuysPerDay || 0,
                    buyScorePenalty: data.buyScorePenalty || 0,
                    partialClosePct: data.partialClosePct,
                    executionPolicy: data.executionPolicy,
                    executionInstrument: data.executionInstrument,
                    slAfterTp1: data.slAfterTp1,
                    tp15BeEnabled: data.tp15BeEnabled,
                    atrTrailEnabled: data.atrTrailEnabled,
                    structuralTrailEnabled: data.structuralTrailEnabled,
                    tp1StructuralMinRR: data.tp1StructuralMinRR,
                    // 🆕 FIX: campos que el panel exporta pero el listener descartaba
                    minimal_roi: data.minimal_roi,
                    maxDailyLossR: data.maxDailyLossR ?? 0,
                    dailyProfitTargetR: data.dailyProfitTargetR ?? 0,
                    maxConsecutiveLosses: data.maxConsecutiveLosses ?? 0,
                    maxTradesPerDay: data.maxTradesPerDay ?? 0,
                    trailingDrawdownR: data.trailingDrawdownR ?? 0,
                    sessions: data.sessions as any,
                    riderEnabled: data.riderEnabled,
                    riderTf: data.riderTf,
                    autoTrading: data.autoTrading,
                    maxSmartRiskPercent: data.maxSmartRiskPercent,
                    rolloverPolicy: (data as any).rolloverPolicy,
                    mlRegimeShadow: (data as any).mlRegimeShadow,
                    timesfm: (data as any).timesfm, // 🆕 F1/F2: el schema es passthrough, pero el listener lo descartaba → el gate nunca veía el filtro
                    correlationFilter: (data as any).correlationFilter, // 🧲 ago-2026: sin esto, asset_configs correlationFilter={shadow:false} NO activa el bloqueo real
                    biasConfluence: (data as any).biasConfluence, // 🛡️ sep-2026 Paso 1: confluencia de bias por activo (bono de alineación)
                    zoneWeights: (data as any).zoneWeights, // 🆕 T6: pesos de zona × sesión (hyperopt) — zoneWeightMultLive los lee
                    vwapPts: (data as any).vwapPts, // 🆕 T6: peso VWAP por activo (hyperopt) — vwapPtsLive lo lee
                    rolloverBeEnabled: (data as any).rolloverBeEnabled !== false, // 🛡️ Regla A (sep-2026): SL→BE pre-rollover, default ON
                    rolloverEntryBlock: (data as any).rolloverEntryBlock !== false, // 🛡️ Regla C (sep-2026): bloquear entradas 20:29-21:30 UTC, default ON
                    disabledReason: (data as any).disabledReason, // 🆕 27-sep-2026: retiro explícito (panel/optimizador) — el roster dinámico lo respeta
                });
                // 🛡️ 16-sep-2026: gate ML por activo en CALIENTE (default OFF — los modelos de
                // 11-ago restan PnL). mlGateEnabled=true en el doc → gate ON en vivo sin restart.
                setMLGateOverride(doc.id, (doc.data() as any).mlGateEnabled === true);
                configureExperimentalRuntime(doc.id, globalState.assetSessionConfigs.get(doc.id));
            });
            // Cancel only the new experimental lifecycle on document removal; do not
            // reinterpret legacy asset fallback/deletion semantics in this transport change.
            for (const ticker of [...experimentalRuntimeRegistrations.keys()]) {
                if (runtimeIds.has(ticker)) continue;
                configureExperimentalRuntime(ticker, { enabled: false });
                experimentalRuntimeRegistrations.delete(ticker);
                const retained = globalState.assetSessionConfigs.get(ticker);
                if (retained) globalState.assetSessionConfigs.set(ticker, { ...retained,
                    rolloverPolicy: undefined, mlRegimeShadow: undefined,
                    timesfm: retained.timesfm && typeof retained.timesfm === 'object' ? { ...retained.timesfm, liveTransport: 'legacy_http' } : undefined });
            }
            // 🛡️ 16-sep-2026: matriz de correlación DINÁMICA — todo activo habilitado entra
            // al set EWMA (incluye promovidos del Asset Scout; sin esto, ρ vs no-core = undefined).
            syncCorrTickers([...globalState.assetSessionConfigs.keys()].filter(k => k !== 'GLOBAL'));
            // 🆕 27-sep-2026: roster dinámico del escáner cTrader — todo activo habilitado
            // (sin retiro explícito vía disabledReason) recibe velas → opera y aparece en la matriz.
            const rosterTickers = [...globalState.assetSessionConfigs.entries()]
                .filter(([k, c]) => k !== 'GLOBAL' && (c as any).enabled === true && !(c as any).disabledReason)
                .map(([k]) => k);
            syncScannerRoster(rosterTickers).catch(e => console.error('[CTRADER] syncScannerRoster:', (e as any)?.message ?? e));
            const actualAssets = [...globalState.assetSessionConfigs.keys()].filter(k => k !== 'GLOBAL');
            console.log(`[CONFIG] 🧠 ${actualAssets.length} configs por activo+sesión cargadas:`, actualAssets.join(', '));
        }));

        const cleanupAndExit = () => {
            console.log('[SHUTDOWN] Limpiando listeners de Firestore en trading.ts...');
            unsubscribers.forEach(unsub => unsub());
            resetTimesfmLiveCache();
        };
        process.on('SIGTERM', cleanupAndExit);
        process.on('SIGINT', cleanupAndExit);
    } catch (e) {
        console.error('[TRADING] Error iniciando listeners de configuración', e);
    }
}



const DEDUP_WINDOW_MS = 60000;
const SYNC_THROTTLE_MS: Record<string, number> = { '5': 0, '15': 90000, '60': 240000, '240': 480000, 'D': 720000 };
// 🆕 FIX P0-4: subido de 10 a 20 min. Con el heartbeat del indicador ahora por tiempo,
// el feed más frecuente (PING/HEARTBEAT de 15m) llega cada ~15 min por cierre de vela;
// 10 min marcaba el ticker como inactivo entre vela y vela.
const HEARTBEAT_TIMEOUT_MS = 20 * 60 * 1000;

function isDuplicate(fingerprint: string, nowMs: number): boolean {
    for (const [key, ts] of globalState.recentAlertCache) {
        if (nowMs - ts > DEDUP_WINDOW_MS) globalState.recentAlertCache.delete(key);
    }
    if (globalState.recentAlertCache.has(fingerprint)) return true;
    globalState.recentAlertCache.set(fingerprint, nowMs);
    return false;
}

const parseTF = (tf: string) => {
    if (tf === 'D') return 'D';
    if (tf === '240') return '4H';
    if (tf === '60') return '1H';
    if (tf === '15') return '15M';
    if (tf === '5') return '5M';
    return `${tf}M`;
};

const getBuffer = (ticker: string, price: number) => (ticker.includes('BTC') || ticker.includes('ETH')) ? price * 0.001 : price * 0.0002;

export const parseTVPrice = (str: string): number => {
    const lastComma = str.lastIndexOf(',');
    const lastDot = str.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
        if (lastComma > lastDot) return parseFloat(str.replace(/\./g, '').replace(',', '.'));
        else return parseFloat(str.replace(/,/g, ''));
    } else if (lastComma > -1) {
        return parseFloat(str.replace(/,/g, '.'));
    }
    return parseFloat(str);
};

async function sendTelegramAlert(message: string) {
    console.log(`[TELEGRAM] Enviando alerta (${message.length} chars) a ${config.TELEGRAM_ALLOWED_USER_IDS.length} usuario(s): [${config.TELEGRAM_ALLOWED_USER_IDS.join(', ')}]`);
    if (message.length > 4096) {
        console.warn(`[TELEGRAM] ⚠️ Mensaje excede 4096 chars (${message.length}). Telegram lo rechazará.`);
        message = message.substring(0, 4090) + '\n...';
    }
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            await bot.api.sendMessage(userId, message, { parse_mode: 'HTML' });
            console.log(`[TELEGRAM] ✅ Mensaje enviado exitosamente a userId=${userId}`);
        } catch (err: any) {
            console.error(`[TELEGRAM] HTML Parse Error (${userId}):`, err.message);
            // Fallback a texto plano eliminando etiquetas si el HTML falla
            const safeText = message.replace(/<[^>]*>?/gm, '');
            try {
                await bot.api.sendMessage(userId, safeText);
                console.log(`[TELEGRAM] ✅ Fallback (texto plano) enviado a userId=${userId}`);
            }
            catch (e: any) { console.error(`[TELEGRAM] Fallback Error (${userId}):`, e.message); }
        }
    }
}



function evaluateImpulse(leg: ImpulseLeg | null | undefined, currentPrice: number, highPrice: number, lowPrice: number, prevHighPrice: number | undefined, prevLowPrice: number | undefined, ticker: string, state: RadarState, nowMs: number, store: StateStore = globalState, isBacktest: boolean = false) {
    const config = getConfigForTicker(ticker, nowMs);
    const rolloverSignal = config.rolloverPolicy?.freezeSignals === true
        ? buildRolloverSignalContext(ticker, nowMs, config.rolloverPolicy, state.rolloverSignalObservation,
            { high: highPrice, low: lowPrice, prevHigh: prevHighPrice, prevLow: prevLowPrice }) : {};
    if (rolloverSignal.rolloverFreeze && shouldFreezeRolloverObservation(rolloverSignal.observationInterval?.startMs ?? NaN,
        rolloverSignal.observationInterval?.endMs ?? NaN, rolloverSignal.rolloverFreeze))
        return { updatedLeg: leg, triggerOte: false, oteData: null };
    const policy = resolveExecutionPolicy(config.executionPolicy);
    const alphaConfig = policy.profile === 'microstructure_v1'
        ? { ...config, executionInstrument: getLiveExecutionInstrument(ticker) ?? (config.executionInstrument?.source === 'explicit_model' ? config.executionInstrument : undefined) } : config;
    const currentSession = getCurrentSession(nowMs);
    const sessionConfig = config.sessions?.[currentSession];
    if (leg && policy.smart && (!leg.executionDecision || leg.executionDecision.mode === 'WAIT_DATA')) {
        const tf = leg.executionSnapshot?.tf ?? leg.chochEvents?.find(e => /_(5|15)M$/.test(e))?.match(/_(5|15)M$/)?.[1];
        const snapshot = tf ? getExecutionSnapshot(state, tf, nowMs) : undefined;
        const quote = snapshot?.quote;
        const price = leg.dir === 'BUY' ? quote?.ask : quote?.bid;
        const buffer = Math.max(calculateDynamicSlBuffer(ticker, leg.origin, sessionConfig?.slBufferPercent ?? config.slBufferPercent), (snapshot?.atr14 ?? NaN) * .5);
        const sl = leg.origin + (leg.dir === 'BUY' ? -buffer : buffer);
        routeExecutionSetup(state, leg, alphaConfig, tf ?? '', nowMs, price ?? NaN, sl, (price ?? NaN) + (leg.dir === 'BUY' ? 1 : -1) * Math.abs((price ?? NaN)-sl) * config.fixedRR);
    }

    const decision = evaluateImpulseCore(leg, currentPrice, highPrice, lowPrice, ticker, state, nowMs, {
        config: alphaConfig, currentSession, sessionConfig, ...rolloverSignal,
        // 🛡️ sep-2026 fix OTE: vela cerrada para estirar el extreme (paridad live↔backtest)
        prevHigh: prevHighPrice, prevLow: prevLowPrice,
    });

    if (decision.newTrade) {
        // 🔥 ESCUDO: Evaluar el trade contra el Modelo de Fricción (Prop Firm)
        const frictionEval = policy.profile === 'microstructure_v1'
            ? { approved: true, netTrade: decision.newTrade, frictionCostDetails: 'Actual executable quote; entry spread/slip already in fill' }
            : evaluateNetTrade(decision.newTrade, nowMs);

        if (!frictionEval.approved) {
            console.log(`[FRICTION] 🛡️ Trade RECHAZADO en ${ticker}: ${frictionEval.reason}`);
            // Cancelar el gatillo de OTE
            decision.triggerOte = false;
            decision.oteData = null;
        } else {
            const netTrade = frictionEval.netTrade;
            if (frictionEval.frictionCostDetails) {
                console.log(`[FRICTION] ✅ Trade Aprobado en ${ticker}. Detalles: ${frictionEval.frictionCostDetails}`);
            }

            // 💾 Sincronización en RAM y Firebase del trade modificado por fricción
            (netTrade as any).isBacktest = isBacktest;
            // New pre-trade only, never infer this for hydrated/adopted positions.
            const capturedTrade = { ...netTrade, initialSlPrice: netTrade.initialSlPrice ?? netTrade.slPrice };
            store.activeTrades.set(netTrade.tradeId, capturedTrade);
            // 🛡️ T1: NO persistir el pre-trade (carrera con los delete() de dispatchOteSignal → fantasmas en Firestore).
            // El camino exitoso persiste en dispatchOteSignal antes de ejecutar.
        }
    }

    return { updatedLeg: decision.updatedLeg, triggerOte: decision.triggerOte, oteData: decision.oteData };
}

/**
 * Evalúa los límites del Killswitch Global de la Cuenta (Consolidación de Cuenta)
 * consultando los resultados cerrados del día de hoy en 'trade_journal'.
 * Retorna true si hay un bloqueo activo (cuenta deshabilitada temporalmente para operar hoy).
 */
async function evaluateGlobalKillswitch(nowMs: number, store: any, isBacktest: boolean = false): Promise<boolean> {
    if (isBacktest) return false;
    const currentSession = getCurrentSession(nowMs);
    const res = await evaluateGlobalRisk(nowMs, store.globalPortfolioConfig, store.globalPortfolioKillswitchUntil, currentSession, db);

    if (res.isKilled) {
        if (res.killUntilMs && res.killUntilMs > store.globalPortfolioKillswitchUntil) {
            store.globalPortfolioKillswitchUntil = res.killUntilMs;
            const timeStr = new Date(res.killUntilMs).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
            const warningMsg = `🚨 <b>[KILLSWITCH PORTAFOLIO GLOBAL]</b> 🚨\n\n` +
                `⚠️ <b>Cuenta Bloqueada Temporalmente</b>\n` +
                `📋 <b>Causa:</b> ${res.killReason}\n` +
                `⏳ <b>Duración:</b> Hasta el final del día de hoy (reseteo a medianoche ART - aprox ${timeStr})\n\n` +
                `💡 <i>Las alertas en vivo Sniper OTE se filtrarán automáticamente y no se enviarán a ejecución para proteger el balance de la cuenta consolidada.</i>`;

            sendTelegramAlert(warningMsg).catch(() => { });
            console.log(`[KILLSWITCH GLOBAL] ⛔ Cuenta bloqueada. Causa: ${res.killReason}`);
        }
        return true;
    }
    return false;
}

// 🆕 Throttle de notificaciones de killswitch por activo (1 aviso/hora por ticker)
const assetKillNotified = new Map<string, number>();

/**
 * 🆕 Killswitch POR ACTIVO: enforce de maxDailyLossR / dailyProfitTargetR / maxTradesPerDay /
 * maxConsecutiveLosses / trailingDrawdownR configurados en asset_configs/{ticker}.
 */
async function evaluateAssetKillswitch(ticker: string, nowMs: number, store: any, isBacktest: boolean = false): Promise<boolean> {
    if (isBacktest) return false;
    const cfg = getConfigForTicker(ticker, nowMs);
    const limits = {
        maxDailyLossR: cfg.maxDailyLossR,
        dailyProfitTargetR: cfg.dailyProfitTargetR,
        maxTradesPerDay: cfg.maxTradesPerDay,
        maxConsecutiveLosses: cfg.maxConsecutiveLosses,
        trailingDrawdownR: cfg.trailingDrawdownR,
    };
    const res = await evaluateAssetRisk(db, ticker, nowMs, limits, store.globalPortfolioConfig?.assumedWinR ?? 1.5);
    if (res.isKilled) {
        const lastNotif = assetKillNotified.get(ticker) ?? 0;
        if (nowMs - lastNotif > 60 * 60 * 1000) {
            assetKillNotified.set(ticker, nowMs);
            const msg = `🚨 <b>[KILLSWITCH ACTIVO: ${ticker}]</b> 🚨\n\n` +
                `⚠️ <b>Activo bloqueado hasta el fin del día (reseteo medianoche ART)</b>\n` +
                `📋 <b>Causa:</b> ${res.killReason}\n\n` +
                `💡 <i>Límite configurado en asset_configs/${ticker}. Las señales de este activo se ignorarán hoy.</i>`;
            sendTelegramAlert(msg).catch(() => { });
        }
        console.log(`[KILLSWITCH ${ticker}] ⛔ Activo bloqueado. Causa: ${res.killReason}`);
        return true;
    }
    return false;
}
async function countDailySellsForTicker(ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    return await pmCountDailySells(db, ticker, nowMs, isBacktest, backtestSessionId);
}

/**
 * 🆕 v7.2: Cuenta los trades BUY ejecutados hoy para un ticker específico.
 */
async function countDailyBuysForTicker(ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    return await pmCountDailyBuys(db, ticker, nowMs, isBacktest, backtestSessionId);
}

/**
 * Cuenta las pérdidas consecutivas de un activo en la sesión y dirección actual para el día de hoy.
 */
async function countConsecutiveLosses(ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, store: StateStore, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    return await countConsecutiveLossesForAsset(db, ticker, session, direction, nowMs, store.globalPortfolioConfig, isBacktest, backtestSessionId);
}

export async function processTradingAlert(alertText: string, store: StateStore = globalState) {
    if (!db) return;
    const executionEnvelope = alertText;
    // Strip even malformed metadata BEFORE bootstrap, direction, scoring, payload or TS parsing.
    alertText = alertText.replace(/\s*\|\s*EX1:\s*.*$/, '');

    // 🔄 BOOTSTRAP: eventos históricos del arranque construyen estado (puntos, OTE, sesgos)
    // pero NO ejecutan trades, NO envían Telegram, NO loguean al journal.
    const isBootstrap = alertText.includes('| BOOTSTRAP');
    if (isBootstrap) alertText = alertText.replace(/\s*\|\s*BOOTSTRAP/g, '');

    const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
    const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());

    if (parts.length < 2) return;

    const prefix = parts[0].toUpperCase();
    const ticker = parts[1].replace(/"/g, '');
    const upperText = alertText.toUpperCase();

    // 🛡️ v5.4: Lock por ticker — evita race conditions que causan alertas duplicadas
    // Al moverlo aquí arriba prevenimos el TOCTOU de ordenamiento en el backtester 
    // causado por el yield del event loop en el `await import`.
    const previousLock = store.tickerLocks.get(ticker) || Promise.resolve();
    let releaseLock: (() => void) | undefined;
    const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
    store.tickerLocks.set(ticker, newLock);

    // 🧹 Limpieza: borrar el lock del mapa si no ha sido sobrescrito
    newLock.finally(() => {
        if (store.tickerLocks.get(ticker) === newLock) {
            store.tickerLocks.delete(ticker);
        }
    });

    await previousLock; // Esperar procesamiento anterior de este ticker

    // 🕒 El Bypass Temporal (Bar Replay Histórico)
    const tsMatch = alertText.match(/TS:\s*([0-9]+)/i);
    const nowMs = tsMatch ? parseInt(tsMatch[1], 10) : Date.now();

    // Intentar extraer TF del texto de la alerta (ej. 'TF: 5' o 'TF: 15')
    const tfMatchForTolerance = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
    const rawTf = tfMatchForTolerance ? tfMatchForTolerance[1] : '';
    const parsedTf = rawTf ? parseTF(rawTf) : ''; // Ej: '5M', '15M', '1H', etc.

    let tfToleranceMs = 43200000; // 12 horas por defecto (evita falsos positivos de backtest en TFs altos si falta 'TF:')
    // Buscar coincidencia en la temporalidad parseada o en el prefix
    const tfStringToMatch = parsedTf || prefix;
    const tfPrefixMatch = tfStringToMatch.match(/(1M|3M|5M|15M|30M|1H|4H|D|1D|1W)/i);

    if (tfPrefixMatch) {
        const tf = tfPrefixMatch[1].toUpperCase();
        if (tf === '1M') tfToleranceMs = 1 * 60000 + 300000;
        else if (tf === '3M') tfToleranceMs = 3 * 60000 + 300000;
        else if (tf === '5M') tfToleranceMs = 5 * 60000 + 300000;
        else if (tf === '15M') tfToleranceMs = 15 * 60000 + 300000;
        else if (tf === '30M') tfToleranceMs = 30 * 60000 + 300000;
        else if (tf === '1H') tfToleranceMs = 60 * 60000 + 300000;
        else if (tf === '4H') tfToleranceMs = 240 * 60000 + 300000;
        else if (tf === '1D') tfToleranceMs = 1440 * 60000 + 300000;
        else if (tf === 'D') tfToleranceMs = 1440 * 60000 + 300000;
        else if (tf === '1W') tfToleranceMs = 10080 * 60000 + 300000;
    }

    const isBacktest = tsMatch !== null && Math.abs(Date.now() - nowMs) > tfToleranceMs;

    let sessionThresholds: { buy: number; sell: number } | null = null;
    if (isBacktest) {
        const { getCurrentSessionThresholds } = await import('../services/backtesting.js');
        sessionThresholds = getCurrentSessionThresholds();
    }

    // 🧠 FASE 1 - MACHINE LEARNING: Guardar la señal cruda para la Fase 2 (Auto-Tune)
    if (!isBacktest && !isBootstrap) { // Solo guardamos las señales reales en vivo
        scheduleRawSignalSave({
            timestamp: nowMs,
            alertText,
            createdAt: new Date(nowMs).toISOString()
        });
    }

    // 🤖 v6.0: Verificación de Apagado Maestro (Master Killswitch)
    if (store.globalKillswitches['GLOBAL_SYSTEM']) {
        if (ticker === 'BTCUSD' && !store.globalKillswitches['BTCUSD']) {
            console.log(`[RADAR] 🤖 Master Killswitch activo, pero permitiendo BTCUSD de forma excepcional.`);
        } else {
            console.log(`[RADAR] 🚫 Alerta para ${ticker} ignorada debido a que el BOT GLOBAL está APAGADO.`);
            releaseLock!(); // 🛡️ T1: sin esto el lock del ticker queda colgado (deadlock hasta restart)
            return;
        }
    } else if (store.globalKillswitches[ticker]) {
        console.log(`[RADAR] 🚫 Alerta para ${ticker} ignorada por killswitch individual activo.`);
        releaseLock!(); // 🛡️ T1: sin esto el lock del ticker queda colgado (deadlock hasta restart)
        return;
    }


    // 🔧 v5.5: SOLO tickers reales (no prefijos de eventos como HEARTBEAT, EVENTO_CHOCH...)
    // Los prefijos de eventos llegan porque TradingView usa el prefijo como "ticker" en algunas alertas.
    const FAKE_TICKERS = new Set(['HEARTBEAT', 'EVENTO_CHOCH', 'EVENTO_BOS', 'SWEEP_BROKEN',
        'DIV_BROKEN', 'EVENTO_SMC_DIV', 'EVENTO_SWEEP', 'EVENTO_SWEEP_TL',
        'EVENTO_SWEEP_SCALP', 'SYNC_ZONES', 'PING_PRICE', 'LIQ_GRAB']);
    if (!FAKE_TICKERS.has(ticker)) {
        store.tickerLastSeen.set(ticker, nowMs);
    }

    const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
    const eventTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
    const readableTf = parseTF(eventTf);

    let currentDirection: 'BUY' | 'SELL' | null = null;
    if (upperText.includes('BUY') || upperText.includes('BULLISH') || upperText.includes('COMPRA')) currentDirection = 'BUY';
    else if (upperText.includes('SELL') || upperText.includes('BEARISH') || upperText.includes('VENTA')) currentDirection = 'SELL';

    const isClimaxCandle = alertText.includes('Vol: CLIMAX');

    const safeSet = (data: any, options?: any) => {
        if (isBacktest || isBootstrap) return Promise.resolve();
        scheduleStateSave(ticker, data);
        return Promise.resolve();
    };
    // Anclar el día de trading al cierre de NY (17:00 New York, convención FX/prop-firm), DST-aware:
    const todayStr = new Date(getFxDayStartMs(nowMs)).toISOString().split('T')[0];

    let triggerOte = false;
    let oteData: any = null;
    let dispatchData: any = null;
    let state: any = null;

    try {
        // 🔥 Reemplazo completo de la Transacción por Memoria RAM Local 🔥
        triggerOte = false;
        oteData = null;

        // 1. LEER DE LA RAM (Ultra rápido y sin costo de base de datos)
        state = store.localRadarStates.get(ticker);

        // Si el servidor se reinició y la RAM está vacía, leer de archivo JSON local
        if (!state) {
            try {
                const filePath = `radar_states_${ticker}.json`;
                if (fs.existsSync(filePath)) {
                    state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                }
            } catch (e: any) { /* archivo no existe o corrupto */ }
            if (!state) state = emptyState();
            store.localRadarStates.set(ticker, state);
        }
        const incomingConfig = getConfigForTicker(ticker, nowMs);
        const incomingPolicy = resolveExecutionPolicy(incomingConfig.executionPolicy);
        // Root policy governs new entries; an already-frozen live position still needs
        // its own closed-bar/ATR context after the root returns to legacy.
        const needsExecutionContext = incomingPolicy.profile === 'microstructure_v1' || incomingConfig.rolloverPolicy?.freezeSignals === true
            || incomingConfig.mlRegimeShadow === true || [...store.activeTrades.values()].some(trade =>
            trade.ticker === ticker && !trade.isBacktest && trade.executionState?.schema === 1
            && trade.executionState.profile === 'microstructure_v1' && trade.executionPolicy?.profile === 'microstructure_v1'
            && (trade.executionPolicy.management || trade.executionPolicy.trailing));
        const parsedExecution = needsExecutionContext ? parseExecutionEnvelope(executionEnvelope, nowMs) : { text: alertText, observation: undefined };
        if (prefix === 'PING_PRICE') state.rolloverSignalObservation = undefined;
        if (parsedExecution.observation?.ticker === ticker) {
            const result = ingestExecutionContext(state, parsedExecution.observation, nowMs);
            if (result.accepted && prefix === 'PING_PRICE') state.rolloverSignalObservation = structuredClone(parsedExecution.observation);
            if (!result.accepted) console.warn(`[EXECUTION] ${ticker}: ${result.reason}`);
        }

        if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
        if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
        if (!state.marketBias) state.marketBias = emptyState().marketBias;

        // 🧹 GC por TTL por timeframe (sustituye al reset de 48h): caduca eventos viejos
        // y descarta entradas legacy inválidas (strings del formato antiguo en Firebase)
        gcScore(state.scoreBuy, nowMs);
        gcScore(state.scoreSell, nowMs);

        if (prefix === 'SYNC_ZONES') {
            if (!alertText.includes('Payload:')) return;
            const sourceTf = eventTf;

            const syncKey = `${ticker}_${sourceTf}`;
            const lastSync = store.lastSyncTime.get(syncKey) || 0;
            const throttleMs = SYNC_THROTTLE_MS[sourceTf] || 60000;
            if (nowMs - lastSync < throttleMs) {
                console.log(`[SYNC] ⏭️ SYNC_ZONES throttled para ${ticker} ${sourceTf} (último: hace ${Math.round((nowMs - lastSync) / 1000)}s, límite: ${throttleMs / 1000}s)`);
                return;
            }
            store.lastSyncTime.set(syncKey, nowMs);

            const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
            const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
            if (trendMatch) {
                state.marketBias[sourceTf] = trendMatch[1].toUpperCase() as 'BUY' | 'SELL';
                // 🆕 sep-2026: registrar el momento del cambio de bias (para smartBiasFreshGuard)
                if (!state.biasTs) state.biasTs = {};
                state.biasTs[sourceTf] = nowMs;
            }

            try {
                const rawZones = JSON.parse(payloadStr) as any[];
                const parsedZones: RadarZone[] = rawZones.map(normalizeZone).filter(z => z.top !== undefined && z.btm !== undefined && z.dir !== undefined);
                parsedZones.forEach(z => { z.tf = sourceTf; z.createdAt = nowMs; });

                if (state.lastSyncDate !== todayStr) {
                    state.zones = [];
                    state.zoneConfluence = computeConfluenceTFs(state.zones);
                    state.activeLocks = [];
                    state.lastSyncDate = todayStr;
                }
                state.zones = state.zones.filter((z: any) => z.tf !== sourceTf);
                state.zones.push(...parsedZones);
                state.zoneConfluence = computeConfluenceTFs(state.zones);
            } catch (e) { }
        }
        else if (prefix === 'PING_PRICE') {
            const priceMatch = alertText.match(/Precio:\s*([0-9.,]+)/i);
            if (!priceMatch) return;

            const zUpMatch = alertText.match(/Z-Up:\s*(-?[\d.]+)/i);
            const zDnMatch = alertText.match(/Z-Dn:\s*(-?[\d.]+)/i);
            if (zUpMatch) state.zUp = parseFloat(zUpMatch[1]);
            if (zDnMatch) state.zDn = parseFloat(zDnMatch[1]);

            const currentPrice = parseTVPrice(priceMatch[1]);
            const highMatch = alertText.match(/High:\s*([0-9.,]+)/i);
            const lowMatch = alertText.match(/Low:\s*([0-9.,]+)/i);
            const highPrice = highMatch ? parseTVPrice(highMatch[1]) : currentPrice;
            const lowPrice = lowMatch ? parseTVPrice(lowMatch[1]) : currentPrice;
            // 🛡️ sep-2026 fix OTE: high/low de la última vela CERRADA (estiramiento del
            // extreme con vela cerrada, paridad live↔backtest). Opcional (backtest no los trae).
            const prevHighMatch = alertText.match(/PrevHigh:\s*([0-9.,]+)/i);
            const prevLowMatch = alertText.match(/PrevLow:\s*([0-9.,]+)/i);
            const prevHighPrice = prevHighMatch ? parseTVPrice(prevHighMatch[1]) : undefined;
            const prevLowPrice = prevLowMatch ? parseTVPrice(prevLowMatch[1]) : undefined;
            // 🆕 sep-2026 climax por rango: guardar high/low de la última vela CERRADA (paridad backtest)
            if (prevHighPrice !== undefined) state.prevClosedHigh = prevHighPrice;
            if (prevLowPrice !== undefined) state.prevClosedLow = prevLowPrice;

            // 🔧 FIX: Guardar precio anterior ANTES de actualizar para detectar dirección de entrada
            const previousPrice = state.lastPrice;

            const prevClose = previousPrice ?? currentPrice;
            const tr = Math.max(highPrice - lowPrice, Math.abs(highPrice - prevClose), Math.abs(lowPrice - prevClose));
            if (state.atr14 === undefined) {
                state.atrSeed = (state.atrSeed ?? 0) + tr;
                state.atrSamples = (state.atrSamples ?? 0) + 1;
                if (state.atrSamples >= 14) state.atr14 = state.atrSeed / 14; // SMA de arranque
            } else {
                state.atr14 = (state.atr14 * 13 + tr) / 14; // suavizado de Wilder
            }

            // Actualizar después de guardar la referencia
            state.lastPrice = currentPrice;
            store.lastPingTime = nowMs; // 🏥 Healthcheck
            // Guardar también el precio previo para referencia en el siguiente tick
            (state as any).previousPrice = previousPrice;

            // 🛡️ CRÍTICO: Verificar killswitches ANTES de evaluateImpulse() para evitar trades huérfanos
            const config = getConfigForTicker(ticker, nowMs);
            // 🌊 TickFlow: spread anómalo (noticia/iliquidez) bloquea evaluación de entradas
            const spreadAnomalous = tickFlow.isSpreadAnomalous(ticker);
            const isKillswitched = spreadAnomalous || nowMs < store.streakKillswitchUntil || nowMs < store.vixKillswitchUntil || !config.sessionEnabled;

            // 🧹 Clear stale lastGatillo (older than 24h) to avoid infinite TTL in the UI
            if (state.lastGatillo && nowMs - state.lastGatillo.time > 24 * 60 * 60 * 1000) {
                state.lastGatillo = undefined;
            }

            // ⚙️ Gestión de trades configurada por activo (asset_configs en Firestore).
            // Defaults = comportamiento histórico (parcial 50%, SL al 50% del riesgo, TP1.5 y trail ATR activos).

            if (!isKillswitched) {
                const macroRollover = config.rolloverPolicy?.freezeSignals === true
                    ? buildRolloverSignalContext(ticker, nowMs, config.rolloverPolicy, state.rolloverSignalObservation,
                        { high: highPrice, low: lowPrice, prevHigh: prevHighPrice, prevLow: prevLowPrice }) : {};
                // 🗺️ Estirar patas Macro si están activas
                if (state.activeMacroImpulseBuy) {
                    state.activeMacroImpulseBuy = evaluateMacroStretching(state.activeMacroImpulseBuy, highPrice, lowPrice, nowMs, macroRollover.rolloverFreeze, macroRollover.observationInterval);
                }
                if (state.activeMacroImpulseSell) {
                    state.activeMacroImpulseSell = evaluateMacroStretching(state.activeMacroImpulseSell, highPrice, lowPrice, nowMs, macroRollover.rolloverFreeze, macroRollover.observationInterval);
                }

                const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, prevHighPrice, prevLowPrice, ticker, state, nowMs, store, isBacktest);
                state.activeImpulseBuy = buyRes.updatedLeg;
                if (buyRes.triggerOte) { triggerOte = true; oteData = buyRes.oteData; console.log(`[SNIPER] 🔫 evaluateImpulse BUY → triggerOte=true para ${ticker}`); }

                const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, prevHighPrice, prevLowPrice, ticker, state, nowMs, store, isBacktest);
                state.activeImpulseSell = sellRes.updatedLeg;
                if (sellRes.triggerOte) { triggerOte = true; oteData = sellRes.oteData; console.log(`[SNIPER] 🔫 evaluateImpulse SELL → triggerOte=true para ${ticker}`); }
            }

            // =========================================================
            // GESTIÓN DE TRADES ACTIVOS (TP Y SL)
            // =========================================================
            if (store.activeTrades.size > 0) {
                for (const [tradeId, trade] of store.activeTrades) {
                    if (trade.ticker !== ticker) continue;
                    if (!!(trade as any).isBacktest !== isBacktest) continue;
                    // Accounting retries do not depend on a new TP/SL price touch and precede fill-management holds.
                    if (!isBacktest && (trade as any).closeAccountingPending && trade.ctraderPositionId) {
                        try {
                            const broker = await import('../services/ctrader.js');
                            const positions = await broker.getOpenPositions(ticker);
                            if (!Array.isArray(positions)) continue;
                            if (!positions.some((p: any) => String(p.positionId) === String(trade.ctraderPositionId))) {
                                await completeLiveTradeClose(trade, store, { reconciled: true });
                                continue;
                            }
                            // An entry/accounting incident is not evidence that this live position closed.
                            (trade as any).brokerCloseConfirmed = false;
                        } catch (error: any) { console.warn(`[ACCOUNTING] ${tradeId}: retry read unavailable: ${error.message}`); continue; }
                    }
                    if ((trade as any).executionFillUnverified) continue; // new fill without verified immutable denominator is never adopted as legacy
                    if (!isBacktest && !trade.ctraderPositionId) continue; // A pending approval is not a simulated live position.
                    const nowTrade = nowMs;
                    const versionedExecution = trade.executionState?.schema === 1 && trade.executionPolicy?.profile === 'microstructure_v1';
                    const executionStages = versionedExecution && (trade.executionPolicy!.management || trade.executionPolicy!.trailing);
                    if (versionedExecution && !isBacktest && trade.ctraderPositionId) {
                        await runNormalStopMutation(tradeId, trade, async () => {
                            const broker = await import('../services/ctrader.js');
                            const tf = (trade as any).executionTf;
                            const snapshot = tf ? getExecutionSnapshot(state, tf, nowMs) : undefined;
                            const liveQuote = () => { const q = getLastBidAsk(ticker, Date.now()); return q ? { bid: q.bid, ask: q.ask, timestampMs: q.ts, source: 'broker' as const } : undefined; };
                            const profilePartial = trade.executionPolicy!.targets ? REGIME_PROFILES[trade.executionInstrument!.regime].partialClosePct
                                : (trade.mgmtOverrides?.partialClosePct ?? config.partialClosePct ?? .5);
                            const reason = await manageExecutionPosition(trade, snapshot, nowMs, profilePartial, {
                                now: () => Date.now(), quote: liveQuote,
                                rolloverBlocked: () => {
                                    const cal = getRolloverCalendar(ticker, Date.now());
                                    return !rolloverJournalRecoveryReady || !cal.metadataAvailable || !cal.marketOpen || cal.protectionWindow || cal.widenWindow || cal.entryWindow || rolloverDWideMap.has(tradeId);
                                },
                                accounting: async () => {
                                    const lots = Number((trade as any).executionLots);
                                    const positions = await broker.getOpenPositions(ticker);
                                    const p = positions.find((p: any) => String(p.positionId) === String(trade.ctraderPositionId));
                                    const volume = Number(p?.tradeData?.volume);
                                    const deals = await broker.getDealsByPosition(trade.ctraderPositionId!);
                                    const openingVolume = deals.filter((d: any) => !d.closePositionDetail).reduce((sum: number, d: any) => sum + Number(d.filledVolume ?? 0), 0);
                                    if (!(lots > 0 && openingVolume > 0 && volume > 0 && volume <= openingVolume)) return undefined;
                                    const currency = broker.getAccountCurrency();
                                    const direct = getLastBidAsk(currency+'USD', Date.now()), inverse = getLastBidAsk('USD'+currency, Date.now());
                                    const fresh = (q: {bid:number;ask:number;ts:number}|null|undefined) => !!q && Number.isFinite(q.bid) && q.bid>0 && q.ask>=q.bid && Date.now()>=q.ts && Date.now()-q.ts<=10000;
                                    const usdRate = currency === 'USD' ? 1 : fresh(direct) ? direct!.bid : fresh(inverse) ? 1/inverse!.bid : undefined;
                                    if (!usdRate) return undefined;
                                    const paidCostsUsd = deals.filter((d: any) => d.closePositionDetail).reduce((sum: number, d: any) => {
                                        const cp = d.closePositionDetail;
                                        return sum + Math.max(0, -Number(cp.commission ?? 0)) / Math.pow(10, Number(cp.moneyDigits ?? d.moneyDigits ?? 2)) * usdRate;
                                    }, 0);
                                    // Entry spread/slip is paid in the actual fill. Pending commission defaults ONE side.
                                    return { instrument: trade.executionInstrument!, lots, remainingLots: lots * volume / openingVolume, paidCostsUsd,
                                        ...(p.swap != null ? { accruedSwapUsd: Number(p.swap) / Math.pow(10, Number(p.moneyDigits ?? 2)) * usdRate } : {}) };
                                },
                                partial: async pct => {
                                    const ok = await broker.closePartial(trade.ctraderPositionId!, pct);
                                    if (ok) {
                                        const deal = await broker.getLastCloseDealForPosition(trade.ctraderPositionId!);
                                        if (deal && db) {
                                            const fields = { tp1PartialAt: Date.now(), tp1PartialPrice: deal.executionPrice, tp1PartialPnlUsd: deal.grossProfit };
                                            await db.collection('active_trades').doc(tradeId).update(fields);
                                            if (trade.journalId) await db.collection('trade_journal').doc(trade.journalId).update(fields);
                                        }
                                    }
                                    return ok;
                                },
                                readProtection: () => broker.readPositionProtection(trade.ctraderPositionId!),
                                amend: (sl, before) => broker.modifyStopLoss(trade.ctraderPositionId!, sl, undefined, before),
                                persist: async fields => {
                                    if (!db) throw new Error('EXECUTION_PERSIST_UNAVAILABLE');
                                    if (trade.journalId) await db.collection('trade_journal').doc(trade.journalId).update(fields);
                                    await db.collection('active_trades').doc(tradeId).update(fields);
                                }
                            });
                            (trade as any).executionHoldReason = reason;
                        }).catch(e => console.warn(`[EXECUTION] ${ticker}: ${e.message}`));
                    }

                    // 🛡️ v5.4: Anti-instantáneo — no evaluar TP/SL si el trade se creó hace < 5s
                    // Evita que un trade se cierre en el mismo ciclo que se abrió (falsos TP1)
                    const tradeAgeMs = nowTrade - trade.timestamp;
                    if (tradeAgeMs < 5000) {
                        console.log(`[TRADE] ⏭️ ${ticker} #${tradeId}: omitiendo eval TP/SL (antigüedad ${tradeAgeMs}ms < 5s)`);
                        continue;
                    }

                    // 🆕 Overrides por gatillo (auto-tune): congelados en el trade al entrar; fallback a config raíz
                    const mgmtPartialT = versionedExecution && trade.executionPolicy!.targets && trade.executionInstrument
                        ? REGIME_PROFILES[trade.executionInstrument.regime].partialClosePct : Math.min(Math.max(trade.mgmtOverrides?.partialClosePct ?? config.partialClosePct ?? 0.5, 0), 1);
                    const mgmtSlModeT: 'midpoint' | 'breakeven' | 'none' = trade.mgmtOverrides?.slAfterTp1 ?? config.slAfterTp1 ?? 'midpoint';
                    const mgmtTp15T = trade.mgmtOverrides?.tp15BeEnabled ?? config.tp15BeEnabled ?? true;
                    const mgmtAtrTrailT = trade.mgmtOverrides?.atrTrailEnabled ?? config.atrTrailEnabled ?? true;

                    // 🆕 ROI TIME-DECAY: si el trade pierde momentum, bajar expectativa de ganancia
                    // según la tabla minimal_roi del activo/sesión. Inspirado en Freqtrade.
                    const roiTable = trade.mgmtOverrides?.minimal_roi ?? config.minimal_roi;
                    if (roiTable && Object.keys(roiTable).length > 0 && !trade.tp1Hit) {
                        const tradeAgeMin = tradeAgeMs / 60000;
                        const [effectiveROI, roiLabel] = getEffectiveROI(tradeAgeMin, roiTable);
                        if (effectiveROI > 0 && roiLabel) {
                            // ROI > 0: si el PnL flotante YA supera el umbral degradado, cerrar como WIN
                            const currentPnlPct = trade.direction === 'BUY'
                                ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
                                : (trade.entryPrice - currentPrice) / trade.entryPrice * 100;
                            if (currentPnlPct >= effectiveROI * 100) {
                                if (isDuplicate(`ROI_${trade.tradeId}_${ticker}`, nowTrade)) continue;
                                // 🛡️ T1: en vivo cerrar en cTrader ANTES de marcar WIN (sin esto la posición
                                // quedaba viva sin gestor y el journal registraba un WIN falso).
                                if (!isBacktest) {
                                    if (trade.ctraderPositionId && !(trade as any).brokerCloseConfirmed) {
                                        const { closePosition } = await import('../services/ctrader.js');
                                        const ok = await closePosition(String(trade.ctraderPositionId));
                                        if (!ok) continue;
                                    }
                                    if (await completeLiveTradeClose(trade, store, { roiDecayApplied: roiLabel, durationMin: Math.round(tradeAgeMs / 60000) })) {
                                        sendTelegramAlert(`✅ ROI ${ticker} #${tradeId}: cierre confirmado con contabilidad real del broker.`).catch(() => {});
                                    }
                                    continue;
                                }
                                store.activeTrades.delete(tradeId);
                                if (db && !trade.isBacktest) db.collection('active_trades').doc(tradeId).delete().catch(() => { });
                                trade.roiDecayApplied = roiLabel;
                                const durationMin = Math.round(tradeAgeMs / 60000);
                                const originalSl = trade.originalSlPrice ?? trade.slPrice;
                                const slDistPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                                const rMultiple = slDistPct > 0 ? parseFloat((currentPnlPct / slDistPct).toFixed(4)) : 0;
                                if (trade.journalId) {
                                    const { db: fireDb } = await import('./memory.js');
                                    if (fireDb && !trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        result: 'WIN', pnl: parseFloat(currentPnlPct.toFixed(2)), rMultiple,
                                        durationMin, roiDecayApplied: roiLabel,
                                    }).catch(() => { });
                                }
                                const roiMsg = `⏱️ <b>ROI TIME-DECAY | ${ticker} | ${trade.direction}</b>\n\n`
                                    + `📥 Entrada: ${trade.entryPrice}\n`
                                    + `💰 PnL: +${currentPnlPct.toFixed(2)}% (umbral ROI: ≥${(effectiveROI).toFixed(2)}%)\n`
                                    + `⏱️ Duración: ${durationMin}min\n`
                                    + `🏷️ ROI aplicado: ${roiLabel}\n\n`
                                    + `💡 El trade alcanzó el objetivo degradado por tiempo.`;
                                if (!isBacktest) sendTelegramAlert(roiMsg).catch(() => { });
                                console.log(`[ROI] ⏱️ ${ticker} ${trade.direction} #${tradeId}: ROI exit (${roiLabel}) PnL=+${currentPnlPct.toFixed(2)}%`);
                                continue;
                            }
                        } else if (effectiveROI === 0 && !trade.roiDecayApplied && !executionStages) {
                            // ROI = 0 (breakeven): ajustar SL con buffer de fricción para que el cierre real quede ≈ 0
                            trade.roiDecayApplied = 'breakeven';
                            const beSl = breakevenBufferPrice(ticker, trade.entryPrice, trade.direction);
                            // 🛡️ ago-2026 Fix: no mover a breakeven si el precio ya quedó del lado
                            // equivocado (trade en pérdida). El broker rechaza un SL de BUY por encima
                            // del bid (o de SELL por debajo del ask) con TRADING_BAD_STOPS y el
                            // reintento spamea para siempre. Se mantiene el SL estructural.
                            const ba = getLastBidAsk(ticker);
                            const sideOk = !ba
                                ? true
                                : trade.direction === 'BUY'
                                    ? ba.bid >= beSl
                                    : ba.ask <= beSl;
                            if (!sideOk) {
                                console.log(`[ROI] ⚠️ ${ticker} ${trade.direction} #${tradeId}: breakeven omitido — el precio (bid=${ba?.bid}, ask=${ba?.ask}) ya pasó el nivel BE ${beSl}. Se mantiene SL estructural.`);
                            } else if (isBacktest) {
                                trade.slPrice = beSl;
                            } else {
                                trade.targetSlPrice = beSl;
                                trade.targetSlPending = true;
                                trade.targetSlRetries = 0;
                                if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({
                                    slPrice: beSl,
                                    targetSlPrice: beSl,
                                    targetSlPending: true,
                                    roiDecayApplied: 'breakeven',
                                }).catch(() => { });
                            }
                            if (sideOk) console.log(`[ROI] 🛡️ ${ticker} ${trade.direction} #${tradeId}: ROI breakeven → SL ajustado a ${beSl} (buffer fricción)`);
                        }
                    }

                    // 🔄 REINTENTO DE MODIFICACIÓN DE SL (Si quedó pendiente de un tick anterior)
                    if (!executionStages && trade.targetSlPending && trade.targetSlPrice !== undefined && !isBacktest && trade.ctraderPositionId && !(trade as any).slAmendInFlight) {
                        trade.targetSlRetries = (trade.targetSlRetries || 0) + 1;
                        // 🛡️ ago-2026 Fix: tope de reintentos. Un SL rechazado de forma persistente
                        // (TRADING_BAD_STOPS, posición cerrada/inexistente) no se va a resolver solo;
                        // reintentar en cada tick spamea el log y recalienta el loop. Se abandona.
                        if (trade.targetSlRetries > 5) {
                            console.log(`[CTRADER] ⛔ Abandono modificación de SL a ${trade.targetSlPrice} tras ${trade.targetSlRetries} intentos (posID ${trade.ctraderPositionId}) — el broker la rechaza de forma persistente.`);
                            trade.targetSlPending = false;
                            trade.targetSlRetries = 0;
                            if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ targetSlPending: false }).catch(() => { });
                        } else {
                            const sentSl = trade.targetSlPrice!;
                            console.log(`[CTRADER] 🔄 Reintentando modificar SL a ${sentSl} (Intento ${trade.targetSlRetries}) para posID: ${trade.ctraderPositionId}`);
                            await runNormalStopMutation(tradeId, trade, () => import('../services/ctrader.js').then(async (ctrader) => {
                                const success = await ctrader.modifyStopLoss(trade.ctraderPositionId!, sentSl);
                                if (success) {
                                    console.log(`[CTRADER] ✅ Éxito al modificar SL a ${sentSl} en reintento.`);
                                    trade.slPrice = sentSl;
                                    if (trade.targetSlPrice === sentSl) trade.targetSlPending = false; // si el trailing movió el target, sigue pendiente
                                    trade.targetSlRetries = 0;
                                    if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({
                                        slPrice: trade.slPrice,
                                        targetSlPending: false
                                    }).catch(() => { });
                                } else {
                                    console.log(`[CTRADER] ⚠️ Fallo al modificar SL a ${sentSl} en reintento, se seguirá intentando.`);
                                }
                            }).catch(err => {
                                console.error(`[CTRADER] ❌ Error importando módulo para reintento de Breakeven: ${err.message}`);
                            }));
                        }
                    }

                    const openTimeStr = new Date(trade.timestamp).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit' });

                    // 🎯 EVALUACIÓN DE TP1
                    if (!trade.tp1Hit && !executionStages) {
                        // 🆕 ago-2026: guardia de precio del BROKER contra falsos positivos del feed.
                        // El feed de TV puede marcar wicks que el broker nunca imprimió (caso real:
                        // USDJPY SELL creyó ver TP1 26 pips abajo y ejecutó el parcial a mercado
                        // EN CONTRA → -1.84 EUR). Si el bid/ask real está fresco (<30s), el TP1
                        // solo se da cuando el BROKER confirma el nivel. Sin datos frescos → feed.
                        const ba = getLastBidAsk(ticker);
                        const baFresh = ba != null && Date.now() - ba.ts < 30_000;
                        const feedTp1Hit = trade.direction === 'BUY'
                            ? highPrice >= trade.tp1Price
                            : lowPrice <= trade.tp1Price;
                        const brokerTp1Hit = baFresh
                            ? (trade.direction === 'BUY' ? ba!.bid >= trade.tp1Price : ba!.ask <= trade.tp1Price)
                            : null;
                        if (feedTp1Hit && brokerTp1Hit === false) {
                            console.log(`[TRADE] ⚠️ TP1 falso positivo en ${ticker} (feed lo marca, broker NO: ${trade.direction === 'BUY' ? `bid=${ba!.bid}` : `ask=${ba!.ask}`} vs TP1 ${trade.tp1Price}) — parcial NO ejecutado.`);
                        }
                        const tp1Hit = brokerTp1Hit !== null ? brokerTp1Hit : feedTp1Hit;

                        if (tp1Hit) {
                            // 🛡️ FILTRO ANTI-DUPLICADOS
                            if (isDuplicate(`TP1_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                            trade.tp1Hit = true;
                            trade.originalSlPrice = trade.slPrice;

                            // 🆕 RISK REDUCTION post-TP1: SL según mgmtSlModeT ('midpoint' | 'breakeven' | 'none')
                            const distanceToEntry = trade.entryPrice - trade.originalSlPrice;
                            let targetSl: number | null = null;
                            if (mgmtSlModeT === 'midpoint') {
                                targetSl = parseFloat((trade.originalSlPrice + (distanceToEntry * 0.5)).toFixed(5));
                            } else if (mgmtSlModeT === 'breakeven') {
                                targetSl = breakevenBufferPrice(ticker, trade.entryPrice, trade.direction);
                            }

                            if (targetSl !== null) {
                                if (isBacktest) {
                                    trade.slPrice = targetSl;
                                } else {
                                    trade.targetSlPrice = targetSl;
                                    trade.targetSlPending = true;
                                    trade.targetSlRetries = 0;
                                }
                            }

                            // 🏇 RIDER TRANSITION (EA31337): si la sesión tiene riderEnabled y SL→breakeven,
                            // transferir gestión del trade a la temporalidad superior para salida estructural.
                            const sessionCfg = (config.sessions?.[getCurrentSession(nowTrade)] ?? (config.sessions as any)?.['ALL']) as any;
                            const riderEnabled = sessionCfg?.riderEnabled ?? config.riderEnabled ?? false;
                            const riderTf = sessionCfg?.riderTf ?? config.riderTf ?? 'H1';
                            if (riderEnabled && mgmtSlModeT === 'breakeven' && !trade.managementMode) {
                                trade.managementMode = 'RIDER';
                                trade.riderTf = riderTf;
                                trade.tp2Price = 0; // deshabilitar TP2 fijo — la salida es estructural
                                console.log(`[RIDER] 🏇 ${ticker} ${trade.direction} #${tradeId}: transicionando a RIDER mode (${riderTf}). Salida por estructura HTF.`);
                            }

                            const durationSec = Math.round((nowTrade - trade.timestamp) / 1000);
                            const durationStr = durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`;

                            // 💾 Sincronizar actualización de TP1 (SL no cambia internamente hasta que el broker lo acepte en Real)
                            if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({
                                tp1Hit: true,
                                slPrice: trade.slPrice,
                                targetSlPrice: trade.targetSlPrice || null,
                                targetSlPending: trade.targetSlPending || false,
                                originalSlPrice: trade.originalSlPrice
                            }).catch(() => { });

                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    if (!trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        tp1Hit: true,
                                        tp1Timestamp: nowTrade,
                                        slPrice: trade.slPrice,
                                        originalSlPrice: trade.originalSlPrice,
                                        closedAt: nowTrade
                                    }).then(() => import('../engine/PortfolioModel.js').then(m => m.invalidateRiskCache())).catch(() => { });
                                }
                            }

                            const slModeText = mgmtSlModeT === 'breakeven' ? 'Breakeven' : mgmtSlModeT === 'none' ? 'Sin cambios' : 'Reducido 50%';
                            console.log(`[JOURNAL] 🟡 TP1 alcanzado: ${ticker} ${trade.direction} #${tradeId} — Parcial ${Math.round(mgmtPartialT * 100)}%, SL: ${slModeText}`);

                            // 🆕 FIX (ago-2026): el mensaje de Telegram refleja el resultado REAL de cTrader.
                            // Antes se anunciaba "Toma parcial ejecutada" ANTES de intentar nada —
                            // si faltaba el enlace de posición (reinicio), el mensaje mentía.
                            const buildTp1Msg = (summary: string) => `🟡 <b>TP1 ALCANZADO | ${ticker} | ${trade.direction}</b>\n\n`
                                + `🕒 Apertura: ${openTimeStr}\n`
                                + `📥 Entrada: ${trade.entryPrice}\n`
                                + `🎯 TP1: ${trade.tp1Price} ✅\n`
                                + `🚀 TP2: ${trade.tp2Price > 0 ? trade.tp2Price : '—'}\n`
                                + `🛑 SL (${slModeText}): ${trade.slPrice}\n`
                                + `⏱️ Duración: ${durationStr}\n\n`
                                + summary;

                            // 🆕 EJECUCIÓN AUTOMÁTICA EN cTrader
                            if (!isBacktest && trade.ctraderPositionId) {
                                await runNormalStopMutation(tradeId, trade, () => import('../services/ctrader.js').then(async (ctrader) => {
                                    console.log(`[CTRADER] 🔄 Ejecutando Risk Reduction Automático para posID: ${trade.ctraderPositionId}`);
                                    let partialOk = true;
                                    if (mgmtPartialT > 0) {
                                        partialOk = await ctrader.closePartial(trade.ctraderPositionId!, Math.round(mgmtPartialT * 100));
                                        if (partialOk) {
                                            if (versionedExecution && trade.executionState) {
                                                const confirmed = { ...trade.executionState, partialConfirmed: true, tp1Touched: true };
                                                if (db) {
                                                    await db.collection('active_trades').doc(tradeId).update({ executionState: confirmed });
                                                    trade.executionState = confirmed;
                                                }
                                            }
                                            // 🆕 (ago-2026) Persistir los datos REALES del parcial (precio ejecutado + PnL)
                                            // para que el Diario Analítico muestre la toma parcial, no solo "abierto".
                                            try {
                                                const pdeal = await ctrader.getLastCloseDealForPosition(trade.ctraderPositionId!);
                                                if (pdeal) {
                                                    const partialFields: any = {
                                                        tp1PartialAt: Date.now(),
                                                        tp1PartialPct: mgmtPartialT,
                                                        tp1PartialPrice: pdeal.executionPrice,
                                                        tp1PartialPnlUsd: pdeal.grossProfit,
                                                    };
                                                    if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update(partialFields).catch(() => { });
                                                    if (trade.journalId) {
                                                        const { db: fireDb } = await import('./memory.js');
                                                        if (fireDb && !trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update(partialFields).catch(() => { });
                                                    }
                                                    console.log(`[JOURNAL] 🟡 TP1 parcial registrado: ${ticker} #${tradeId} ${Math.round(mgmtPartialT * 100)}% @ ${pdeal.executionPrice} (PnL ${pdeal.grossProfit.toFixed(2)})`);
                                                }
                                            } catch { /* telemetría: nunca bloquear la gestión */ }
                                        }
                                    }
                                    let slDone: boolean | null = null;
                                    if (targetSl !== null) {
                                        slDone = await ctrader.modifyStopLoss(trade.ctraderPositionId!, targetSl);
                                        if (slDone) {
                                            console.log(`[CTRADER] ✅ Éxito al modificar SL a ${trade.targetSlPrice}.`);
                                            trade.slPrice = trade.targetSlPrice!;
                                            trade.targetSlPending = false;
                                            if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ slPrice: trade.slPrice, targetSlPending: false }).catch(() => { });
                                        } else {
                                            console.log(`[CTRADER] ⚠️ Fallo al modificar SL a ${trade.targetSlPrice}, se reintentará luego.`);
                                        }
                                    }
                                    const parts: string[] = [];
                                    if (mgmtPartialT > 0) {
                                        parts.push(partialOk
                                            ? `✅ Toma parcial ejecutada (${Math.round(mgmtPartialT * 100)}%).`
                                            : `⚠️ NO se pudo ejecutar la toma parcial (${Math.round(mgmtPartialT * 100)}%) en cTrader.`);
                                    } else {
                                        parts.push(`💡 Sin toma parcial (0%). La posición completa sigue abierta hacia TP2.`);
                                    }
                                    if (slDone === true) parts.push(`✅ SL ajustado (${slModeText}).`);
                                    else if (slDone === false) parts.push(`⚠️ SL NO se pudo ajustar (${slModeText}) — se reintentará.`);
                                    else if (targetSl === null) parts.push(`SL: ${slModeText}.`);
                                    if (partialOk === false || slDone === false) parts.push(`⚠️ Verificar la posición en cTrader.`);
                                    sendTelegramAlert(buildTp1Msg(parts.join(' '))).catch(() => { });
                                }).catch(err => {
                                    console.error(`[CTRADER] ❌ Error importando módulo para Breakeven: ${err.message}`);
                                    sendTelegramAlert(buildTp1Msg(`⚠️ Error interno al ejecutar en cTrader — verificar la posición manualmente.`)).catch(() => { });
                                }));
                            } else if (!isBacktest) {
                                // Sin "gancho" de posición (reinicio previo al fix de persistencia): avisar la verdad.
                                sendTelegramAlert(buildTp1Msg(`⚠️ TP1 detectado pero NO se pudo ejecutar en cTrader (sin enlace de posición). El reconciler adoptará la posición con niveles reales.`)).catch(() => { });
                            }
                        }
                    }

                    // 🏇 RIDER EXIT (EA31337): si el trade está en modo RIDER, la salida es estructural.
                    // Solo se cierra si el SMCEngine del HTF detecta un CHoCH inverso.
                    // El ATR trailing y SL check siguen activos como protección.
                    if (trade.managementMode === 'RIDER') {
                        const riderEngine = store.smcManager?.getEngine(ticker, trade.riderTf || 'H1');
                        if (riderEngine) {
                            const riderState = riderEngine.getState();
                            const lastChoch = riderState.lastCHoCH;
                            if (lastChoch) {
                                const inverseDir = trade.direction === 'BUY' ? 'Bearish' : 'Bullish';
                                if ((lastChoch as any).direction === inverseDir) {
                                    if (isDuplicate(`RIDER_${trade.tradeId}_${ticker}`, nowTrade)) continue;
                                    // 🛡️ T1: en vivo cerrar en cTrader ANTES de marcar WIN (sin esto la posición
                                    // quedaba viva sin gestor y el journal registraba un WIN falso).
                                    if (!isBacktest) {
                                        if (trade.ctraderPositionId && !(trade as any).brokerCloseConfirmed) {
                                            const { closePosition } = await import('../services/ctrader.js');
                                            const ok = await closePosition(String(trade.ctraderPositionId));
                                            if (!ok) continue;
                                        }
                                        if (await completeLiveTradeClose(trade, store, { managementMode: 'RIDER', riderTf: trade.riderTf ?? 'H1', durationMin: Math.round(tradeAgeMs / 60000) })) {
                                            sendTelegramAlert(`✅ RIDER ${ticker} #${tradeId}: cierre confirmado con contabilidad real del broker.`).catch(() => {});
                                        }
                                        continue;
                                    }
                                    store.activeTrades.delete(tradeId);
                                    if (db && !trade.isBacktest) db.collection('active_trades').doc(tradeId).delete().catch(() => { });
                                    
                                    const currentPnlPct = trade.direction === 'BUY'
                                        ? (currentPrice - trade.entryPrice) / trade.entryPrice * 100
                                        : (trade.entryPrice - currentPrice) / trade.entryPrice * 100;
                                    const originalSl = trade.originalSlPrice ?? trade.slPrice;
                                    const slDistPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                                    const rMultiple = slDistPct > 0 ? parseFloat((currentPnlPct / slDistPct).toFixed(4)) : 0;
                                    const durationMin = Math.round(tradeAgeMs / 60000);
                                    
                                    if (trade.journalId) {
                                        const { db: fireDb } = await import('./memory.js');
                                        if (fireDb && !trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                            result: 'WIN', pnl: parseFloat(currentPnlPct.toFixed(2)), rMultiple,
                                            durationMin, managementMode: 'RIDER', riderTf: trade.riderTf,
                                        }).catch(() => { });
                                    }
                                    
                                    const riderMsg = `🏇 <b>RIDER EXIT | ${ticker} | ${trade.direction}</b>\n\n`
                                        + `📥 Entrada: ${trade.entryPrice}\n`
                                        + `💰 PnL: +${currentPnlPct.toFixed(2)}%\n`
                                        + `⏱️ Duración: ${durationMin}min\n`
                                        + `🔍 HTF (${trade.riderTf}): CHoCH ${inverseDir} detectado → salida estructural\n\n`
                                        + `💡 Trade cerrado por inversión de estructura en temporalidad superior.`;
                                    if (!isBacktest) sendTelegramAlert(riderMsg).catch(() => { });
                                    console.log(`[RIDER] 🏇 ${ticker} ${trade.direction} #${tradeId}: EXIT por CHoCH ${inverseDir} en ${trade.riderTf}. PnL=+${currentPnlPct.toFixed(2)}%`);
                                    continue;
                                }
                            }
                        }
                    }

                    // 🆕 GATILLO DE BREAKEVEN DIFERIDO (TP 1.5)
                    if (!executionStages && trade.tp1Hit && !trade.slHalfwayHit && mgmtTp15T) {
                        const riskDist = Math.abs(trade.tp1Price - trade.entryPrice);
                        const tp1_5Price = trade.direction === 'BUY' ? trade.tp1Price + (riskDist * 0.5) : trade.tp1Price - (riskDist * 0.5);

                        const baBe = getLastBidAsk(ticker);
                        const baBeFresh = baBe != null && Date.now() - baBe.ts < 30_000;
                        const beHit = trade.direction === 'BUY'
                            ? (baBeFresh ? baBe!.bid >= tp1_5Price : highPrice >= tp1_5Price)
                            : (baBeFresh ? baBe!.ask <= tp1_5Price : lowPrice <= tp1_5Price);

                        if (beHit) {
                            if (isDuplicate(`BE_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                            trade.slHalfwayHit = true;
                            const beSlHalf = breakevenBufferPrice(ticker, trade.entryPrice, trade.direction);
                            if (isBacktest) {
                                trade.slPrice = beSlHalf;
                            } else {
                                trade.targetSlPrice = beSlHalf;
                                trade.targetSlPending = true;
                                trade.targetSlRetries = 0;
                            }

                            // Actualizar Firebase
                            if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({
                                slHalfwayHit: true,
                                slPrice: trade.slPrice,
                                targetSlPrice: trade.targetSlPrice || null,
                                targetSlPending: trade.targetSlPending || false
                            }).catch(() => { });

                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    if (!trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        slHalfwayHit: true,
                                        slPrice: trade.entryPrice,
                                        closedAt: nowTrade
                                    }).then(() => import('../engine/PortfolioModel.js').then(m => m.invalidateRiskCache())).catch(() => { });
                                }
                            }

                            console.log(`[JOURNAL] 🛡️ Breakeven diferido activado: ${ticker} ${trade.direction} #${tradeId}`);

                            // 🆕 FIX (ago-2026): anunciar el breakeven SOLO cuando cTrader confirme el cambio.
                            // Antes el mensaje salía primero y el intento de mover el SL después —
                            // si faltaba el enlace de posición, llegaba un "100% libre de riesgo" falso.
                            const buildBeMsg = (summary: string) => `🛡️ <b>BREAKEVEN ACTIVADO | ${ticker} | ${trade.direction}</b>\n\n`
                                + `📈 El precio avanzó un 50% extra después del TP1.\n`
                                + `🛑 SL objetivo (entrada): ${trade.entryPrice}\n\n`
                                + summary;

                            if (!isBacktest && trade.ctraderPositionId) {
                                await runNormalStopMutation(tradeId, trade, () => import('../services/ctrader.js').then(async (ctrader) => {
                                    console.log(`[CTRADER] 🔄 Ejecutando Breakeven Definitivo para posID: ${trade.ctraderPositionId}`);
                                    const success = await ctrader.modifyStopLoss(trade.ctraderPositionId!, trade.targetSlPrice!);
                                    if (success) {
                                        console.log(`[CTRADER] ✅ Éxito al modificar SL a ${trade.targetSlPrice}.`);
                                        trade.slPrice = trade.targetSlPrice!;
                                        trade.targetSlPending = false;
                                        if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ slPrice: trade.slPrice, targetSlPending: false }).catch(() => { });
                                        sendTelegramAlert(buildBeMsg(`✅ SL ajustado a precio de entrada: ${trade.entryPrice}\n💡 Operación 100% libre de riesgo.`)).catch(() => { });
                                    } else {
                                        console.log(`[CTRADER] ⚠️ Fallo al modificar SL a ${trade.targetSlPrice}, se reintentará luego.`);
                                        sendTelegramAlert(buildBeMsg(`⚠️ El SL NO se pudo mover en cTrader — se reintentará automáticamente.`)).catch(() => { });
                                    }
                                }).catch(err => {
                                    console.error(`[CTRADER] ❌ Error en Breakeven Definitivo: ${err.message}`);
                                    sendTelegramAlert(buildBeMsg(`⚠️ Error interno al mover el SL — se reintentará automáticamente.`)).catch(() => { });
                                }));
                            } else if (!isBacktest) {
                                // Sin "gancho" de posición: avisar la verdad, no mentir.
                                sendTelegramAlert(buildBeMsg(`⚠️ NO se pudo mover el SL en cTrader (sin enlace de posición). El reconciler adoptará la posición con niveles reales.`)).catch(() => { });
                            }
                        }
                    }

                    // Complemento PING: trailing continuo post-TP1 por distancia
                    if (!executionStages && trade.tp1Hit && mgmtAtrTrailT) {
                        const atrThreshold = (state.atr14 ?? 0) * 1.5;
                        const ratchetStep = (state.atr14 ?? 0) * 0.25;
                        // 🛡️ FIX D: el trailing nunca debe cruzar el SL al lado equivocado del entry.
                        // Cota = entry (breakeven). Así el rMultiple del SL-hit no puede dispararse
                        // con un SL en territorio de ganancia tratado como pérdida.
                        if (trade.direction === 'BUY') {
                            // BUY: SL siempre por DEBAJO del entry (breakeven = entry)
                            // 🆕 Ronda 2: ratchet contra el BID del broker (wick falso del feed ya no sube el SL)
                            const baTrail = getLastBidAsk(ticker);
                            const baTrailFresh = baTrail != null && Date.now() - baTrail.ts < 30_000;
                            const refHigh = baTrailFresh ? baTrail!.bid : highPrice;
                            let atrTrailSL = refHigh - atrThreshold;
                            if (atrTrailSL > trade.entryPrice) atrTrailSL = trade.entryPrice;
                            if (atrTrailSL > trade.slPrice + ratchetStep) {
                                if (isBacktest) {
                                    trade.slPrice = atrTrailSL;
                                } else {
                                    trade.targetSlPrice = parseFloat(atrTrailSL.toFixed(5));
                                    trade.targetSlPending = true;
                                    trade.targetSlRetries = 0;
                                    if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ targetSlPrice: trade.targetSlPrice, targetSlPending: true }).catch(() => { });
                                }
                            }
                        } else {
                            // SELL: SL siempre por ENCIMA del entry (breakeven = entry)
                            // 🆕 Ronda 2: ratchet contra el ASK del broker
                            const baTrail = getLastBidAsk(ticker);
                            const baTrailFresh = baTrail != null && Date.now() - baTrail.ts < 30_000;
                            const refLow = baTrailFresh ? baTrail!.ask : lowPrice;
                            let atrTrailSL = refLow + atrThreshold;
                            if (atrTrailSL < trade.entryPrice) atrTrailSL = trade.entryPrice;
                            if (atrTrailSL < trade.slPrice - ratchetStep) {
                                if (isBacktest) {
                                    trade.slPrice = atrTrailSL;
                                } else {
                                    trade.targetSlPrice = parseFloat(atrTrailSL.toFixed(5));
                                    trade.targetSlPending = true;
                                    trade.targetSlRetries = 0;
                                    if (db && !trade.isBacktest) db.collection('active_trades').doc(trade.tradeId).update({ targetSlPrice: trade.targetSlPrice, targetSlPending: true }).catch(() => { });
                                }
                            }
                        }
                    }

                    // 🚀 EVALUACIÓN DE TP2
                    if (trade.tp2Price > 0) {
                        let tp2Hit: boolean;
                        if (isBacktest) {
                            tp2Hit = trade.direction === 'BUY'
                                ? highPrice >= trade.tp2Price
                                : lowPrice <= trade.tp2Price;
                        } else {
                            // LIVE: lado de ejecución correcto. Un BUY cierra con el BID,
                            // un SELL cierra con el ASK (comprando). Si no hay bid/ask fresco,
                            // se cae al high/low del feed como antes.
                            const ba = getLastBidAsk(ticker);
                            const baFresh = ba != null && Date.now() - ba.ts < 30_000;
                            tp2Hit = trade.direction === 'BUY'
                                ? (baFresh ? ba!.bid >= trade.tp2Price : highPrice >= trade.tp2Price)
                                : (baFresh ? ba!.ask <= trade.tp2Price : lowPrice <= trade.tp2Price);
                        }

                        if (tp2Hit) {
                            // 🛡️ FILTRO ANTI-DUPLICADOS
                            if (isDuplicate(`CLOSE_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                            // 🔴 LIVE: la VERDAD es cTrader. El feed de TradingView (High/Low de velas)
                            // puede tocar TP2 con un wick que el bid de cTrader nunca tocó → el TP
                            // server-side no ejecuta y la posición sigue viva. NO se marca WIN por
                            // adelantado ni se saca de RAM: se espera el cierre real de cTrader.
                            if (!isBacktest && trade.ctraderPositionId) {
                                const { getOpenPositions } = await import('../services/ctrader.js');
                                const stillOpen = (await getOpenPositions(ticker)).some(
                                    (p: any) => String(p.positionId) === String(trade.ctraderPositionId)
                                );
                                if (stillOpen) {
                                    if (!(trade as any).tp2ZoneNotified) {
                                        (trade as any).tp2ZoneNotified = true;
                                        const zoneMsg = `🎯 <b>ZONA TP2 TOCADA | ${ticker} | ${trade.direction}</b>\n\n` +
                                            `El feed tocó ${trade.tp2Price} pero la posición sigue <b>ABIERTA</b> en cTrader.\n` +
                                            `Se espera el cierre real del TP de cTrader (no se marca WIN por adelantado).`;
                                        sendTelegramAlert(zoneMsg).catch(() => { });
                                        console.log(`[TP2] ⚠️ ${ticker} #${tradeId}: feed tocó TP2 pero la posición sigue abierta en cTrader — esperando cierre real.`);
                                    }
                                    continue;
                                }
                                // Posición ya cerrada en cTrader → el ExecutionEvent registró el
                                // resultado real (y el reconciler limpia cualquier residuo). Nada que hacer aquí.
                                // 🛡️ FIX (30-sep-2026): si el evento de cierre NO llega (se pierde en
                                // restarts/gaps de conexión), este loop spamea para siempre y el trade
                                // queda fantasma (caso real: XTIUSD 30-sep, loop "[TP2] ✅" eterno).
                                // Fallback: tras 8 detecciones seguidas, finalizar con los deals reales.
                                (trade as any).closeAccountingPending = true;
                                invalidateRiskCache();
                                (trade as any).closeMissedCount = ((trade as any).closeMissedCount || 0) + 1;
                                if ((trade as any).closeMissedCount > 8) {
                                    console.log(`[TP2] 🔧 ${ticker} #${tradeId}: evento de cierre no llegó tras ${(trade as any).closeMissedCount} detecciones — finalizando con deals reales.`);
                                    await completeLiveTradeClose(trade, store, { reconciled: true });
                                } else {
                                    console.log(`[TP2] ✅ ${ticker} #${tradeId}: posición cerrada en cTrader — esperando evento real (detección ${(trade as any).closeMissedCount}/8).`);
                                }
                                continue;
                            }

                            // 💾 Eliminar de RAM inmediatamente de forma síncrona (backtest / sin cTrader)
                            store.activeTrades.delete(tradeId);
                            if (db && !trade.isBacktest) db.collection('active_trades').doc(tradeId).delete().catch(() => { });

                            trade.tp2Hit = true;
                            const pnlTp1Pct = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
                            const pnlTp2Pct = Math.abs(trade.tp2Price - trade.entryPrice) / trade.entryPrice * 100;
                            const finalPnlPct = trade.tp1Hit ? (pnlTp1Pct * mgmtPartialT + pnlTp2Pct * (1 - mgmtPartialT)) : pnlTp2Pct;

                            const originalSl = trade.originalSlPrice ?? trade.slPrice;
                            const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                            const rMultiple = initialSlLossPct > 0 ? parseFloat((finalPnlPct / initialSlLossPct).toFixed(4)) : 1.5;
                            const durationMin = Math.round((nowTrade - trade.timestamp) / 60000);

                            if (trade.journalId) {
                                const { db: fireDb } = await import('./memory.js');
                                if (fireDb) {
                                    if (!trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                        tp2Hit: true,
                                        tp2Timestamp: nowTrade,
                                        result: 'WIN',
                                        pnl: parseFloat(finalPnlPct.toFixed(2)),
                                        rMultiple,
                                        durationMin,
                                    }).catch(() => { });
                                }
                            }
                            if (trade.journalId) {
                                if (!isBacktest) recordResult(trade.journalId, 'WIN', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            } else {
                                if (!isBacktest) recordResult(tradeId, 'WIN', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            }

                            store.consecutiveLosses = 0;

                            const tp2Msg = `🟢 <b>TP2 ALCANZADO (WIN) | ${ticker} | ${trade.direction}</b>\n\n` +
                                `🕒 Apertura: ${openTimeStr}\n` +
                                `📥 Entrada: ${trade.entryPrice}\n` +
                                `🎯 TP1: ${trade.tp1Price} ${trade.tp1Hit ? '✅' : '⏭️'}\n` +
                                `🚀 TP2: ${trade.tp2Price} ✅\n` +
                                `📊 PnL: +${finalPnlPct.toFixed(2)}%\n` +
                                `⏱️ Duración total: ${durationMin} min\n\n` +
                                `🏆 ¡Trade completo! ${store.consecutiveLosses > 0 ? `Racha protección: ${store.consecutiveLosses} pérdidas` : 'Racha limpia.'}`;
                            if (!isBacktest) sendTelegramAlert(tp2Msg).catch(() => { });
                            console.log(`[JOURNAL] 🟢 TP2 alcanzado (WIN): ${ticker} ${trade.direction} #${tradeId}`);
                            continue;
                        }
                    }

                    // 🛑 EVALUACIÓN DE STOP LOSS (O BREAK EVEN)
                    let slHit = false;
                    if (isBacktest) {
                        // Castigo de realidad: añadir spread simulado en el backtest
                        let spreadAdjustment = 0;
                        const upperTicker = ticker.toUpperCase();
                        if (upperTicker.includes('NAS100') || upperTicker.includes('TECH 100') || upperTicker.includes('GER') || upperTicker.includes('DE40') || upperTicker.includes('DAX')) spreadAdjustment = 0.5; // 0.5 puntos (índices)
                        else if (upperTicker.includes('JPY')) spreadAdjustment = 0.005; // 0.5 pips
                        else if (upperTicker.includes('XAU')) spreadAdjustment = 0.1; // 10 centavos
                        else spreadAdjustment = 0.00005; // 0.5 pips standard para forex (EURUSD, GBPUSD)

                        slHit = trade.direction === 'BUY'
                            ? lowPrice <= (trade.slPrice + spreadAdjustment)
                            : highPrice >= (trade.slPrice - spreadAdjustment);
                    } else {
                        // 🔧 LIVE: lado de ejecución correcto. BUY cierra con bid, SELL con ask.
                        const ba = getLastBidAsk(ticker);
                        const baFresh = ba != null && Date.now() - ba.ts < 30_000;
                        slHit = trade.direction === 'BUY'
                            ? (baFresh ? ba!.bid <= trade.slPrice : currentPrice <= trade.slPrice)
                            : (baFresh ? ba!.ask >= trade.slPrice : currentPrice >= trade.slPrice);
                    }

                    if (slHit) {
                        // 🛡️ FILTRO ANTI-DUPLICADOS
                        if (isDuplicate(`CLOSE_${trade.tradeId}_${ticker}`, nowTrade)) continue;

                        // 🔴 LIVE: verificar cierre real en cTrader antes de marcar LOSS.
                        // El SL de un SELL ejecuta con el ASK; el feed del bot es el bid.
                        // Con spread ancho el bid puede tocar el SL sin que cTrader cierre.
                        if (!isBacktest && trade.ctraderPositionId) {
                            const { getOpenPositions } = await import('../services/ctrader.js');
                            const stillOpen = (await getOpenPositions(ticker)).some(
                                (p: any) => String(p.positionId) === String(trade.ctraderPositionId)
                            );
                            if (stillOpen) {
                                if (!(trade as any).slZoneNotified) {
                                    (trade as any).slZoneNotified = true;
                                    console.log(`[SL] ⚠️ ${ticker} #${tradeId}: feed tocó SL pero la posición sigue abierta en cTrader — esperando cierre real.`);
                                    const zoneMsg = `🛑 <b>ZONA SL TOCADA | ${ticker} | ${trade.direction}</b>\n\n` +
                                        `El feed tocó ${trade.slPrice} pero la posición sigue <b>ABIERTA</b> en cTrader.\n` +
                                        `Se espera el cierre real del SL de cTrader (no se marca LOSS por adelantado).`;
                                    sendTelegramAlert(zoneMsg).catch(() => { });
                                }
                                continue;
                            }
                            // 🛡️ FIX (30-sep-2026): mismo fallback que el path de TP2 — si el evento
                            // de cierre no llega, finalizar con deals reales tras 8 detecciones
                            // (caso real: XTIUSD 30-sep, loop "[SL] ✅" eterno).
                            (trade as any).closeAccountingPending = true;
                            invalidateRiskCache();
                            (trade as any).closeMissedCount = ((trade as any).closeMissedCount || 0) + 1;
                            if ((trade as any).closeMissedCount > 8) {
                                console.log(`[SL] 🔧 ${ticker} #${tradeId}: evento de cierre no llegó tras ${(trade as any).closeMissedCount} detecciones — finalizando con deals reales.`);
                                await completeLiveTradeClose(trade, store, { reconciled: true });
                            } else {
                                console.log(`[SL] ✅ ${ticker} #${tradeId}: posición cerrada en cTrader — esperando evento real (detección ${(trade as any).closeMissedCount}/8).`);
                            }
                            continue;
                        }

                        // 💾 Eliminar de RAM inmediatamente de forma síncrona para evitar race conditions
                        store.activeTrades.delete(tradeId);
                        if (db && !trade.isBacktest) db.collection('active_trades').doc(tradeId).delete().catch(() => { });

                        const isPartialClose = trade.tp1Hit;
                        const originalSl = trade.originalSlPrice ?? trade.slPrice;
                        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
                        const currentSlLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100;
                        const pnlTp1Pct = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
                        const finalPnlPct = isPartialClose ? (pnlTp1Pct * mgmtPartialT - currentSlLossPct * (1 - mgmtPartialT)) : -currentSlLossPct;
                        const rMultiple = initialSlLossPct > 0 ? parseFloat((finalPnlPct / initialSlLossPct).toFixed(4)) : 0;
                        const finalResult = isPartialClose ? (finalPnlPct >= 0 ? 'BREAKEVEN' : 'LOSS') : 'LOSS';
                        const durationMin = Math.round((nowTrade - trade.timestamp) / 60000);

                        if (trade.journalId) {
                            const { db: fireDb } = await import('./memory.js');
                            if (fireDb) {
                                if (!trade.isBacktest) fireDb.collection('trade_journal').doc(trade.journalId).update({
                                    slHit: true,
                                    slTimestamp: nowTrade,
                                    result: finalResult,
                                    pnl: parseFloat(finalPnlPct.toFixed(2)),
                                    rMultiple,
                                    durationMin,
                                }).catch(() => { });
                            }
                        }

                        // Si tomamos parciales, igual registramos la operación para no castigar
                        if (!isPartialClose) {
                            if (trade.journalId) {
                                if (!isBacktest) recordResult(trade.journalId, 'LOSS', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            } else {
                                if (!isBacktest) recordResult(tradeId, 'LOSS', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            }
                        } else {
                            if (trade.journalId) {
                                if (!isBacktest) recordResult(trade.journalId, 'BREAKEVEN', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            } else {
                                if (!isBacktest) recordResult(tradeId, 'BREAKEVEN', parseFloat(finalPnlPct.toFixed(2))).catch(() => { });
                            }
                        }

                        // Lógica de racha perdedora con banda neutra
                        const NET_BE_EPS = 0.05;
                        if (rMultiple < -NET_BE_EPS) {
                            store.consecutiveLosses++;
                            if (store.consecutiveLosses >= 5) store.streakKillswitchUntil = nowTrade + 30 * 60 * 1000;
                        } else if (rMultiple >= 0.8) {
                            store.consecutiveLosses = 0;
                        } else if (rMultiple > NET_BE_EPS) {
                            store.consecutiveLosses = Math.max(0, store.consecutiveLosses - 1);
                        }

                        const protectionMsg = store.consecutiveLosses >= 5
                            ? '🔴 ALERTA: 5 pérdidas consecutivas. KILLSWITCH ACTIVADO por 30 min.'
                            : store.consecutiveLosses === 4
                                ? '⚠️ 4 pérdidas consecutivas.'
                                : store.consecutiveLosses === 3
                                    ? '⚠️ 3 pérdidas consecutivas.'
                                    : store.consecutiveLosses === 2
                                        ? '⚠️ 2 pérdidas consecutivas.'
                                        : '';
                        const slMsg = isPartialClose
                            ? `⚠️ <b>STOP LOSS POST-PARCIAL (BREAKEVEN) | ${ticker} | ${trade.direction}</b>\n\n` +
                            `📥 Entrada: ${trade.entryPrice}\n` +
                            `🎯 TP1 Parcial: Tomado al ${trade.tp1Price}\n` +
                            `🛑 SL Alcanzado: ${trade.slPrice}\n` +
                            `📊 PnL Final: ${finalPnlPct > 0 ? '+' : ''}${finalPnlPct.toFixed(2)}%\n` +
                            `⏱️ Duración total: ${durationMin} min`
                            : `🔴 <b>STOP LOSS (LOSS) | ${ticker} | ${trade.direction}</b>\n\n` +
                            `🕒 Apertura: ${openTimeStr}\n` +
                            `📥 Entrada: ${trade.entryPrice}\n` +
                            `🛑 SL Alcanzado: ${trade.slPrice} ❌\n` +
                            `📊 PnL: ${finalPnlPct.toFixed(2)}%\n` +
                            `⏱️ Duración: ${durationMin} min\n\n` +
                            `${protectionMsg ? protectionMsg + '\n\n' : ''}` +
                            `📈 Racha actual: ${store.consecutiveLosses} pérdida(s) consecutiva(s)`;

                        if (!isBacktest) sendTelegramAlert(slMsg).catch(() => { });
                        console.log(`[JOURNAL] ${isPartialClose ? '⚠️ SL Post-Parcial (BREAKEVEN)' : '🔴 SL alcanzado (LOSS)'}: ${ticker} #${tradeId}`);
                        continue;
                    }
                }
            }

            const touchedThisPing: { zone: RadarZone; eventName: string; pts: number }[] = [];
            const buffer = getBuffer(ticker, currentPrice);

            for (const zone of state.zones) {
                if (currentPrice <= (zone.top + buffer) && currentPrice >= (zone.btm - buffer)) {
                    const hasPreviousPrice = previousPrice !== null;
                    const enteredFromAbove = hasPreviousPrice && previousPrice > zone.top;
                    const enteredFromBelow = hasPreviousPrice && previousPrice < zone.btm;

                    const isValidDirection = (zone.dir === 'BUY' && enteredFromAbove) ||
                        (zone.dir === 'SELL' && enteredFromBelow);
                    const isFirstPing = !hasPreviousPrice;

                    if (!isValidDirection && !isFirstPing) {
                        console.log(`[PING] Toque ignorado por dirección incorrecta: ${zone.dir} zone, price ${currentPrice}, prev ${previousPrice}`);
                        continue;
                    }

                    const activeScore = zone.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
                    const zTf = parseTF(zone.tf || '');
                    let basePts = zone.score !== undefined ? zone.score : 2;

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

                    let eventName = zone.medal?.includes('God') ? `💎_GOD_ZONE_${zTf}` :
                        zone.medal?.includes('CHoCH') ? `🎯_Silver_Bullet_${zTf}` :
                            zone.medal?.includes('Breaker') ? `♻️_Breaker_${zTf}` :
                                `OB_${zone.medal}_${zTf}`;

                    let tfMultiplier = zTf === '4H' ? 2 : zTf === '1H' ? 1.5 : 1;
                    // 🆕 sep-2026 (Capa 1): multiplicador por familia × sesión (config.zoneWeights)
                    const zwFamily = zone.medal?.includes('God') ? 'GOD' :
                        zone.medal?.includes('CHoCH') ? 'SB' :
                            zone.medal?.includes('Breaker') ? 'BREAKER' : 'OB';
                    const zwMultLive = zoneWeightMultLive(config, zwFamily, getCurrentSession(nowMs));
                    let pts = Math.floor(basePts * tfMultiplier * confluenceMultiplier * zwMultLive);

                    if (addScoreEvent(activeScore, { id: eventName, pts, tf: zone.tf || eventTf, ts: nowMs })) {
                        touchedThisPing.push({ zone, eventName, pts });

                        if (confluenceMultiplier > 1.0) {
                            const tfTags = confluenceTFs.map(t => parseTF(t)).join('+');
                            console.log(`[RADAR] 🧲 CONFLUENCIA ${confluenceMultiplier}x en ${ticker} ${zone.dir}: ${zTf} + (${tfTags}) = ${pts} pts`);
                        }
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
        }
        else if (currentDirection) {
            const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
            const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
            let addedPoints = 0;
            let addedEventId: string | null = null;

            if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') {
                // 🔍 DIAGNÓSTICO
                console.log(`[RADAR] 📡 ${prefix} ${currentDirection} ${ticker} TF=${eventTf} price=${state.lastPrice}`);
                state.marketBias[eventTf] = currentDirection;
                // 🆕 sep-2026: registrar el momento del cambio de bias (para smartBiasFreshGuard)
                if (!state.biasTs) state.biasTs = {};
                state.biasTs[eventTf] = nowMs;

                // 💥 Invalidación estructural acotada: el CHoCH/BOS borra del score CONTRARIO
                // los eventos de TF de igual o menor jerarquía que el gatillo
                structuralInvalidate(oppositeScore, eventTf, nowMs);

                const priceMatchChoch = alertText.match(/Precio:\s*([0-9.,]+)/i);
                const actualPrice = priceMatchChoch ? parseTVPrice(priceMatchChoch[1]) : state.lastPrice;
                // 🔧 FIX: Actualizar lastPrice con el precio del CHoCH para que el entry use precio actualizado
                if (priceMatchChoch && actualPrice) state.lastPrice = actualPrice;

                if (eventTf === '5' || eventTf === '15') {
                    const originMatch = alertText.match(/ORIGIN:\s*([0-9.,]+)/i);

                    if (originMatch && actualPrice) {
                        const newOrigin = parseTVPrice(originMatch[1]);
                        const isBuy = currentDirection === 'BUY';
                        const activeLeg = isBuy ? state.activeImpulseBuy : state.activeImpulseSell;

                        let shouldCreateNew = true;
                        if (activeLeg) {
                            const isInsideRange = actualPrice > Math.min(activeLeg.origin, activeLeg.extreme) && actualPrice < Math.max(activeLeg.origin, activeLeg.extreme);
                            if (isInsideRange) shouldCreateNew = false;

                            // 🛡️ Anti-Pingpong: No crear leg nuevo si el anterior tiene < 3 min
                            // Solo aplica en tiempo real (no en bootstrap/backtest donde los
                            // timestamps son sintéticos y múltiples BOS comparten el mismo TS de vela).
                            const LEG_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutos
                            if (!isBootstrap && !isBacktest) {
                                const elapsed = nowMs - activeLeg.createdAt;
                                if (activeLeg.createdAt && elapsed >= 0 && elapsed < LEG_COOLDOWN_MS) {
                                    shouldCreateNew = false;
                                    console.log(`[FIBO] ⚠️ ${prefix} ${currentDirection} ignorado en ${ticker}: leg anterior tiene ${Math.round(elapsed / 1000)}s (cooldown 3 min)`);
                                }
                            }
                        }

                        // 🛡️ Rango mínimo del impulso: |extreme - origin| debe superar el umbral
                        // Umbral adaptado por ticker (forex majors ~2 pips, crypto ~0.02%, índices ~0.05%)
                        const impulseRange = Math.abs(actualPrice - newOrigin);
                        let minImpulseRange: number;
                        if (ticker.includes('BTC') || ticker.includes('ETH')) {
                            minImpulseRange = actualPrice * 0.0005; // 0.05% para crypto
                        } else if (ticker.includes('JPY')) {
                            minImpulseRange = 0.02; // 2 pips para pares JPY
                        } else if (ticker.includes('US30') || ticker.includes('NAS') || ticker.includes('SPX') || ticker.includes('DXY')) {
                            minImpulseRange = actualPrice * 0.0003; // 0.03% para índices
                        } else {
                            // Forex majors (EURUSD, GBPUSD, etc.): ~1-2 pips
                            minImpulseRange = 0.00015; // 1.5 pips
                        }
                        if (impulseRange < minImpulseRange) {
                            shouldCreateNew = false;
                            console.log(`[FIBO] ⚠️ ${prefix} ${currentDirection} en ${ticker}: rango ${impulseRange.toFixed(5)} < mínimo ${minImpulseRange.toFixed(5)}`);
                        }

                        if (shouldCreateNew) {
                            let macroTarget: number | null = null;
                            // 🆕 sep-2026 telemetría: los legs pisados por el impulso nuevo morían
                            // sin registro (el embudo subcontaba muertes → "esperas sin muerte").
                            // Registrar 'reemplazado' para el leg del mismo sentido (activeLeg) y
                            // para el del sentido opuesto si existe.
                            const registerReplacedDeath = (dyingLeg: ImpulseLeg | null) => {
                                if (!dyingLeg || !dyingLeg.createdAt) return;
                                let fam = 'Choch'; let tf = '5m';
                                for (const e of (dyingLeg.chochEvents ?? [])) {
                                    if (String(e).includes('BOS')) fam = 'Bos';
                                    const m = String(e).match(/_(\d+M)$/);
                                    if (m && ['3M', '5M', '15M'].includes(m[1])) tf = m[1].toLowerCase();
                                }
                                telemetry.oteDeath(ticker, getCurrentSession(nowMs), `ote${fam}${tf}`, 'reemplazado');
                            };
                            registerReplacedDeath(activeLeg);
                            if (isBuy && state.activeImpulseSell) { registerReplacedDeath(state.activeImpulseSell); macroTarget = state.activeImpulseSell.origin; state.activeImpulseSell = null; }
                            else if (!isBuy && state.activeImpulseBuy) { registerReplacedDeath(state.activeImpulseBuy); macroTarget = state.activeImpulseBuy.origin; state.activeImpulseBuy = null; }

                            const newLeg: ImpulseLeg = {
                                dir: currentDirection as 'BUY' | 'SELL',
                                origin: newOrigin,
                                extreme: actualPrice,
                                createdAt: nowMs,
                                tp2: macroTarget,
                                oteScored: false
                            };
                            if (parsedExecution.observation?.breakBar && parsedExecution.observation?.impulse && incomingPolicy.profile === 'microstructure_v1') {
                                const setup = getExecutionSnapshot(state, parsedExecution.observation.tf, nowMs);
                                if (setup) newLeg.executionSnapshot = JSON.parse(JSON.stringify(setup));
                            }

                            if (isBuy) state.activeImpulseBuy = newLeg;
                            else state.activeImpulseSell = newLeg;

                            // 🆕 F3-etapa3: TRAILING STOP ESTRUCTURAL POST-TP1 (espejo de backtestEngine.ts:921-960)
                            // Se ejecuta al crearse un impulso NUEVO: si hay un trade abierto post-TP1 del
                            // mismo ticker/dirección con structuralTrailEnabled (congelado por gatillo en
                            // mgmtOverrides al entrar, fallback config del activo), arrastra el SL al nuevo
                            // origin con buffer máx(2×spread, 0.5×ATR). Ratchet: solo mejora ≥ 0.25×ATR.
                            if (!isBootstrap) {
                                const stCfg = getConfigForTicker(ticker, nowMs);
                                const stPip = getPipValue(ticker, actualPrice);
                                for (const [, tTrade] of store.activeTrades) {
                                    if (tTrade.ticker !== ticker) continue;
                                    if (!!(tTrade as any).isBacktest !== isBacktest) continue;
                                    if (tTrade.direction !== currentDirection) continue;
                                    if (!tTrade.tp1Hit) continue;
                                    if (tTrade.executionState?.schema === 1 && (tTrade.executionPolicy?.management || tTrade.executionPolicy?.trailing)) continue;
                                    const stEnabled = tTrade.mgmtOverrides?.structuralTrailEnabled
                                        ?? (stCfg as any).structuralTrailEnabled ?? false;
                                    if (!stEnabled) continue;
                                    const stAtrTrail = (state.atr14 ?? Math.abs(actualPrice - newOrigin) * 0.3) * 0.5;
                                    const stBuffer = Math.max(2 * ((stCfg as any).spreadPips ?? 0.1) * stPip, stAtrTrail);
                                    const trailedSL = currentDirection === 'BUY' ? newOrigin - stBuffer : newOrigin + stBuffer;
                                    const improved = currentDirection === 'BUY'
                                        ? trailedSL > tTrade.slPrice + stAtrTrail * 0.5
                                        : trailedSL < tTrade.slPrice - stAtrTrail * 0.5;
                                    if (!improved) continue;
                                    if (isBacktest) {
                                        tTrade.slPrice = trailedSL;
                                    } else {
                                        tTrade.targetSlPrice = parseFloat(trailedSL.toFixed(getDecimals(ticker)));
                                        tTrade.targetSlPending = true;
                                        tTrade.targetSlRetries = 0;
                                        if (db && !tTrade.isBacktest) db.collection('active_trades').doc(tTrade.tradeId).update({
                                            targetSlPrice: tTrade.targetSlPrice,
                                            targetSlPending: true
                                        }).catch(() => { });
                                        console.log(`[STRAIL] 🧲 ${ticker} ${tTrade.direction} #${tTrade.tradeId}: SL estructural → ${tTrade.targetSlPrice} (origin ${newOrigin}, buffer ${stBuffer.toFixed(5)})`);
                                    }
                                }
                            }
                        }
                    }
                } else if (eventTf === '15' || eventTf === '60' || eventTf === '240' || eventTf === 'D') {
                    const originMatch = alertText.match(/ORIGIN:\s*([0-9.,]+)/i);

                    if (originMatch && actualPrice) {
                        const newOrigin = parseTVPrice(originMatch[1]);
                        const isBuy = currentDirection === 'BUY';

                        const newLeg: ImpulseLeg = {
                            dir: currentDirection as 'BUY' | 'SELL',
                            origin: newOrigin,
                            extreme: actualPrice,
                            createdAt: nowMs,
                            oteScored: false
                        };

                        if (isBuy) state.activeMacroImpulseBuy = newLeg;
                        else state.activeMacroImpulseSell = newLeg;
                        console.log(`[FIBO-MACRO] 🗺️ Creado nuevo ImpulseLeg MACRO (${eventTf}M) ${currentDirection} en ${ticker}: origin=${newOrigin}, extreme=${actualPrice}`);
                    }
                }
                // 🆕 HÍBRIDO: Ponderar score por TF
                const basePoints = prefix === 'EVENTO_CHOCH' ? 3 : 2; // BOS era 1, ahora es 2 (edge > 85%)
                addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
                addedEventId = `${prefix === 'EVENTO_CHOCH' ? 'CHoCH' : 'BOS'}_${readableTf}`;
            }

            if (prefix === 'ZONE_BROKEN') {
                // Filtrado por id de evento: los puntos se recalculan solos vía caché derivado
                activeScore.events = activeScore.events.filter((e: any) => {
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
                // 🔧 FIX: Limpiar las zonas CONTRARIAS rotas del mapa de zonas en RAM
                // ZONE_BROKEN dir=BUY → presión alcista rompió zonas SELL (soportes/supply)
                // ZONE_BROKEN dir=SELL → presión bajista rompió zonas BUY (demanda/demand)
                state.zones = state.zones.filter((z: any) => {
                    if (z.tf !== eventTf) return true;
                    if (currentDirection === 'BUY' && z.dir === 'BUY') return true;   // Mantener zonas BUY (no afectadas)
                    if (currentDirection === 'SELL' && z.dir === 'SELL') return true;  // Mantener zonas SELL (no afectadas)
                    return false; // zona contraria = la que fue rota por la presión, eliminarla
                });
                return;
            }

            if (prefix === 'DIV_BROKEN') {
                activeScore.events = activeScore.events.filter((e: any) => !e.id.startsWith(`DIV_${readableTf}`));
                refreshScoreCache(activeScore, nowMs);
                return;
            }

            if (prefix === 'SWEEP_BROKEN') {
                activeScore.events = activeScore.events.filter((e: any) => {
                    if (e.id === `🩸_V-Shape_Absorb_${readableTf}` || e.id === `Sweep_${readableTf}_Absorcion`) return false;
                    if (e.id === `Sweep_${readableTf}`) return false;
                    if (e.id === `📉_TL_Sweep_${readableTf}`) return false;
                    if (e.id === `🩸_LIQ_GRAB_${readableTf}`) return false;
                    return true;
                });
                refreshScoreCache(activeScore, nowMs);
                return;
            }

            if (prefix === 'TOUCH_ZONE') {
                const ptMatch = alertText.match(/Puntos:\s*(\d+)/i);
                const dynamicPts = ptMatch ? parseInt(ptMatch[1], 10) : 0;
                if (upperText.includes('BREAKER')) {
                    if (!activeScore.events.some((e: any) => e.id === `Breaker_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 3; addedEventId = `Breaker_${readableTf}`; }
                } else if (upperText.includes('PLATINO') || upperText.includes('POC')) {
                    if (!activeScore.events.some((e: any) => e.id === `POC_Volume_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 4; addedEventId = `POC_Volume_${readableTf}`; }
                } else if (upperText.includes('GOD_ZONE') || upperText.includes('ORO')) {
                    if (!activeScore.events.some((e: any) => e.id === `OB_Gold_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 3; addedEventId = `OB_Gold_${readableTf}`; }
                } else {
                    if (!activeScore.events.some((e: any) => e.id === `OB_${readableTf}`)) { addedPoints = dynamicPts > 0 ? dynamicPts : 2; addedEventId = `OB_${readableTf}`; }
                }
            }
            else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
                if (!activeScore.events.some((e: any) => e.id === `Sweep_${readableTf}` || e.id === `🩸_V-Shape_Absorb_${readableTf}`)) {
                    const basePoints = upperText.includes('ABSORCION') ? 6 : 3;
                    // 🆕 sep-2026 (Capa 1): multiplicador SWEEP × sesión
                    const sweepMultLive = zoneWeightMultLive(config, 'SWEEP', getCurrentSession(nowMs));
                    addedPoints = Math.round(basePoints * (TF_WEIGHT[eventTf] || 1) * sweepMultLive);
                    addedEventId = upperText.includes('ABSORCION') ? `🩸_V-Shape_Absorb_${readableTf}` : `Sweep_${readableTf}`;
                }
            }
            else if (prefix === 'EVENTO_SMC_DIV') {
                if (!activeScore.events.some((e: any) => e.id === `DIV_${readableTf}`)) {
                    const dynamicScoreMatch = alertText.match(/Score:\s*([0-9]+)/i);
                    addedPoints = dynamicScoreMatch ? parseInt(dynamicScoreMatch[1]) : 4;

                    // Penalización estadística para SMC_DIV en TF Altos (Estadísticamente tóxico en Daily)
                    if (eventTf === 'D') {
                        addedPoints = 0; // 0 puntos por toxicidad (14% winrate)
                    } else if (eventTf === '240') {
                        addedPoints = Math.min(addedPoints, 2); // Cap de 2 puntos en 4H
                    }
                    // 🆕 sep-2026 (Capa 1): multiplicador DIV × sesión
                    addedPoints = Math.round(addedPoints * zoneWeightMultLive(config, 'DIV', getCurrentSession(nowMs)));

                    addedEventId = `DIV_${readableTf}`;
                }
            }
            else if (prefix === 'LIQ_GRAB') {
                const eventName = `🩸_LIQ_GRAB_${readableTf}`;
                if (!activeScore.events.some((e: any) => e.id === eventName)) {
                    addedPoints = 4 * (TF_WEIGHT[eventTf] || 1); // Falsa ruptura base score

                    // 🌊 TickFlow: clasificar el barrido con micro-estructura de ticks
                    // (institucional = ruptura veloz + absorción + reclaim rápido)
                    const nivelMatch = alertText.match(/Nivel:\s*([0-9.,]+)/i);
                    if (nivelMatch && currentDirection) {
                        try {
                            const sweepLevel = parseTVPrice(nivelMatch[1]);
                            const analysis = tickFlow.analyzeSweep(ticker, sweepLevel, currentDirection, nowMs);
                            console.log(`[TICKFLOW] ${ticker} sweep @${sweepLevel} → ${analysis.classification} (${analysis.reason})`);
                            if (analysis.classification === 'INSTITUTIONAL') {
                                addedPoints = 5 * (TF_WEIGHT[eventTf] || 1);
                            } else if (analysis.classification === 'RETAIL') {
                                addedPoints = 0; // Penalización total para sweeps retail
                            }
                        } catch { /* nunca bloquear scoring por analítica de ticks */ }
                    }

                    addedEventId = eventName;
                }
            }
            // NOTA: EVENTO_BOS ya se procesa en el bloque principal (líneas 1271-1360)
            // El bias y los puntos se asignan allí. Este bloque era redundante.
            else if (prefix === 'HEARTBEAT') {
                // Watchdog: solo actualiza lastHeartbeat, no suma puntos
                state.lastHeartbeat = nowMs;
                const zUpMatch = alertText.match(/Z-Up:\s*(-?[\d.]+)/i);
                const zDnMatch = alertText.match(/Z-Dn:\s*(-?[\d.]+)/i);
                if (zUpMatch) state.zUp = parseFloat(zUpMatch[1]);
                if (zDnMatch) state.zDn = parseFloat(zDnMatch[1]);
                // Extraer conteo de zonas para diagnóstico
                const zonesMatch = alertText.match(/Zones:\s*(\d+)/i);
                const biasMatch = alertText.match(/Bias:\s*(BUY|SELL|NEUTRAL)/i);
                if (zonesMatch) console.log(`[HEARTBEAT] ${ticker} ${eventTf}: ${zonesMatch[1]} zonas activas, bias ${biasMatch?.[1] || '?'}`);
            }
            else if (prefix === 'ZONE_TOUCHED') {
                // Alerta específica de toque de zona — más precisa que PING_PRICE
                const zoneMedal = alertText.match(/Medal:\s*([\w🚀♻️💎]+)/i)?.[1] || 'OB';
                const zoneScore = parseInt(alertText.match(/Score:\s*([0-9]+)/i)?.[1] || '2');
                const eventName = `🎯_ZoneTouched_${zoneMedal}_${readableTf}`;
                if (!activeScore.events.some((e: any) => e.id === eventName)) {
                    const basePoints = zoneScore >= 9 ? 5 : zoneScore >= 7 ? 4 : zoneScore >= 5 ? 3 : 2;
                    addedPoints = basePoints * (TF_WEIGHT[eventTf] || 1);
                    addedEventId = eventName;
                }
            }
            else if (prefix === 'EVENTO_SWEEP_TL') {
                if (!activeScore.events.some((e: any) => e.id === `📉_TL_Sweep_${readableTf}`)) { addedPoints = 2; addedEventId = `📉_TL_Sweep_${readableTf}`; }
                if (oppositeScore.events.some((e: any) => e.id === `📉_TL_Sweep_${readableTf}`)) {
                    oppositeScore.events = oppositeScore.events.filter((e: any) => e.id !== `📉_TL_Sweep_${readableTf}`);
                    refreshScoreCache(oppositeScore, nowMs);
                }
            }
            // FIX: Handler ZONE_TOUCHED duplicado eliminado (ya se procesa en línea 1437)

            if (addedPoints > 0 && addedEventId) {
                // 🛡️ Clamp de seguridad: ningún evento individual puede sumar más de MAX_EVENT_POINTS.
                // Mata toda la clase de bugs de parsing (timestamps, regex) en el punto de suma.
                const MAX_EVENT_POINTS = 50;
                if (addedPoints > MAX_EVENT_POINTS) {
                    console.error(`[RADAR] 🚨 addedPoints anómalo (${addedPoints}) en "${alertText.substring(0, 80)}" → clamp a ${MAX_EVENT_POINTS}`);
                    addedPoints = MAX_EVENT_POINTS;
                }
                addScoreEvent(activeScore, { id: addedEventId, pts: addedPoints, tf: eventTf, ts: nowMs });

                // 🔄 Re-validación tardía: si hay un leg pendiente sin confluencia de zona,
                // ahora que llegó un evento de zona, re-evaluar si ya se puede validar
                if (prefix !== 'EVENTO_CHOCH' && prefix !== 'EVENTO_BOS') {
                    const pendingLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                    if (pendingLeg && !pendingLeg.isValidated && pendingLeg.chochPoints) {
                        const hasZoneNow = activeScore.events.some((e: any) =>
                            e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
                            e.id.includes('Sweep_') || e.id.includes('DIV_') || e.id.includes('TL_Sweep_') ||
                            e.id.includes('ZoneTouched_') || e.id.includes('Silver_Bullet_')
                        );
                        if (hasZoneNow) {
                            pendingLeg.isValidated = true;
                            pendingLeg.chochEvents = [...activeScore.events.map((e: any) => e.id), `CHoCH_${readableTf}`];
                            console.log(`[RADAR] ✅ Leg ${currentDirection} en ${ticker} VALIDADO tardíamente con confluencia: ${addedPoints} pts de ${prefix}`);

                            // 🔧 FIX: Disparar trade INMEDIATAMENTE si el leg tiene puntos suficientes
                            // (Evita el retraso de 1 vela cuando el CHoCH no tenía zona al confirmarse)
                            const lateConfig = getConfigForTicker(ticker, nowMs);
                            const canFireChoch = lateConfig.entryTrigger === 'CHOCH' || lateConfig.entryTrigger === 'BOTH' || lateConfig.entryTrigger === 'SMART';
                            const lateMinPts = currentDirection === 'BUY' ? lateConfig.minPointsForBuy : lateConfig.minPointsForSell;
                            const lateTotalPts = pendingLeg.chochPoints!;
                            const cooldownOk = nowMs - (state.lastSniperAlert ?? 0) >= lateConfig.sniperCooldownMs;

                            // 🛡️ FIX ago-2026 (gatillos 15m/OTE sin entradas): este path NO respetaba la
                            // config por gatillo (enabled/minScore) y los eventos 5m copaban las entradas
                            // en sesiones donde están deshabilitados, consumiendo el cooldown antes del 15m.
                            // Ahora se consulta el gatillo real de la TF del leg (igual que la Capa 4).
                            const lateLegEvs = pendingLeg.chochEvents || [];
                            const lateEntryEv = lateLegEvs.find((e: string) => e.includes('🚀') || e.includes('🔨'));
                            const lateStructEv = lateEntryEv ?? lateLegEvs.find((e: string) => /^(CHoCH|BOS)_/.test(e));
                            const lateLegFam = lateStructEv?.includes('BOS') ? 'BOS' : 'CHoCH';
                            const lateLegTf = (lateStructEv?.match(/_(\d+M|1H|4H|D|W)$/)?.[1] ?? '5m').toLowerCase();
                            const lateSessionKey = getCurrentSession(nowMs);
                            const lateSessionCfg = (lateConfig.sessions as any)?.[lateSessionKey] ?? (lateConfig.sessions as any)?.['ALL'];
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
                            if (!lateTriggerEnabled) {
                                console.log(`[RADAR] 🚫 Re-val tardía ${ticker}: gatillo ${lateTriggerKey} deshabilitado en ${lateSessionKey} (config por gatillo).`);
                            }

                            if (canFireChoch && lateConfig.sessionEnabled && lateTriggerEnabled && cooldownOk && lateTotalPts >= lateMinPtsG) {
                                const dec = getDecimals(ticker);
                                const slBuf = calculateDynamicSlBuffer(ticker, pendingLeg.origin, 0);
                                const adjSL = currentDirection === 'BUY' ? pendingLeg.origin - slBuf : pendingLeg.origin + slBuf;
                                const latePolicy = resolveExecutionPolicy(lateConfig.executionPolicy);
                                const lateSnapshot = latePolicy.profile === 'microstructure_v1' ? getExecutionSnapshot(state, pendingLeg.executionSnapshot?.tf ?? lateLegTf, nowMs) : undefined;
                                const curPrice = latePolicy.profile === 'microstructure_v1'
                                    ? (currentDirection === 'BUY' ? lateSnapshot?.quote?.ask : lateSnapshot?.quote?.bid) ?? NaN : state.lastPrice ?? pendingLeg.extreme;
                                const rDist = Math.abs(curPrice - adjSL);

                                // SMART mode: verificar distancia excesiva al origen
                                let fireNow = true;
                                if (lateConfig.entryTrigger === 'SMART' && latePolicy.smart) {
                                    const instrument = getLiveExecutionInstrument(ticker) ?? (lateConfig.executionInstrument?.source === 'explicit_model' ? lateConfig.executionInstrument : undefined);
                                    fireNow = routeExecutionSetup(state, pendingLeg, { ...lateConfig, executionInstrument: instrument }, parsedExecution.observation?.tf ?? pendingLeg.executionSnapshot?.tf ?? lateLegTf,
                                        nowMs, curPrice, adjSL, curPrice + (currentDirection === 'BUY' ? 1 : -1) * rDist * lateConfig.fixedRR).takeDirectNow;
                                } else if (lateConfig.entryTrigger === 'SMART') {
                                    const maxRisk = lateConfig.maxSmartRiskPercent !== undefined ? lateConfig.maxSmartRiskPercent : 0.15;
                                    const pctLimit = curPrice * (maxRisk / 100);
                                    let atr = 0;
                                    for (let i = state.zones.length - 1; i >= 0; i--) { if (state.zones[i].atr) { atr = state.zones[i].atr!; break; } }
                                    if (rDist > (atr > 0 ? atr * 1.5 : pctLimit)) {
                                        fireNow = false;
                                        telemetry.oteWait(ticker, lateSessionKey, `ote${lateLegFam === 'BOS' ? 'Bos' : 'Choch'}${lateLegTf}`);
                                        console.log(`[RADAR] 🧠 Re-val tardía ${ticker}: distancia excesiva, esperando OTE.`);
                                    }
                                }

                                // 🆕 sep-2026 biasGateStrict: mismo gate estricto en la re-validación tardía
                                const biasGateLate = (lateConfig as any).biasGateStrict === true
                                    && (state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL')
                                    && (state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL');
                                if (biasGateLate) {
                                    fireNow = false;
                                    console.log(`[RADAR] 🚫 BiasGate estricto (re-val tardía): 4H y 1H en contra en ${ticker}.`);
                                }

                                if (fireNow) {
                                    telemetry.directEntry(ticker, lateSessionKey, lateTriggerKey);
                                    const fTP1 = currentDirection === 'BUY' ? curPrice + rDist : curPrice - rDist;
                                    const fTP2 = currentDirection === 'BUY' ? curPrice + (rDist * lateConfig.fixedRR) : curPrice - (rDist * lateConfig.fixedRR);
                                    const tId = Math.random().toString(36).substring(2, 8).toUpperCase();
                                    const legTfMatch = (pendingLeg.chochEvents || []).find((e: string) => e.includes('CHoCH') || e.includes('BOS'));
                                    const legTf = legTfMatch ? (legTfMatch.match(/(\d+M)/)?.[1] || readableTf) : readableTf;

                                    oteData = {
                                        tradeId: tId, direction: currentDirection,
                                        dirText: currentDirection === 'BUY' ? 'COMPRA' : 'VENTA',
                                        stopLoss: adjSL.toFixed(dec), tp1: fTP1.toFixed(dec), tp2: fTP2.toFixed(dec),
                                        entryPrice: curPrice,
                                        points: lateTotalPts, events: pendingLeg.chochEvents || activeScore.events.map((e: any) => e.id),
                                        chochPoints: pendingLeg.chochPoints ?? 0, // 🆕 16-sep: feature para el gate ML extendido
                                        confluenceReport: (pendingLeg.chochReport || '') + `\n🔄 <b>Re-validación Tardía:</b> Leg validado por ${prefix} (+${addedPoints} pts).`,
                                        bestZone: pendingLeg.bestZone || null,
                                        marketBias: { ...state.marketBias },
                                        isChochEntry: true,
                                        ...(latePolicy.profile === 'microstructure_v1' ? { executionTf: lateSnapshot?.tf } : {}),
                                        tf: legTf
                                    };
                                    triggerOte = true;
                                    state.lastSniperAlert = nowMs;
                                    activeScore.events = []; refreshScoreCache(activeScore, nowMs);
                                    const oppScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
                                    oppScore.events = []; refreshScoreCache(oppScore, nowMs);
                                    if (lateConfig.entryTrigger === 'CHOCH' || lateConfig.entryTrigger === 'SMART') pendingLeg.oteScored = true;
                                    console.log(`[RADAR] 🎯 Re-validación tardía: trade INMEDIATO ${ticker} ${currentDirection} (${lateTotalPts} pts)`);
                                }
                            }
                        }
                    }
                }
            }

            // --- CAPA 4: VALIDACIÓN DEL CHOCH / BOS ---
            // 🆕 v5.5 HÍBRIDO: Permitir que 15M (o 5M) actúe como gatillo principal en lugar de solo 3M
            if ((prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') && (eventTf === '5' || eventTf === '15')) {
                const triggerType = prefix === 'EVENTO_CHOCH' ? 'CHoCH🚀' : 'BOS🔨';

                // 🧹 1. FIX DE MEMORIA FANTASMA (Cooldown)
                // Durante el cooldown, NO reseteamos el score — se acumula para el siguiente CHoCH.
                const config = getConfigForTicker(ticker, nowMs);
                if (nowMs - (state.lastSniperAlert ?? 0) < config.sniperCooldownMs) {
                    console.log(`[RADAR] ${triggerType} ignorado por Cooldown en ${ticker} (score preservado: ${computePoints(activeScore, nowMs)} pts).`);
                    return;
                }

                // 🗺️ 2. ANÁLISIS ESPACIAL HOLÍSTICO (reemplaza hasHTFBacking secuencial)
                // Busca respaldo en el MAPA de zonas, no en la mochila de eventos pasados.
                const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                const chOrigin = activeLeg ? activeLeg.origin : null;
                const chExtreme = activeLeg ? activeLeg.extreme : null;
                const spatialBuffer = getBuffer(ticker, chOrigin ?? state.lastPrice ?? 0);
                const chLow = chOrigin && chExtreme ? Math.min(chOrigin, chExtreme) : null;
                const chHigh = chOrigin && chExtreme ? Math.max(chOrigin, chExtreme) : null;

                // 🏋️ Pesos espaciales: TF más alto → más respaldo macro
                const SPATIAL_WEIGHT: Record<string, number> = { '15': 1.0, '60': 1.5, '240': 2.0 };

                // CASO A: El ORIGEN del CHoCH nació DENTRO de una zona macro
                let caseA_OriginInZone = false;
                let caseA_MaxWeight = 0;
                let caseA_BestTF = '';
                if (chOrigin) {
                    for (const z of state.zones) {
                        if (z.dir !== currentDirection) continue;
                        if (chOrigin <= (z.top + spatialBuffer) && chOrigin >= (z.btm - spatialBuffer)) {
                            const w = SPATIAL_WEIGHT[z.tf || ''] || 1.0;
                            if (w > caseA_MaxWeight) { caseA_MaxWeight = w; caseA_BestTF = z.tf || ''; }
                            caseA_OriginInZone = true;
                        }
                    }
                }

                // CASO B: La VELA del CHoCH TOCÓ una zona macro en su recorrido
                let caseB_PathTouchedZone = false;
                let caseB_MaxWeight = 0;
                let caseB_BestTF = '';
                if (chLow !== null && chHigh !== null) {
                    for (const z of state.zones) {
                        if (z.dir !== currentDirection) continue;
                        if (chHigh >= (z.btm - spatialBuffer) && chLow <= (z.top + spatialBuffer)) {
                            const w = SPATIAL_WEIGHT[z.tf || ''] || 1.0;
                            if (w > caseB_MaxWeight) { caseB_MaxWeight = w; caseB_BestTF = z.tf || ''; }
                            caseB_PathTouchedZone = true;
                        }
                    }
                }

                const spatialMaxWeight = Math.max(caseA_MaxWeight, caseB_MaxWeight);
                const spatialBonus = Math.round(spatialMaxWeight * 5);

                // CASO C: Zona contraria DENTRO del rango del CHoCH (trampa / liquidity grab)
                const caseC_TrapZone = (chLow !== null && chHigh !== null) ? state.zones.filter((z: any) =>
                    z.dir !== currentDirection &&
                    z.top >= chLow && z.btm <= chHigh
                ).length : 0;

                // El respaldo viene del mapa espacial Y/O de la mochila secuencial
                const hasSpatialBacking = caseA_OriginInZone || caseB_PathTouchedZone;
                const hasSequentialBacking = activeScore.events.some((e: any) =>
                    e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
                    e.id.includes('ZoneTouched_') || e.id.includes('OTE_') ||
                    (e.id.includes('DIV_') && !e.id.includes('_3')) ||
                    (e.id.includes('Sweep_') && !e.id.includes('_3')) ||
                    (e.id.includes('TL_Sweep_') && !e.id.includes('_3'))
                );
                const hasHTFBacking = hasSpatialBacking || hasSequentialBacking;

                if (caseA_OriginInZone) console.log(`[RADAR] 🗺️ Caso A | Origen ${chOrigin} nació dentro de zona macro.`);
                if (caseB_PathTouchedZone && !caseA_OriginInZone) console.log(`[RADAR] 🗺️ Caso B | Vela CHoCH (${chLow}-${chHigh}) tocó zona macro en su camino.`);
                if (caseC_TrapZone > 0) console.log(`[RADAR] ⚠️ Caso C | ${caseC_TrapZone} zona(s) contraria(s) dentro del CHoCH → posible trampa.`);

                const is15MAgainst = state.marketBias['15'] !== currentDirection && state.marketBias['15'] !== 'NEUTRAL';
                // 🛡️ sep-2026: bono de alineación parametrizado por activo (biasConfluence, Paso 1).
                // Default = escalonado macro (3/3=+5, 2/3=+2, ≤1=0). El set puede incluir TFs rápidos
                // ('5','15'): el TF del gatillo cuenta como alineado con la dirección por definición.
                // El optimizador puede sortear esta config por activo (el optimizador propone, nunca aplica).
                const bcLive = (config as any).biasConfluence ?? DEFAULT_BIAS_CONFLUENCE;
                const biasAlignedForLive = (tf: string): boolean => {
                    if (tf === eventTf) return true; // el gatillo es el bias más fresco de su TF
                    return state.marketBias[tf] === currentDirection;
                };
                const macroAlignedCount = bcLive.tfs.reduce((acc: number, tf: string) => acc + (biasAlignedForLive(tf) ? 1 : 0), 0);
                const isDAgainst = state.marketBias['D'] !== currentDirection && state.marketBias['D'] !== 'NEUTRAL';
                const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
                const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';

                let baseBiasPoints = macroAlignedCount >= bcLive.minForFull ? bcLive.fullPts
                    : macroAlignedCount >= bcLive.minForHalf ? bcLive.halfPts : 0;

                // Los bonus VWAP / Macro OTE entran como eventos (pts incluidos en computePoints)
                // 🆕 sep-2026: peso VWAP por activo (hyperopt → Firestore vwapPts), default 2
                const vwapPtsLive = (config as any).vwapPts ?? 2;
                if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') addScoreEvent(activeScore, { id: 'VWAP_Discount', pts: vwapPtsLive, tf: eventTf, ts: nowMs });
                else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') addScoreEvent(activeScore, { id: 'VWAP_Premium', pts: vwapPtsLive, tf: eventTf, ts: nowMs });

                // Sumamos todo el puntaje bruto inicial
                let macroOteBonus = 0;
                const activeMacroLeg = currentDirection === 'BUY' ? state.activeMacroImpulseBuy : state.activeMacroImpulseSell;
                if (activeMacroLeg && isInsideMacroOteZone(activeMacroLeg, chExtreme ?? state.lastPrice ?? 0)) {
                    macroOteBonus = 6; // +6 Puntos de confluencia por OTE macro activa
                    addScoreEvent(activeScore, { id: 'Macro_OTE_Confluence', pts: 6, tf: eventTf, ts: nowMs });
                }

                let totalPoints = computePoints(activeScore, nowMs) + baseBiasPoints + 2;
                let orphanPenalty = 0;
                let rawPenalty = 0;

                // 🛡️ 3. BONO ESPACIAL + PENALIZACIONES
                // El bono espacial reemplaza la penalización cuando hay respaldo por mapa
                if (hasSpatialBacking && spatialBonus > 0) {
                    totalPoints += spatialBonus; // +5 a +10 pts según TF
                    orphanPenalty = 0; // sin penalización porque el mapa respalda
                } else {
                    // 🔧 FIX: Penalización por CHoCH huérfano (sin zonas en memoria).
                    // Crypto (BTC/ETH): -1 pt (mercado 24/7, CHoCHs más frecuentes, zonas más volátiles)
                    // Forex/Índices: -3 pts (sesiones definidas, zonas más estables)
                    // PERO: si el puntaje bruto sin penalizar ya es ≥12, la penalización se ANULA.
                    const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
                    rawPenalty = !hasHTFBacking ? (isCrypto ? 1 : 3) : 0;
                    const wouldBeAfterPenalty = totalPoints - rawPenalty;
                    if (rawPenalty > 0 && totalPoints >= 12 && wouldBeAfterPenalty >= 5) {
                        // ⚡ BYPASS: puntaje alto vence la penalización
                        orphanPenalty = 0;
                    } else {
                        orphanPenalty = rawPenalty;
                    }
                    if (orphanPenalty > 0) totalPoints -= orphanPenalty;
                }
                if (isDAgainst) totalPoints -= 2;
                if (is4HAgainst && is1HAgainst) totalPoints -= 3;
                // 🆕 sep-2026 biasGateStrict (flag OFF por defecto; para A/B backtest):
                // bloquea entradas con 4H y 1H en contra (más estricto que la penalización).
                const biasGateStrict = (config as any).biasGateStrict === true;
                const biasBlocked = biasGateStrict && is4HAgainst && is1HAgainst;
                if (biasBlocked) {
                    console.log(`[RADAR] 🚫 BiasGate estricto: 4H y 1H en contra → entrada bloqueada en ${ticker} ${currentDirection}.`);
                }
                // Penalización por zona trampa (Caso C)
                const trapPenalty = caseC_TrapZone > 0 ? caseC_TrapZone * 2 : 0;
                if (trapPenalty > 0) totalPoints -= trapPenalty;

                // 📊 4. ARMADO DE REPORTE PARA TELEGRAM
                const getIcon = (tf: string) => state.marketBias[tf] === 'BUY' ? '🟢' : state.marketBias[tf] === 'SELL' ? '🔴' : '⚪';

                let confluenceReport = `🗺️ <b>Contexto Macro:</b>\n`;
                confluenceReport += `${getIcon("D")} D: ${state.marketBias["D"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("240")} 4H: ${state.marketBias["240"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("60")} 1H: ${state.marketBias["60"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon("15")} 15M: ${state.marketBias["15"] || 'NEUTRAL'}\n`;
                confluenceReport += `${getIcon(eventTf)} Gatillo ${readableTf}: ${currentDirection} (${triggerType})\n\n`;
                confluenceReport += `⚖️ <b>Bono de Alineación Macro:</b> +${baseBiasPoints} Pts\n`;
                if (macroOteBonus > 0 && activeMacroLeg) {
                    confluenceReport += `🎯 <b>Confluencia OTE Fractal:</b> +${macroOteBonus} Pts (Precio en OTE Macro [Origin: ${activeMacroLeg.origin.toFixed(5)} | Extreme: ${activeMacroLeg.extreme.toFixed(5)}])\n`;
                }
                if (hasSpatialBacking) {
                    const tfLabel = spatialMaxWeight >= 2.0 ? '4H' : spatialMaxWeight >= 1.5 ? '1H' : '15M';
                    confluenceReport += `🗺️ <b>Respaldo Espacial:</b> +${spatialBonus} pts (zona ${tfLabel}, peso ×${spatialMaxWeight})\n`;
                    if (caseA_OriginInZone) confluenceReport += `   📍 Caso A: Origen dentro de zona macro\n`;
                    if (caseB_PathTouchedZone && !caseA_OriginInZone) confluenceReport += `   🛤️ Caso B: Vela CHoCH tocó zona en su camino\n`;
                }
                if (caseC_TrapZone > 0) confluenceReport += `⚠️ <b>Alerta Trampa:</b> ${caseC_TrapZone} zona(s) contraria(s) detectada(s) (-${trapPenalty} pts)\n`;
                // 🔧 FIX: Usar rawPenalty para detectar bypass (orphanPenalty ya es 0 si fue anulado)
                if (rawPenalty > 0 && orphanPenalty === 0) {
                    // High-score bypass: la penalización se anuló por puntaje alto
                    confluenceReport += `⚡ <b>BYPASS PUNTAJE ALTO:</b> Penalización de -${rawPenalty} pts ANULADA (${totalPoints} pts brutos ≥ 12). Entrada validada sin zonas macro.\n`;
                } else if (orphanPenalty > 0) {
                    confluenceReport += `⚠️ <b>Penalización CHoCH sin zonas macro:</b> -${orphanPenalty} Pts (las zonas HTF aún no sincronizaron o expiraron)\n`;
                }
                if (!hasSpatialBacking && !hasSequentialBacking && orphanPenalty === 0) confluenceReport += `ℹ️ <b>Sin respaldo de zonas:</b> se permite por bono macro suficiente\n`;
                // 🎯 5. VALIDACIÓN FINAL Y GATILLO
                // (sessionThresholds defined at the top of the function)

                if (!config.sessionEnabled) {
                    console.log(`[RADAR] 🚫 Trading desactivado para ${ticker} en esta sesión`);
                    return;
                }

                const currentSession = getCurrentSession(nowMs);
                // 🆕 FIX: fallback a 'ALL' (el panel exporta la sesión OFF como ALL)
                const sessionConfig = config.sessions?.[currentSession] ?? (config.sessions as any)?.['ALL'];

                let triggerEnabled = false;
                let liveTriggerCfg: any = null; // 🆕 config del gatillo que dispara (genes tuneados)
                let minPtsRequired = currentDirection === 'BUY'
                    ? (sessionThresholds?.buy || config.minPointsForBuy)
                    : (sessionThresholds?.sell || config.minPointsForSell);

                if (sessionThresholds) {
                    triggerEnabled = (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                    minPtsRequired = currentDirection === 'BUY' ? sessionThresholds.buy : sessionThresholds.sell;
                } else if (sessionConfig) {
                    const tfKeyChoch = `choch${eventTf}m` as keyof typeof sessionConfig;
                    const tfKeyBos = `bos${eventTf}m` as keyof typeof sessionConfig;

                    if (triggerType === 'CHoCH🚀') {
                        const tfConfig = sessionConfig[tfKeyChoch] as any;
                        if (tfConfig) {
                            liveTriggerCfg = tfConfig;
                            triggerEnabled = tfConfig.enabled ?? false;
                            minPtsRequired = currentDirection === 'BUY'
                                ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? config.minPointsForBuy)
                                : (tfConfig.minScoreSell ?? tfConfig.minScore ?? config.minPointsForSell);
                        } else if ((sessionConfig as any).choch) {
                            triggerEnabled = (sessionConfig as any).choch.enabled ?? false;
                            minPtsRequired = (sessionConfig as any).choch.minScore ?? (currentDirection === 'BUY' ? config.minPointsForBuy : config.minPointsForSell);
                        }
                    } else if (triggerType === 'BOS🔨') {
                        const tfConfig = sessionConfig[tfKeyBos] as any;
                        if (tfConfig) {
                            liveTriggerCfg = tfConfig;
                            triggerEnabled = tfConfig.enabled ?? false;
                            minPtsRequired = currentDirection === 'BUY'
                                ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? config.minPointsForBuy)
                                : (tfConfig.minScoreSell ?? tfConfig.minScore ?? config.minPointsForSell);
                        } else if ((sessionConfig as any).bos) {
                            triggerEnabled = (sessionConfig as any).bos.enabled ?? false;
                            minPtsRequired = (sessionConfig as any).bos.minScore ?? (currentDirection === 'BUY' ? config.minPointsForBuy : config.minPointsForSell);
                        }
                    }
                } else {
                    if (triggerType === 'BOS🔨') {
                        triggerEnabled = (config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                    } else {
                        triggerEnabled = (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
                    }
                }

                const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
                if (isCrypto) minPtsRequired = Math.max(minPtsRequired - 1, 3); // Crypto: 1 punto menos

                const bestZone = state.zones.filter((z: any) => z.dir === currentDirection).sort((a: any, b: any) => (b.score || 0) - (a.score || 0))[0] || null;

                if (true) {
                    const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
                    if (activeLeg) {
                        // 🛡️ Requiere al menos 1 evento de zona real O respaldo espacial del mapa de zonas
                        const hasZoneConfluence = activeScore.events.some((e: any) =>
                            e.id.includes('OB_') || e.id.includes('GOD_') || e.id.includes('Breaker_') ||
                            e.id.includes('Sweep_') || e.id.includes('DIV_') || e.id.includes('TL_Sweep_') ||
                            e.id.includes('ZoneTouched_') || e.id.includes('Silver_Bullet_')
                        );

                        // El respaldo espacial (Caso A/B) también valida: si el CHoCH nació en zona macro
                        // o la tocó en su recorrido, no necesita eventos secuenciales adicionales.
                        // ⚡ HIGH_SCORE_BYPASS: si acumuló ≥12 pts por eventos puros (CHoCH + Sweeps + DIV),
                        // se valida aunque no haya zonas en memoria. Caso típico: reversión contra tendencia
                        // donde 4H/1H son SELL pero 3M hace CHoCH BUY con múltiples confluencias.
                        const HIGH_SCORE_BYPASS = Math.min(minPtsRequired, 8); // Bypass "puntaje alto sin zonas" desacoplado del umbral de entrada
                        const efectiveValidation = hasZoneConfluence || hasSpatialBacking || (totalPoints >= HIGH_SCORE_BYPASS);

                        if (efectiveValidation) {
                            activeLeg.isValidated = true;
                            // 🆕 Plan B ago-2026: señal validada (telemetría de gatillos)
                            telemetry.signal(ticker, currentSession, `${triggerType === 'CHoCH🚀' ? 'choch' : 'bos'}${eventTf}m`);
                            if (!hasZoneConfluence && !hasSpatialBacking && totalPoints >= HIGH_SCORE_BYPASS) {
                                console.log(`[RADAR] ⚡ Leg ${currentDirection} en ${ticker} VALIDADO por PUNTAJE ALTO (${totalPoints} pts ≥ ${HIGH_SCORE_BYPASS}) sin zonas en memoria.`);
                            } else if (hasSpatialBacking && !hasZoneConfluence) {
                                console.log(`[RADAR] ✅ Leg ${currentDirection} en ${ticker} VALIDADO por respaldo ESPACIAL (sin eventos secuenciales). Punta: ${totalPoints} pts.`);
                            }
                        } else {
                            console.log(`[RADAR] ⚠️ Leg ${currentDirection} en ${ticker} con ${totalPoints} pts pero SIN confluencia de zona ni respaldo espacial. OTE en espera.`);
                            activeLeg.isValidated = false;
                        }

                        activeLeg.chochPoints = totalPoints;
                        activeLeg.chochEvents = [...activeScore.events.map((e: any) => e.id), `${triggerType}_${readableTf}`];
                        activeLeg.chochReport = confluenceReport;
                        activeLeg.bestZone = bestZone;

                        if (efectiveValidation && triggerEnabled && !biasBlocked && totalPoints >= minPtsRequired) {
                            const decimals = getDecimals(ticker);
                            const currentSession = getCurrentSession(nowMs);
                            const sessionConfig = config.sessions?.[currentSession] ?? (config.sessions as any)?.['ALL'];
                            // 🔧 FIX: usar buffer configurado (no 0) + piso mínimo para
                            // que cTrader acepte el SL/TP (rechaza distancias < ~10 pips forex).
                            const rawBuffer = liveTriggerCfg?.slBuff ?? sessionConfig?.slBufferPercent ?? config.slBufferPercent;
                            let slBufferAmt = calculateDynamicSlBuffer(ticker, activeLeg.origin, rawBuffer);
                            // Piso absoluto: 10 pips forex (0.0010), 100 puntos índices, 1.0 crypto/commodities
                            const minPipDist = getMinPipDistance(ticker);
                            if (slBufferAmt < minPipDist) slBufferAmt = minPipDist;
                            const adjustedSL = currentDirection === 'BUY' ? activeLeg.origin - slBufferAmt : activeLeg.origin + slBufferAmt;
                            const stopLoss = adjustedSL.toFixed(decimals);
                            // 🆕 ago-2026 Ronda 2: SL/TP y riesgo 1% se calculan contra el precio del
                            // BROKER (bid/ask vivo <30s, lado correcto) — no contra state.lastPrice
                            // del radar, que puede divergir pips del fill real (caso USOIL: 9 pips).
                            const baEntry = getLastBidAsk(ticker);
                            const setupPolicy = resolveExecutionPolicy(config.executionPolicy);
                            const setupTf = parsedExecution.observation?.tf ?? eventTf;
                            const setupSnapshot = setupPolicy.profile === 'microstructure_v1' ? getExecutionSnapshot(state, setupTf, nowMs) : undefined;
                            const currentPrice = setupPolicy.profile === 'microstructure_v1'
                                ? (currentDirection === 'BUY' ? setupSnapshot?.quote?.ask : setupSnapshot?.quote?.bid) ?? NaN
                                : (baEntry && Date.now() - baEntry.ts < 30_000)
                                ? (currentDirection === 'BUY' ? baEntry.ask : baEntry.bid)
                                : (state.lastPrice ?? activeLeg.extreme);
                            const riskDist = Math.abs(currentPrice - adjustedSL);
                            const fixedTP1 = currentDirection === 'BUY'
                                ? currentPrice + riskDist
                                : currentPrice - riskDist;
                            const tp1 = fixedTP1.toFixed(decimals);
                            const fixedTP2 = currentDirection === 'BUY'
                                ? currentPrice + (riskDist * (liveTriggerCfg?.tp2 ?? config.fixedRR))
                                : currentPrice - (riskDist * (liveTriggerCfg?.tp2 ?? config.fixedRR));
                            const tp2 = fixedTP2.toFixed(decimals);
                            const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                            oteData = {
                                tradeId, direction: currentDirection,
                                dirText: currentDirection === 'BUY' ? 'COMPRA' : 'VENTA',
                                stopLoss, tp1, tp2, entryPrice: currentPrice,
                                points: totalPoints, events: [...activeScore.events.map((e: any) => e.id), `${triggerType}_${readableTf}`],
                                chochPoints: activeLeg?.chochPoints ?? 0, // 🆕 16-sep: feature para el gate ML extendido
                                confluenceReport: confluenceReport || '',
                                bestZone, marketBias: { ...state.marketBias },
                                isChochEntry: true,
                                ...(setupPolicy.profile === 'microstructure_v1' ? { executionTf: setupTf } : {}),
                                tf: readableTf,
                                // 🆕 genes de gestión tuneados por el auto-tune para ESTE gatillo
                                mgmtOverrides: extractMgmtOverrides(liveTriggerCfg)
                            };
                            let takeChoch = false;
                            let disableOte = false;
                            let smartReport = '';

                            let oteSessionEnabled = false;
                            if (sessionConfig) {
                                const oteTfKeyChoch = `oteChoch${eventTf}m` as keyof typeof sessionConfig;
                                const oteTfKeyBos = `oteBos${eventTf}m` as keyof typeof sessionConfig;

                                if (triggerType === 'CHoCH🚀') {
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

                            if (config.entryTrigger === 'SMART' && setupPolicy.smart) {
                                const instrument = getLiveExecutionInstrument(ticker) ?? (config.executionInstrument?.source === 'explicit_model' ? config.executionInstrument : undefined);
                                const decision = routeExecutionSetup(state, activeLeg, { ...config, executionInstrument: instrument }, setupTf, nowMs, currentPrice, adjustedSL, fixedTP2);
                                takeChoch = decision.takeDirectNow;
                                disableOte = decision.takeDirectNow;
                                oteData.executionDecision = decision;
                                oteData.executionTf = setupTf;
                                smartReport = `\nExecution microstructure_v1: ${decision.reason}`;
                            } else if (config.entryTrigger === 'SMART') {
                                function parseTfToMinutes(tfStr: string): number {
                                    if (!tfStr) return 0;
                                    const upper = tfStr.toUpperCase();
                                    if (upper === 'D' || upper === '1D') return 1440;
                                    if (upper === 'W' || upper === '1W') return 10080;
                                    const val = parseInt(upper);
                                    if (!isNaN(val)) {
                                        if (upper.includes('H')) return val * 60;
                                        return val;
                                    }
                                    return 0;
                                }

                                const signalTfMs = parseTfToMinutes(readableTf);

                                // 🔧 MEJORA 1: Filtrar Paredes de Papel (Ignorar debiles y de menor TF)
                                const oppositeZones = state.zones.filter((z: any) => {
                                    if (z.dir === currentDirection) return false;
                                    if (z.medal === 'SMC_DIV') return false; // Divergencias no son zonas duras

                                    const zTfMs = parseTfToMinutes(z.tf || '');
                                    const isStrong = z.lvl === 'Strong' || z.medal?.includes('GOD');

                                    // Consideramos el obstáculo SI es fuerte O SI es de igual/mayor temporalidad
                                    return isStrong || zTfMs >= signalTfMs;
                                });

                                let closestZonePrice = currentDirection === 'BUY' ? Infinity : 0;
                                for (const z of oppositeZones) {
                                    if (currentDirection === 'BUY' && z.btm > currentPrice && z.btm < closestZonePrice) closestZonePrice = z.btm;
                                    else if (currentDirection === 'SELL' && z.top < currentPrice && z.top > closestZonePrice) closestZonePrice = z.top;
                                }

                                let rrChoch = 3.0; // Default optimista
                                if (closestZonePrice !== Infinity && closestZonePrice !== 0) {
                                    const rewardDist = Math.abs(closestZonePrice - currentPrice);
                                    rrChoch = riskDist > 0 ? rewardDist / riskDist : 3.0;
                                }

                                // 🔧 MEJORA 2: Locomotora Institucional (Ignorar mal RR si el momentum es brutal)
                                const MOMENTUM_EXTREMO_UMBRAL = (minPtsRequired || 8) + 5; // ej: si min es 8, 13 es extremo
                                const hasExtremeMomentum = totalPoints >= MOMENTUM_EXTREMO_UMBRAL;

                                // 🆕 sep-2026 flags de experimento (OFF por defecto, medibles en A/B):
                                const rrThresholdLive = ((config as any).smartAsiaStrict === true && currentSession === 'ASIA') ? 2.0 : 1.5;
                                const biasFreshWindowMsLive = (config as any).smartBiasFreshWindowMs ?? 4 * 3600e3;
                                const biasFreshGuardLive = (config as any).smartBiasFreshGuard === true
                                    && ((state.biasTs?.['240'] && nowMs - state.biasTs['240'] < biasFreshWindowMsLive)
                                        || (state.biasTs?.['60'] && nowMs - state.biasTs['60'] < biasFreshWindowMsLive));

                                // 🔧 MEJORA 3: Límite de distancia al origen (Forzar OTE si el SL queda demasiado lejos)
                                const maxSmartRisk = config.maxSmartRiskPercent !== undefined ? config.maxSmartRiskPercent : 0.15;
                                const limitByPercent = currentPrice * (maxSmartRisk / 100);

                                let latestAtr = 0;
                                for (let i = state.zones.length - 1; i >= 0; i--) {
                                    if (state.zones[i].atr) { latestAtr = state.zones[i].atr!; break; }
                                }

                                const maxAllowedRiskDist = latestAtr > 0 ? latestAtr * 1.5 : limitByPercent;

                                // 🆕 sep-2026 climax por rango (paridad backtest): el tag 'Vol: CLIMAX' no
                                // viaja en los CSVs exportados → el backtest usa rango > 2×ATR. Acá: ambos.
                                const climaxByRangeLive = latestAtr > 0
                                    && ((state.prevClosedHigh ?? 0) - (state.prevClosedLow ?? 0)) > latestAtr * 2;

                                if (riskDist > maxAllowedRiskDist) {
                                    const limitType = latestAtr > 0 ? '1.5x ATR' : `${maxSmartRisk}%`;
                                    smartReport = `\n🧠 <b>Modo SMART:</b> Distancia al origen excesiva (${riskDist.toFixed(decimals)} > ${maxAllowedRiskDist.toFixed(decimals)} [${limitType}]). Vela demasiado extendida. Se fuerza retroceso OTE.`;
                                    takeChoch = false;
                                    disableOte = false;
                                } else if (isClimaxCandle || climaxByRangeLive) {
                                    smartReport = `\n🧠 <b>Modo SMART:</b> Vela de quiebre (CHoCH/BOS) con VOLUMEN EXTREMO detectada. Posible agotamiento. Se fuerza espera a retroceso OTE.`;
                                    takeChoch = false;
                                    disableOte = false;
                                } else if (biasFreshGuardLive && !hasExtremeMomentum) {
                                    // 🆕 sep-2026 smartBiasFreshGuard: bias HTF recién cambiado → OTE
                                    smartReport = `\n🧠 <b>Modo SMART:</b> Bias 4H/1H recién cambiado (ventana ${(biasFreshWindowMsLive / 3600e3).toFixed(0)}h). Riesgo de trampa — se espera retroceso OTE.`;
                                    takeChoch = false;
                                    disableOte = false;
                                } else if (rrChoch >= rrThresholdLive || hasExtremeMomentum) {
                                    if (rrChoch < 1.5) {
                                        smartReport = `\n🧠 <b>Modo SMART:</b> RR Estimado ${rrChoch.toFixed(1)}x. Obstáculo detectado, pero ignorado por MOMENTUM EXTREMO (${totalPoints} pts). Se toma el CHoCH directo.`;
                                    } else {
                                        smartReport = `\n🧠 <b>Modo SMART:</b> RR Estimado ${rrChoch.toFixed(1)}x. Camino despejado. Se toma el CHoCH directo (OTE desactivado).`;
                                    }
                                    takeChoch = true;
                                    disableOte = true;
                                } else {
                                    smartReport = `\n🧠 <b>Modo SMART:</b> RR Estimado ${rrChoch.toFixed(1)}x. Riesgo alto para CHoCH directo, esperando pullback a OTE.`;
                                    takeChoch = false;
                                    disableOte = false;
                                }
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

                            if (!takeChoch) {
                                triggerOte = false; // Bloqueamos la ejecución inmediata de este trade
                                // 🆕 Plan B ago-2026: SMART difiere al OTE (telemetría)
                                telemetry.oteWait(ticker, currentSession, `ote${triggerType === 'CHoCH🚀' ? 'Choch' : 'Bos'}${eventTf}m`);
                                console.log(`[RADAR] 🧠 Modo SMART/OTE: Gatillo inicial omitido para ${ticker}. Esperando retroceso OTE.`);
                            } else {
                                // 🆕 Plan B ago-2026: entrada directa (telemetría)
                                telemetry.directEntry(ticker, currentSession, `${triggerType === 'CHoCH🚀' ? 'choch' : 'bos'}${eventTf}m`);
                                if (smartReport) oteData.confluenceReport += smartReport;
                                triggerOte = true;
                                // ✅ Cooldown y reset SOLO cuando el trade realmente se dispara
                                state.lastSniperAlert = nowMs;
                                activeScore.events = []; refreshScoreCache(activeScore, nowMs);
                                oppositeScore.events = []; refreshScoreCache(oppositeScore, nowMs);
                            }

                            if (disableOte) {
                                activeLeg.oteScored = true; // Al marcarlo puntuado, JARVIS ignorará futuros retrocesos
                            }
                        }
                    }
                }
            }
            else if (prefix === 'HEARTBEAT') state.lastHeartbeat = nowMs;
        }

        // 🔧 FIX v5.4: 15M zones now live 6h (antes 2h) para cubrir el gap entre killzones
        // London 4-6 ART → NY 10:30-12:30 ART = 4.5h sin sync. Con 6h las zonas sobreviven.
        const MAX_ZONE_AGE_MS: Record<string, number> = {
            '3': 1800000, '5': 3600000, '15': 21600000,
            '60': 28800000, '240': 86400000, 'D': 604800000,
        };
        state.zones = state.zones.filter((z: any) => {
            if (!z.createdAt) return true;
            return (nowMs - z.createdAt) < (MAX_ZONE_AGE_MS[z.tf || '60'] || 14400000);
        });

        // 💾 2. GUARDAR LOS CAMBIOS EN LA RAM LOCAL SIEMPRE
        store.localRadarStates.set(ticker, state);

        // 💾 3. GUARDAR EN FIREBASE (BACKUP INTELIGENTE CADA 5 MINUTOS O EN EVENTOS)
        const timeSinceLastSave = nowMs - (store.lastFirebaseSave.get(ticker) || 0);
        const FIREBASE_INTERVAL_MS = 5 * 60 * 1000; // 5 Minutos

        // 🔄 Refrescar la caché derivada `points` antes de persistir (la leen clientes externos)
        refreshScoreCache(state.scoreBuy, nowMs);
        refreshScoreCache(state.scoreSell, nowMs);

        state.version = (state.version || 0) + 1;
        state.lastModified = nowMs;

        if (prefix !== 'PING_PRICE' || timeSinceLastSave > FIREBASE_INTERVAL_MS) {
            safeSet(state, { merge: true }).catch((err: any) => console.error(`[FIREBASE] Error guardando estado ${ticker}: ${err.message}`));
            store.lastFirebaseSave.set(ticker, nowMs);
        }

        if (triggerOte && oteData) {
            state.lastGatillo = {
                dir: oteData.direction as 'BUY' | 'SELL',
                price: oteData.entryPrice,
                time: nowMs,
                type: oteData.isChochEntry ? 'CHOCH' : 'OTE',
                status: 'EVALUANDO...',
                tf: oteData.tf
            };
            state.version = (state.version || 0) + 1;
            state.lastModified = nowMs;
            safeSet(state, { merge: true }).catch(() => { });
            dispatchData = oteData;
        }

        if (dispatchData) {
            if (!isBootstrap) {
                await dispatchOteSignal(dispatchData, state, null, { ticker, nowMs, isBacktest, sessionThresholds, store });
            } else {
                console.log(`[BOOTSTRAP] ⏭️ Se generó OTE para ${ticker} pero se omite ejecución (fase de construcción de estado)`);
            }
        }

    } catch (e: any) {
        console.error(`[RADAR] Error crítico en memoria/Firebase:`, e.message);
    } finally {
        releaseLock!(); // 🛡️ v5.4: Liberar lock del ticker tras despachar la orden (previene doble entrada TOCTOU)
    }
}

const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;
let watchdogStarted = false;

// Broker-calendar safety: A=[pause-9m,pause-2m), D=[pause-4m,pause-2m).
// Thresholds and widen magnitude unchanged. Pending restore never expires.
// No strategy/SMC freeze and no triage policy are applied here.
const rolloverBeAppliedToday = new Set<string>();
let rolloverJournalRecoveryReady = false;
const rolloverMutationInFlight = new Set<string>();
async function runNormalStopMutation(tradeId: string, trade: ActiveTrade, operation: () => Promise<unknown>): Promise<void> {
    if (rolloverMutationInFlight.has(tradeId) || (trade as any).slAmendInFlight) return;
    rolloverMutationInFlight.add(tradeId);
    (trade as any).slAmendInFlight = true;
    try { await operation(); }
    finally {
        (trade as any).slAmendInFlight = false;
        rolloverMutationInFlight.delete(tradeId);
    }
}
const ROLLOVER_D_WIDEN_PIPS = 20;
interface RolloverPendingSafety {
    orig: number | null; wide: number | null; tries: number; at: number; nextRetryAt?: number;
    quarantineWarnAt?: number; journalId?: string;
    positionId?: string; ticker?: string; direction?: 'BUY' | 'SELL';
}
const rolloverDWideMap = new Map<string, RolloverPendingSafety>();
function rolloverPipSize(ticker: string): number {
    if (getRolloverAssetClass(ticker) === 'CRYPTO') return 0; // preserve percentage policy, not index substrings
    return getRolloverSpreadReference(ticker, 1).pipSize;
}
function rolloverMinFloat(ticker: string, price: number): number {
    const t = ticker.toUpperCase();
    const pip = rolloverPipSize(t);
    if (pip === 0) return price * 0.005;
    if (pip >= 1) return 5 * pip;
    if (pip === 0.1) return 10 * pip;
    if (/OIL|XTI|WTI|BRENT/.test(t)) return 5 * pip;
    return 2 * pip;
}
function rolloverBeBuffer(ticker: string): number {
    const pip = rolloverPipSize(ticker);
    if (pip === 0) return 0;
    if (pip >= 0.1) return 5 * pip;
    if (/OIL|XTI|WTI|BRENT/.test(ticker.toUpperCase())) return 3 * pip;
    return pip;
}
function roundRolloverPrice(v: number, ticker: string): number {
    const pip = rolloverPipSize(ticker);
    return Number(v.toFixed(pip === 0 ? 1 : pip >= 0.1 ? 2 : pip === 0.01 ? 3 : 5));
}
function rolloverIsOtcFx(ticker: string): boolean {
    return !['INDICES', 'CRYPTO'].includes(getRolloverAssetClass(ticker));
}
function getRolloverLiveSnapshot(ticker: string, nowMs: number) {
    const flow = tickFlow.getSpreadSnapshot(ticker, nowMs);
    const quote = getLastBidAsk(ticker, nowMs);
    if (!flow || !quote) return null;
    const ts = Math.min(flow.ts, quote.ts);
    return { ...flow, bid: quote.bid, ask: quote.ask, spread: Math.max(flow.spread, quote.ask - quote.bid), ts, ageMs: nowMs - ts };
}
// Journal-only records are safety obligations, NOT adopted positions or PnL evidence.
const rolloverTriageRecords = new Map<string, ActiveTrade>();
function usesExperimentalRollover(trade: ActiveTrade): boolean {
    return trade.rolloverFill?.policy.profile === 'rollover_triage_v1'
        || (!trade.rolloverFill && (globalState.assetSessionConfigs.get(trade.ticker) as any)?.rolloverPolicy?.profile === 'rollover_triage_v1');
}
function buildLiveRolloverContext(tradeId: string, trade: ActiveTrade, nowMs: number, currentSlPrice: number,
    partial: import('../engine/RolloverTriagePolicy.js').RolloverTriageContext['partial']) {
    const fill = trade.rolloverFill;
    if (!fill || fill.positionId !== trade.ctraderPositionId || fill.ticker !== trade.ticker || fill.direction !== trade.direction) return null;
    const instrument = getLiveExecutionInstrument(trade.ticker);
    const valid = validateExecutionInstrument(instrument) && instrument.ticker === trade.ticker && instrument.source === 'broker_metadata';
    const quote = getRolloverQuote(trade.ticker, nowMs);
    const flow = tickFlow.getSpreadSnapshot(trade.ticker,nowMs);
    const snapshot = quote && flow && flow.bid === quote.bid && flow.ask === quote.ask
        && flow.ts === Math.min(quote.bidTimestampMs,quote.askTimestampMs) ? flow : null;
    const reference = getRolloverSpreadReference(trade.ticker,fill.entryPrice);
    const engine = (globalState.smcManager as any)?.getEngines?.().get(`${trade.ticker}:H1`);
    const sourceOpen = engine?.lastProcessedTs;
    const sourceClose = typeof sourceOpen === 'number' ? sourceOpen + 3600000 : NaN;
    const raw = engine?.getLastRolloverObservation?.();
    const trend = engine?.getState?.().simpleTrend;
    const htf = Number.isFinite(sourceClose) && sourceClose <= nowMs && nowMs-sourceClose <= 3600000
        && raw?.excluded === false && raw.candle?.timestamp === sourceOpen && ['Bullish','Bearish'].includes(trend)
        ? {aligned:trend === (trade.direction === 'BUY' ? 'Bullish':'Bearish'),availableAtMs:sourceClose} : null;
    const state = trade.rolloverTriageState ?? {pending:null,widenReference:null};
    return {positionKey:fill.positionKey,context:{profile:fill.policy.profile,ticker:trade.ticker,tradeId,direction:fill.direction,nowMs,
        entryPrice:fill.entryPrice,initialSlPrice:fill.initialSlPrice,initialRiskPrice:fill.initialRiskPrice,currentSlPrice,
        quote,tickSize:valid ? instrument!.tickSize : NaN,minStopDistancePrice:valid ? instrument!.minStopDistance : NaN,
        protectionEarned:trade.tp1Hit === true || (trade.direction === 'BUY' ? currentSlPrice >= fill.entryPrice : currentSlPrice <= fill.entryPrice),
        // Historical fee estimates are NOT actual allocated remaining costs.
        costs:null,partial,htf,peakSpread:fill.policy.peakSpread ?? null,pending:state.pending,widenReference:state.widenReference,
        config:fill.policy.triage!,normalization:{snapshot,baseSpreadPrice:reference.baseSpreadPrice,pipSize:reference.pipSize}}};
}
async function runLiveRolloverTriage(tradeId: string, trade: ActiveTrade): Promise<import('../engine/RolloverTriageExecutor.js').RolloverTriageExecutionResult | undefined> {
    const fill = trade.rolloverFill;
    if (trade.isBacktest || !fill || fill.policy.profile !== 'rollover_triage_v1' || rolloverDWideMap.has(tradeId)
        || !rolloverJournalRecoveryReady || rolloverMutationInFlight.has(tradeId) || (trade as any).slAmendInFlight) return;
    rolloverTriageRecords.set(tradeId,trade);
    rolloverMutationInFlight.add(tradeId);
    try {
        if (!trade.rolloverTriageDurable) await persistLiveRolloverRecord(tradeId,trade,undefined,'FILL');
        const identity = {ticker:trade.ticker,tradeId,positionKey:fill.positionKey};
        let actualSl = trade.slPrice, actualVolume = NaN;
        let partial: import('../engine/RolloverTriagePolicy.js').RolloverTriageContext['partial'] = null;
        let evidenceAt = NaN;
        const acceptPosition = (p: any): boolean => {
            const td = p?.tradeData;
            const side = td?.tradeSide ?? td?.direction;
            if (String(p?.positionId) !== fill.positionId || Number(td?.openTimestamp) !== fill.openedAtMs
                || Number(td?.openPrice ?? p?.price) !== fill.entryPrice
                || (side === 1 || side === 'BUY' ? 'BUY' : side === 2 || side === 'SELL' ? 'SELL':null) !== fill.direction) return false;
            const stop = Number(p.stopLoss), volume = Number(td.volume);
            if (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(volume) || volume <= 0) return false;
            if (volume !== actualVolume) partial = null;
            actualSl = stop; actualVolume = volume;
            return true;
        };
        const readProtection = async (): Promise<import('../engine/RolloverTriageExecutor.js').RolloverProtectionReadback> => {
            try {
                const positions = await rolloverBroker.getOpenPositions(trade.ticker);
                if (!Array.isArray(positions)) return {status:'UNAVAILABLE'};
                const matches = positions.filter((p: any) => String(p?.positionId) === fill.positionId);
                if (matches.length === 0) return {status:'CLOSED',identity};
                if (matches.length !== 1 || !acceptPosition(matches[0])) return {status:'UNAVAILABLE'};
                // Only a real complete entry-deal list matching current remaining volume proves NO partial.
                // Unknown/partially closed positions retain null, never tp1Hit=false as fake confirmation.
                const deals = await rolloverBroker.getDealsByPosition(fill.positionId);
                const now = Date.now();
                if (Array.isArray(deals) && deals.length > 0 && deals.every((d: any) => String(d.positionId) === fill.positionId
                    && [2,3].includes(Number(d.dealStatus)) && !d.closePositionDetail
                    && Number.isFinite(Number(d.executionTimestamp)) && Number(d.executionTimestamp) >= fill.openedAtMs && Number(d.executionTimestamp) <= now
                    && Number.isFinite(Number(d.filledVolume)) && Number(d.filledVolume) > 0)
                    && deals.reduce((sum: number,d: any) => sum+Number(d.filledVolume),0) === actualVolume) {
                    partial = {tp1Confirmed:false,realizedNetCash:0}; evidenceAt = now;
                } else partial = null;
                return {status:'OPEN',identity,stopLossPrice:actualSl};
            } catch { return {status:'UNAVAILABLE'}; }
        };
        const persist = async (write: import('../engine/RolloverTriageExecutor.js').RolloverExecutionWrite, phase:'INTENT'|'CONFIRMED'|'CLEAR') => {
            await persistLiveRolloverRecord(tradeId,trade,write,phase);
        };
        const result = await runRolloverTriageExecution({identity,state:structuredClone(trade.rolloverTriageState ?? {pending:null,widenReference:null}),
            nowMs:Date.now,getContext:now => buildLiveRolloverContext(tradeId,trade,now,actualSl,
                Number.isFinite(evidenceAt) && now >= evidenceAt && now-evidenceAt <= 10000 ? partial:null),readProtection,
            persistIntent:write => persist(write,'INTENT'),persistConfirmed:write => persist(write,'CONFIRMED'),clearPending:write => persist(write,'CLEAR'),
            amendStopLoss:async (request,authorize) => await rolloverBroker.modifyStopLoss(fill.positionId,request.stopLossPrice,undefined,
                (position?: any) => acceptPosition(position) && authorize()) ? 'ACKNOWLEDGED':'REJECTED',
            closePosition:async (_request,authorize) => await rolloverBroker.closePosition(fill.positionId,
                (position?: any) => acceptPosition(position) && authorize()) ? 'ACKNOWLEDGED':'REJECTED'});
        if (result.status !== 'IN_FLIGHT') trade.rolloverTriageState = structuredClone(result.state);
        if ((result.status === 'CONFIRMED' || result.status === 'RECONCILED') && result.protection.status === 'OPEN') trade.slPrice = result.protection.stopLossPrice;
        if ((result.status === 'CONFIRMED' || result.status === 'RECONCILED') && result.protection.status === 'CLOSED') rolloverTriageRecords.delete(tradeId);
        // Do not remove active position or synthesize result/PnL; deal reconciler owns closure accounting.
        return result;
    } finally { rolloverMutationInFlight.delete(tradeId); }
}

async function applyRolloverProtection(nowMs: number, onlyTicker?: string): Promise<void> {
    if (!rolloverJournalRecoveryReady) return;
    for (const [tradeId, trade] of globalState.activeTrades) {
        if (onlyTicker && trade.ticker !== onlyTicker) continue;
        if (usesExperimentalRollover(trade)) continue;
        const calendar = getRolloverCalendar(trade.ticker, nowMs);
        const key = `${tradeId}:${calendar.periodKey}`;
        if (!calendar.metadataAvailable || !calendar.periodKey || !calendar.protectionWindow || rolloverBeAppliedToday.has(key) || rolloverDWideMap.has(tradeId) || rolloverMutationInFlight.has(tradeId) || (trade as any).slAmendInFlight || !trade.ctraderPositionId || trade.isBacktest) continue;
        if ((globalState.assetSessionConfigs.get(trade.ticker) as any)?.rolloverBeEnabled === false) continue;
        const q = getLastBidAsk(trade.ticker, nowMs);
        if (!q || nowMs < q.ts || nowMs - q.ts > 10000) continue;
        const px = trade.direction === 'BUY' ? q.bid : q.ask;
        const floatDist = trade.direction === 'BUY' ? px - trade.entryPrice : trade.entryPrice - px;
        if (floatDist < rolloverMinFloat(trade.ticker, px)) continue;
        const buffer = rolloverBeBuffer(trade.ticker);
        const newSl = roundRolloverPrice(trade.entryPrice + (trade.direction === 'BUY' ? buffer : -buffer), trade.ticker);
        if (!(trade.direction === 'BUY' ? newSl > trade.slPrice && newSl < q.bid : newSl < trade.slPrice && newSl > q.ask)) continue;
        rolloverMutationInFlight.add(tradeId);
        try {
            const broker = await import('../services/ctrader.js');
            const protection = await broker.readPositionProtection(trade.ctraderPositionId);
            if (!protection?.exists) continue;
            if (protection.stopLoss !== null && (trade.direction === 'BUY' ? protection.stopLoss >= newSl : protection.stopLoss <= newSl)) {
                trade.slPrice = protection.stopLoss;
                continue; // Never weaken already equivalent/better broker protection.
            }
            const actNow = Math.max(nowMs, Date.now());
            const fresh = getLastBidAsk(trade.ticker, actNow);
            if (!getRolloverCalendar(trade.ticker, actNow).protectionWindow || !fresh || actNow < fresh.ts || actNow - fresh.ts > 10000 || !(trade.direction === 'BUY' ? newSl < fresh.bid : newSl > fresh.ask)) continue;
            const beforeAmend = () => {
                const at = Math.max(nowMs, Date.now());
                const phase = getRolloverCalendar(trade.ticker, at);
                const quote = getLastBidAsk(trade.ticker, at);
                return rolloverJournalRecoveryReady && phase.metadataAvailable && phase.protectionWindow && phase.periodKey === calendar.periodKey
                    && !!quote && at >= quote.ts && at - quote.ts <= 10000
                    && Number.isFinite(newSl) && newSl > 0
                    && (trade.direction === 'BUY' ? newSl < quote.bid : newSl > quote.ask);
            };
            if (!await broker.modifyStopLoss(trade.ctraderPositionId, newSl, undefined, beforeAmend)) throw new Error('BE amend rejected/unverified');
            trade.slPrice = newSl;
            rolloverBeAppliedToday.add(key);
            trade.rolloverBeApplied = true;
            trade.rolloverBePeriodKey = calendar.periodKey;
            await persistRolloverSafety(tradeId, { slPrice: newSl, rolloverBeApplied: true, rolloverBePeriodKey: calendar.periodKey }, trade.journalId);
            await sendTelegramAlert(`🛡️ ROLLOVER A ${trade.ticker} #${tradeId}: SL→${newSl} [broker calendar]`);
        } catch (e: any) { await alertRolloverFailure(`${trade.ticker} #${tradeId}: protection failed: ${e.message}`); }
        finally { rolloverMutationInFlight.delete(tradeId); }
    }
}
async function applyRolloverWiden(nowMs: number, onlyTicker?: string): Promise<void> {
    if (!rolloverJournalRecoveryReady) return;
    for (const [tradeId, trade] of globalState.activeTrades) {
        if (onlyTicker && trade.ticker !== onlyTicker) continue;
        if (usesExperimentalRollover(trade)) continue;
        const calendar = getRolloverCalendar(trade.ticker, nowMs);
        if (!calendar.metadataAvailable || !calendar.widenWindow || rolloverDWideMap.has(tradeId) || rolloverMutationInFlight.has(tradeId) || (trade as any).slAmendInFlight || rolloverBeAppliedToday.has(`${tradeId}:${calendar.periodKey}`) || !trade.ctraderPositionId || trade.isBacktest || !rolloverIsOtcFx(trade.ticker)) continue;
        if ((globalState.assetSessionConfigs.get(trade.ticker) as any)?.rolloverBeEnabled === false) continue;
        const q = getLastBidAsk(trade.ticker, nowMs);
        if (!q || nowMs < q.ts || nowMs - q.ts > 10000) continue;
        const px = trade.direction === 'BUY' ? q.bid : q.ask;
        const floatDist = trade.direction === 'BUY' ? px - trade.entryPrice : trade.entryPrice - px;
        if (floatDist >= rolloverMinFloat(trade.ticker, px)) continue;
        rolloverMutationInFlight.add(tradeId);
        try {
            const broker = await import('../services/ctrader.js');
            const protection = await broker.readPositionProtection(trade.ctraderPositionId);
            if (!protection?.exists || protection.stopLoss === null) throw new Error('Cannot widen without original broker SL');
            const orig = protection.stopLoss;
            // D only relaxes losing protection, never BE/profit secured by any manager.
            if (!Number.isFinite(orig) || orig <= 0 || (trade.direction === 'BUY' ? orig >= trade.entryPrice : orig <= trade.entryPrice)) continue;
            // Do not override an independent protective manager with stale RAM state.
            if (trade.direction === 'BUY' ? orig > trade.slPrice : orig < trade.slPrice) { trade.slPrice = orig; continue; }
            const wide = roundRolloverPrice(orig + (trade.direction === 'BUY' ? -1 : 1) * ROLLOVER_D_WIDEN_PIPS * rolloverPipSize(trade.ticker), trade.ticker);
            const pending = { orig, wide, tries: 0, at: nowMs, nextRetryAt: 0, positionId: trade.ctraderPositionId, ticker: trade.ticker, direction: trade.direction, journalId: trade.journalId };
            rolloverDWideMap.set(tradeId, pending); // reserve before any yield/amend
            await persistRolloverSafety(tradeId, { rolloverDWidened: true, rolloverDSlOriginal: orig, rolloverDSlWide: wide, rolloverDWidenedAt: nowMs, rolloverDRestoreTries: 0, rolloverDNextRetryAt: 0, rolloverDPositionId: trade.ctraderPositionId, rolloverDTicker: trade.ticker, rolloverDDirection: trade.direction }, trade.journalId);
            const actNow = Math.max(nowMs, Date.now());
            const fresh = getLastBidAsk(trade.ticker, actNow);
            if (!getRolloverCalendar(trade.ticker, actNow).widenWindow || !fresh || actNow < fresh.ts || actNow - fresh.ts > 10000) continue;
            // Persistence yielded: require the exact original broker protection again.
            const confirmed = await broker.readPositionProtection(trade.ctraderPositionId);
            if (!confirmed?.exists || confirmed.stopLoss !== orig) {
                const improved = confirmed?.exists && confirmed.stopLoss !== null && Number.isFinite(confirmed.stopLoss) && (trade.direction === 'BUY' ? confirmed.stopLoss >= orig : confirmed.stopLoss <= orig);
                if (improved) {
                    trade.slPrice = confirmed!.stopLoss!;
                    await persistRolloverSafety(tradeId, { rolloverDWidened: false, rolloverDSlOriginal: null, rolloverDSlWide: null, slPrice: trade.slPrice }, trade.journalId);
                    rolloverDWideMap.delete(tradeId);
                }
                continue; // Missing/worse readback retains recoverable intent, never widens stale SL.
            }
            const sendNow = Math.max(nowMs, Date.now());
            const sendQuote = getLastBidAsk(trade.ticker, sendNow);
            if (!getRolloverCalendar(trade.ticker, sendNow).widenWindow || !sendQuote || sendNow < sendQuote.ts || sendNow - sendQuote.ts > 10000) continue;
            const beforeAmend = () => {
                const at = Math.max(nowMs, Date.now());
                const phase = getRolloverCalendar(trade.ticker, at);
                const quote = getLastBidAsk(trade.ticker, at);
                return rolloverJournalRecoveryReady && phase.metadataAvailable && phase.widenWindow && phase.periodKey === calendar.periodKey
                    && !!quote && at >= quote.ts && at - quote.ts <= 10000
                    && Number.isFinite(wide) && wide > 0
                    && (trade.direction === 'BUY' ? wide < quote.bid : wide > quote.ask);
            };
            if (!await broker.modifyStopLoss(trade.ctraderPositionId, wide, undefined, beforeAmend)) throw new Error('Widen rejected/unverified; original protection remains pending');
            trade.slPrice = wide;
            await persistRolloverSafety(tradeId, { slPrice: wide }, trade.journalId);
            await sendTelegramAlert(`🛡️ ROLLOVER D ${trade.ticker} #${tradeId}: SL ${orig}→${wide}; restoration awaits fresh normalized spread`);
        } catch (e: any) { await alertRolloverFailure(`${trade.ticker} #${tradeId}: widen failed: ${e.message}`); }
        finally { rolloverMutationInFlight.delete(tradeId); }
    }
}

/** Transaction + exact readback on active and the independent journal, never a buffered write. */
async function persistLiveRolloverRecord(tradeId: string, trade: ActiveTrade,
    write: import('../engine/RolloverTriageExecutor.js').RolloverExecutionWrite | undefined,
    phase: 'FILL'|'INTENT'|'CONFIRMED'|'CLEAR'): Promise<void> {
    if (!db || !trade.journalId || !trade.rolloverFill || trade.tradeId !== tradeId) throw new Error('Rollover durable identity unavailable');
    const fill = trade.rolloverFill;
    const identity = {ticker:trade.ticker,tradeId,positionKey:fill.positionKey};
    if (write && (write.identity.ticker !== identity.ticker || write.identity.tradeId !== tradeId || write.identity.positionKey !== fill.positionKey)) throw new Error('Rollover write identity mismatch');
    if (phase !== 'FILL' && phase !== 'INTENT' && !write?.protection) throw new Error('Rollover confirmation requires broker proof');
    const fields = JSON.parse(JSON.stringify({tradeId,journalId:trade.journalId,ticker:trade.ticker,direction:fill.direction,ctraderPositionId:fill.positionId,
        ...(write?.protection?.status === 'OPEN' ? {slPrice:write.protection.stopLossPrice} : phase === 'FILL' ? {slPrice:fill.initialSlPrice} : {}),
        rolloverFill:fill,rolloverTriageIdentity:identity,
        rolloverTriageState:write?.state ?? trade.rolloverTriageState ?? {pending:null,widenReference:null},
        rolloverTriageTracked:write?.protection?.status !== 'CLOSED',rolloverTriageDurable:true,
        rolloverTriagePhase:phase,rolloverTriageCommand:write?.proposal ?? null,
        rolloverTriageExpectedSl:write?.expectedSlPrice ?? null,rolloverTriageProtection:write?.protection ?? null}));
    const activeRef: import('firebase-admin/firestore').DocumentReference = db.collection('active_trades').doc(tradeId);
    const journalRef: import('firebase-admin/firestore').DocumentReference = db.collection('trade_journal').doc(trade.journalId);
    const closed = write?.protection?.status === 'CLOSED';
    const validate = (data: any) => {
        if ((data?.ticker && data.ticker !== trade.ticker) || (data?.direction && data.direction !== fill.direction)
            || (data?.tradeId && data.tradeId !== tradeId)) throw new Error('Rollover stored trade mismatch');
        if (data?.ctraderPositionId != null && String(data.ctraderPositionId) !== fill.positionId) throw new Error('Rollover stored position mismatch');
        if (data?.rolloverFill && data.rolloverFill.positionKey !== fill.positionKey) throw new Error('Rollover stored incarnation mismatch');
        if (data?.rolloverTriageIdentity && (data.rolloverTriageIdentity.tradeId !== tradeId || data.rolloverTriageIdentity.ticker !== trade.ticker || data.rolloverTriageIdentity.positionKey !== fill.positionKey)) throw new Error('Rollover stored owner mismatch');
    };
    await db.runTransaction(async (tx: import('firebase-admin/firestore').Transaction) => {
        const active = await tx.get(activeRef), journal = await tx.get(journalRef);
        if (!journal.exists || (!active.exists && !closed)) throw new Error('Rollover durable document missing');
        if (active.exists) validate(active.data());
        validate(journal.data());
        if (active.exists) tx.update(activeRef, fields);
        tx.update(journalRef, fields);
    });
    const [active,journal] = await Promise.all([activeRef.get(),journalRef.get()]);
    // Firestore map ordering is not an equality contract.
    const canonical = (v: any): string => JSON.stringify(v, (_key,value) => value && !Array.isArray(value) && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(k => [k,value[k]])) : value);
    for (const [snap,mayBeAbsent] of [[active,closed],[journal,false]] as const) {
        if (!snap.exists) { if (mayBeAbsent) continue; throw new Error('Rollover readback absent'); }
        const data = snap.data(); validate(data);
        for (const [key,value] of Object.entries(fields)) if (canonical(data?.[key]) !== canonical(value)) throw new Error(`Rollover readback mismatch: ${key}`);
    }
    Object.assign(trade, fields);
}

async function persistRolloverSafety(tradeId: string, fields: Record<string, unknown>, journalId?: string, confirmedClosed = false): Promise<void> {
    if (!db) throw new Error('Rollover safety requires durable storage');
    const active = globalState.activeTrades.get(tradeId);
    journalId ??= active?.journalId ?? rolloverDWideMap.get(tradeId)?.journalId;
    // Normal managers serialize the whole RAM trade: carry safety through those writes.
    if (active && fields.rolloverDWidened === true) Object.assign(active, fields);
    // Only explicit broker absence permits already-deleted documents. Never upsert a ghost.
    const updateExisting = async (collection: string, id: string) => {
        try { await db!.collection(collection).doc(id).update(fields); }
        catch (e: any) {
            if (!confirmedClosed || ![5, '5', 'not-found', 'NOT_FOUND'].includes(e.code)) throw e;
        }
    };
    if (journalId) await updateExisting('trade_journal', journalId);
    await updateExisting('active_trades', tradeId);
    if (active) Object.assign(active, fields);
}
async function alertRolloverFailure(message: string): Promise<void> {
    console.error(`[ROLLOVER-D] ${message}`);
    try { await sendTelegramAlert(`⚠️ ROLLOVER-D: ${message}`); }
    catch (e: any) { console.error('[ROLLOVER-D] Alert failed:', e.message); }
}
async function applyRolloverRestore(nowMs: number, force = false, onlyTicker?: string): Promise<void> {
    // Retained API for boot callers, never bypasses evidence.
    void force;
    for (const [tradeId, entry] of [...rolloverDWideMap]) {
        const trade = globalState.activeTrades.get(tradeId);
        const positionId = trade?.ctraderPositionId ?? entry.positionId;
        const ticker = trade?.ticker ?? entry.ticker;
        const direction = trade?.direction ?? entry.direction;
        if (onlyTicker && ticker !== onlyTicker) continue;
        if (rolloverMutationInFlight.has(tradeId) || (trade as any)?.slAmendInFlight) continue;
        if (!positionId || !ticker || !direction || nowMs < (entry.nextRetryAt ?? 0)) continue;
        rolloverMutationInFlight.add(tradeId);
        try {
            const broker = await import('../services/ctrader.js');
            const protection = await broker.readPositionProtection(positionId);
            if (!protection) throw new Error('Broker protection readback unavailable');
            const protectedSl = protection.stopLoss;
            const knownOriginal = entry.orig !== null && Number.isFinite(entry.orig) && entry.orig > 0;
            const equivalent = knownOriginal && protectedSl !== null && Number.isFinite(protectedSl) && protectedSl > 0 && (direction === 'BUY' ? protectedSl >= entry.orig! : protectedSl <= entry.orig!);
            if (!protection.exists || equivalent) {
                if (trade && equivalent) trade.slPrice = protectedSl!;
                await persistRolloverSafety(tradeId, { rolloverDWidened: false, rolloverDSlOriginal: null, rolloverDSlWide: null, rolloverDRestored: protection.exists, rolloverDClosed: !protection.exists, ...(equivalent ? { slPrice: protectedSl } : {}) }, trade?.journalId ?? entry.journalId, !protection.exists);
                rolloverDWideMap.delete(tradeId);
                continue;
            }
            if (!knownOriginal || entry.wide === null) {
                if (entry.quarantineWarnAt === undefined || nowMs - entry.quarantineWarnAt >= 15 * 60_000) {
                    entry.quarantineWarnAt = nowMs;
                    await alertRolloverFailure(`${ticker} #${tradeId}: invalid persisted rollover SL; quarantined, manual recovery required`);
                }
                continue; // No guessed restore/close; retain durable widened flag and block A/D.
            }
            const calendar = getRolloverCalendar(ticker, nowMs);
            const snapshot = getRolloverLiveSnapshot(ticker, nowMs);
            const { pipSize: pip, baseSpreadPrice: base } = getRolloverSpreadReference(ticker, trade?.entryPrice ?? snapshot?.bid ?? 1);
            if (!calendar.metadataAvailable || !calendar.restoreEligible || !isSpreadNormalized(snapshot, nowMs, base, pip)) continue;
            entry.tries++;
            entry.nextRetryAt = nowMs + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(entry.tries - 1, 5));
            try { await persistRolloverSafety(tradeId, { rolloverDRestoreTries: entry.tries, rolloverDNextRetryAt: entry.nextRetryAt }); }
            catch (e: any) { await alertRolloverFailure(`${ticker} #${tradeId}: retry persistence failed: ${e.message}`); }
            // BUY SL executes on Bid; SELL on Ask. Never send invalid original SL.
            const actNow = Math.max(nowMs, Date.now());
            const fresh = getRolloverLiveSnapshot(ticker, actNow);
            if (!getRolloverCalendar(ticker, actNow).restoreEligible || !isSpreadNormalized(fresh, actNow, base, pip)) continue;
            const validOriginal = direction === 'BUY' ? entry.orig! < fresh!.bid : entry.orig! > fresh!.ask;
            const beforeAmend = () => {
                const at = Math.max(nowMs, Date.now());
                const phase = getRolloverCalendar(ticker, at);
                const quote = getRolloverLiveSnapshot(ticker, at);
                return phase.metadataAvailable && phase.restoreEligible && isSpreadNormalized(quote, at, base, pip)
                    && entry.orig !== null && Number.isFinite(entry.orig) && entry.orig > 0
                    && (direction === 'BUY' ? entry.orig < quote!.bid : entry.orig > quote!.ask);
            };
            const ok = validOriginal ? await broker.modifyStopLoss(positionId, entry.orig!, undefined, beforeAmend) : await broker.closePosition(positionId);
            if (!ok) throw new Error(validOriginal ? 'Restore rejected/unverified' : 'Full close rejected/unverified');
            const verified = await broker.readPositionProtection(positionId);
            if (!verified || (validOriginal ? verified.exists && (verified.stopLoss === null || (direction === 'BUY' ? verified.stopLoss < entry.orig! : verified.stopLoss > entry.orig!)) : verified.exists)) throw new Error('Final broker readback does not confirm safety');
            if (trade && verified.exists) trade.slPrice = verified.stopLoss!;
            await persistRolloverSafety(tradeId, { rolloverDWidened: false, rolloverDSlOriginal: null, rolloverDSlWide: null, rolloverDRestored: verified.exists, rolloverDClosed: !verified.exists, ...(verified.exists ? { slPrice: verified.stopLoss } : {}) }, trade?.journalId ?? entry.journalId, !verified.exists);
            rolloverDWideMap.delete(tradeId);
            console.log(`[ROLLOVER-D] ${ticker} #${tradeId}: protection verified in broker`);
        } catch (e: any) {
            if (!entry.nextRetryAt || entry.nextRetryAt <= nowMs) entry.nextRetryAt = nowMs + 30_000;
            await alertRolloverFailure(`${ticker} #${tradeId}: ${e.message}; pending state retained (attempt ${entry.tries})`);
        } finally { rolloverMutationInFlight.delete(tradeId); }
    }
}

function canExpireOrphanTrade(tradeId: string, ageMs: number): boolean {
    const trade = globalState.activeTrades.get(tradeId);
    return ageMs > 7 * 24 * 60 * 60 * 1000 && !rolloverDWideMap.has(tradeId)
        && !trade?.ctraderPositionId && !hasPendingExecutionIncident(trade as any ?? {})
        && !rolloverTriageRecords.get(tradeId)?.rolloverTriageState?.pending;
}
function rehydrateLiveRolloverRecord(tradeId: string, data: any): void {
    const fill = data.rolloverFill, identity = data.rolloverTriageIdentity;
    if (!fill || fill.schema !== 1 || !identity || identity.tradeId !== tradeId || identity.ticker !== fill.ticker
        || identity.positionKey !== fill.positionKey || fill.positionKey !== `${fill.positionId}:${fill.openedAtMs}`
        || fill.positionId !== String(data.ctraderPositionId) || fill.ticker !== data.ticker || fill.direction !== data.direction
        || ![fill.entryPrice,fill.initialSlPrice,fill.initialRiskPrice,fill.openedAtMs].every(v => Number.isFinite(v) && v > 0)
        || Math.abs((fill.direction === 'BUY' ? 1:-1)*(fill.entryPrice-fill.initialSlPrice)-fill.initialRiskPrice) > 16*Number.EPSILON*Math.max(1,fill.entryPrice)) return;
    if (fill.policy?.profile !== 'rollover_triage_v1' || data.rolloverTriageTracked !== true) return;
    const active = globalState.activeTrades.get(tradeId);
    if (active && String(active.ctraderPositionId) !== fill.positionId) return;
    if (rolloverMutationInFlight.has(tradeId)) return;
    const existing = rolloverTriageRecords.get(tradeId);
    const record = existing ?? active ?? ({...data,tradeId} as ActiveTrade);
    const prior = record.rolloverTriageState;
    const journal = data.rolloverTriageState;
    const recoveredState = {pending:prior?.pending ?? journal?.pending ?? null,
        widenReference:prior?.widenReference ?? journal?.widenReference ?? null};
    Object.assign(record,{rolloverFill:structuredClone(fill),rolloverTriageState:structuredClone(recoveredState),
        rolloverTriageTracked:true,rolloverTriageDurable:data.rolloverTriageDurable === true,journalId:data.journalId ?? record.journalId});
    rolloverTriageRecords.set(tradeId,record);
}
async function loadLiveRolloverJournalRecords(): Promise<void> {
    if (!db) throw new Error('Rollover journal unavailable');
    const snap = await db.collection('trade_journal').where('rolloverTriageTracked','==',true).get();
    for (const doc of snap.docs) {
        const data = doc.data();
        if (data.rolloverTriageTracked !== true || data.mode === 'backtesting') continue;
        const id = data.rolloverTriageIdentity?.tradeId;
        if (typeof id === 'string' && id) rehydrateLiveRolloverRecord(id,{...data,journalId:doc.id});
    }
}
function rehydrateRolloverPending(tradeId: string, data: any): void {
    rehydrateLiveRolloverRecord(tradeId,data);
    // A legacy boolean has no period evidence: never invent today's date on boot.
    if (data.rolloverBeApplied === true && typeof data.rolloverBePeriodKey === 'string' && data.rolloverBePeriodKey.length > 0) {
        rolloverBeAppliedToday.add(`${tradeId}:${data.rolloverBePeriodKey}`);
    }
    if (!data.rolloverDWidened) return;
    const existing = rolloverDWideMap.get(tradeId);
    if (existing) {
        // Journal snapshots can be older than RAM retry/protection state. Merge identity only.
        existing.journalId ??= data.journalId;
        existing.positionId ??= data.rolloverDPositionId ?? data.ctraderPositionId;
        existing.ticker ??= data.rolloverDTicker ?? data.ticker;
        existing.direction ??= data.rolloverDDirection ?? data.direction;
        return;
    }
    const orig = Number(data.rolloverDSlOriginal);
    const wide = Number(data.rolloverDSlWide);
    if (!(orig > 0 && wide > 0 && Number.isFinite(orig) && Number.isFinite(wide))) {
        console.error(`[ROLLOVER-D] Invalid persisted original SL for #${tradeId}; manual recovery required`);
    }
    rolloverDWideMap.set(tradeId, { orig: orig > 0 && Number.isFinite(orig) ? orig : null, wide: wide > 0 && Number.isFinite(wide) ? wide : null, tries: Math.max(0, Number(data.rolloverDRestoreTries) || 0), at: Number(data.rolloverDWidenedAt) || 0, nextRetryAt: Math.max(0, Number(data.rolloverDNextRetryAt) || 0), positionId: data.rolloverDPositionId ?? data.ctraderPositionId, ticker: data.rolloverDTicker ?? data.ticker, direction: data.rolloverDDirection ?? data.direction, journalId: data.journalId });
}
let rolloverJournalRecoveryInFlight: Promise<boolean> | null = null;
async function loadRolloverJournalPending(): Promise<boolean> {
    if (rolloverJournalRecoveryInFlight) return rolloverJournalRecoveryInFlight;
    rolloverJournalRecoveryReady = false;
    rolloverJournalRecoveryInFlight = (async () => {
        if (!db) return false;
        try {
            const snap = await db.collection('trade_journal').where('rolloverDWidened', '==', true).get();
            for (const doc of snap.docs) {
                const data = doc.data();
                if (data.rolloverDWidened !== true || data.mode === 'backtesting') continue;
                const positionId = data.rolloverDPositionId ?? data.ctraderPositionId;
                const active = [...globalState.activeTrades.values()].find(t => positionId && String(t.ctraderPositionId) === String(positionId))
                    ?? (data.tradeId ? globalState.activeTrades.get(data.tradeId) : undefined);
                const tradeId = active?.tradeId ?? data.tradeId ?? doc.id;
                // Restore safety tracking ONLY; journal status never proves a live trade.
                rehydrateRolloverPending(tradeId, { ...data, journalId: doc.id });
                const pending = rolloverDWideMap.get(tradeId)!;
                if (active) {
                    active.journalId ??= pending.journalId;
                    active.ctraderPositionId ??= pending.positionId;
                    active.ticker ??= pending.ticker!;
                    active.direction ??= pending.direction!;
                    Object.assign(active, Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith('rollover'))), {
                        rolloverDWidened: true, rolloverDSlOriginal: pending.orig, rolloverDSlWide: pending.wide,
                        rolloverDRestoreTries: pending.tries, rolloverDNextRetryAt: pending.nextRetryAt ?? 0,
                        rolloverDWidenedAt: pending.at, rolloverDPositionId: pending.positionId,
                        rolloverDTicker: pending.ticker, rolloverDDirection: pending.direction,
                    });
                }
            }
            await loadLiveRolloverJournalRecords();
            rolloverJournalRecoveryReady = true;
            return true;
        } catch (e: any) {
            console.error('[ROLLOVER-D] Journal pending recovery unavailable:', e.message);
            return false;
        }
    })().finally(() => { rolloverJournalRecoveryInFlight = null; });
    return rolloverJournalRecoveryInFlight;
}
let rolloverCycleInFlight: Promise<void> | null = null;
function runRolloverCycle(nowMs: number): Promise<void> {
    if (rolloverCycleInFlight) return rolloverCycleInFlight;
    rolloverCycleInFlight = (async () => {
        // Retry recovery without stalling known restores behind a slow journal read.
        // The shared lookup keeps A/D fail-closed until it finishes successfully.
        if (!rolloverJournalRecoveryReady) void loadRolloverJournalPending();
        const tickers = new Set<string>();
        for (const trade of globalState.activeTrades.values()) if (!trade.isBacktest) tickers.add(trade.ticker);
        for (const entry of rolloverDWideMap.values()) if (entry.ticker) tickers.add(entry.ticker);
        for (const entry of rolloverTriageRecords.values()) tickers.add(entry.ticker);
        for (const ticker of tickers) {
            const previous = globalState.tickerLocks.get(ticker) ?? Promise.resolve();
            let release!: () => void;
            const lock = new Promise<void>(resolve => { release = resolve; });
            globalState.tickerLocks.set(ticker, lock);
            try {
                await previous;
                // Re-evaluate wall clock after waiting (never act on a stale pre-pause instant).
                const effectiveNow = Math.max(nowMs, Date.now());
                const records = new Map(rolloverTriageRecords);
                for (const [id,active] of globalState.activeTrades) if (active.rolloverFill || !records.has(id)) records.set(id,active);
                for (const [tradeId,trade] of records) {
                    if (trade.ticker === ticker && trade.rolloverFill?.policy.profile === 'rollover_triage_v1')
                        try { await runLiveRolloverTriage(tradeId,trade); }
                        catch (error: any) { console.error('[ROLLOVER] Triage safety retained:', error.message); }
                }
                await applyRolloverProtection(effectiveNow, ticker);
                await applyRolloverWiden(effectiveNow, ticker);
                await applyRolloverRestore(effectiveNow, false, ticker);
            } finally {
                release();
                if (globalState.tickerLocks.get(ticker) === lock) globalState.tickerLocks.delete(ticker);
            }
        }
    })().finally(() => { rolloverCycleInFlight = null; });
    return rolloverCycleInFlight;
}

export function startWatchdog() {
    if (watchdogStarted) return;
    watchdogStarted = true;

    const checkVix = async () => {
        try {
            const fetch = (await import('node-fetch')).default;
            const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';
            let vix: number | null = null;
            let source = '';
            // 1) Finnhub (rápido, pero el plan free NO trae índices → devuelve c:0)
            if (FINNHUB_API_KEY) {
                try {
                    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB_API_KEY}`);
                    const data: any = await res.json();
                    if (data && Number(data.c) > 0) { vix = Number(data.c); source = 'finnhub'; }
                } catch { /* cae al fallback */ }
            }
            // 2) FIX (07-sep-2026): fallback Yahoo Finance ^VIX — sin key, sin plan premium.
            //    Finnhub free devuelve c:0 para VIX (índices fuera del plan) → el killswitch VIX
            //    quedaba muerto. Yahoo entrega el precio en regularMarketPrice.
            if (vix === null) {
                try {
                    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d', {
                        headers: { 'User-Agent': 'Mozilla/5.0 (JARVIS-VIX-fallback)' },
                    });
                    const data: any = await res.json();
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    if (price && Number(price) > 0) { vix = Number(price); source = 'yahoo'; }
                } catch { /* sin VIX hoy */ }
            }
            if (vix === null) {
                console.warn('[NEWS FILTER] ⚠️ VIX no disponible (Finnhub c:0 + Yahoo falló). Killswitch VIX sin cambios.');
                return; // 🛡️ no tocar el killswitch si no hay dato confiable
            }
            if (vix > 30) {
                console.log(`[NEWS FILTER] VIX = ${vix.toFixed(2)} (>30, vía ${source}). KILLSWITCH VIX ACTIVADO.`);
                globalState.vixKillswitchUntil = Date.now() + 20 * 60 * 1000;
            } else {
                globalState.vixKillswitchUntil = 0;
            }
        } catch (e) {
            console.error('[NEWS FILTER] Error verificando VIX:', e);
        }
    };
    setInterval(checkVix, 15 * 60 * 1000);
    checkVix();

    // 📊 v5.6: Resumen diario UNIFICADO — delega a journal.ts (sendDailyReview)
    // Mantiene solo la lógica de scheduling (18:00 ART, once-per-day guard)
    const scheduleDailySummary = () => {
        const now = new Date();
        const artNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
        const artHour = artNow.getHours();
        const artMin = artNow.getMinutes();

        // Disparar entre 18:00 y 18:05 ART
        if (artHour === 18 && artMin >= 0 && artMin < 5) {
            const today = artNow.toISOString().split('T')[0];
            const lastSummaryDate = (globalThis as any).__lastSummaryDate;
            if (lastSummaryDate === today) return;
            (globalThis as any).__lastSummaryDate = today;

            sendDailyReview()
                .then(() => console.log(`[DAILY] 📊 Resumen diario enviado via journal.ts`))
                .catch((e: any) => console.error('[DAILY] Error generando resumen:', e));
        }
    };
    setInterval(scheduleDailySummary, 5 * 60 * 1000);
    scheduleDailySummary();

    // Shared ticker locks coordinate rollover with ordinary position management.
    // rolloverBeEnabled:false disables new A/D actions, never abandons pending restores.
    setInterval(() => {
        runRolloverCycle(Date.now()).catch((e: any) => console.error('[ROLLOVER] Cycle failed:', e.message));
    }, 30 * 1000);
    console.log('[ROLLOVER] Broker-calendar A/D recovery active; serialized, durable, fresh normalized spread required.');

    // 🆕 v7.9: helper "mercado FX cerrado" (tz del VPS = Europe/Berlin)
    const isFxMarketClosed = (d: Date): boolean => {
        const day = d.getDay();
        const h = d.getHours();
        if (day === 6) return true;            // sábado
        if (day === 0) return h < 23;          // domingo antes de la apertura
        if (day === 5) return h >= 22;         // viernes tras el cierre (horario de verano)
        return false;
    };

    setInterval(() => {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

        for (const [id, trade] of globalState.activeTrades) {
            const age = now - trade.timestamp;
            // 🛡️ Si no hay registros de pings para este ticker, usamos la hora de creación del trade
            // para evitar que se interprete como inactivo desde 1970 (inactividad = now)
            const lastSeen = globalState.tickerLastSeen.get(trade.ticker) || trade.timestamp;
            const inactivity = now - lastSeen;

            // Si globalState.tickerLastSeen está completamente vacío (post-reinicio), no cerrar el trade
            if (globalState.tickerLastSeen.size === 0) {
                continue; // No cerrar trades hasta que llegue el primer PING real
            }

            // Cierre por timeout: ELIMINADO SEGÚN SOLICITUD

            // Limpieza de trades huérfanos (7 días)
            if (canExpireOrphanTrade(id, age) && !(trade as any).rolloverDWidened) {
                globalState.activeTrades.delete(id);
                if (db && !trade.isBacktest) db.collection('active_trades').doc(id).delete().catch(() => { });
                console.log(`[JOURNAL] 🧹 Trade ${id} expirado de RAM (7 días)`);
            }
        }

        // 🔔 Alerta proactiva de desconexión (v7.9: aviso REAL por Telegram, no solo log)
        const disconnectedFeed: string[] = [];
        for (const [ticker, lastSeen] of globalState.tickerLastSeen) {
            const inactiveMin = Math.round((now - lastSeen) / 60000);
            if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
                const state = globalState.localRadarStates.get(ticker);
                const lastHb = state?.lastHeartbeat || 0;
                // 🛡️ v5.5: Ignorar timestamps "viejos" que vienen de Firebase post-reinicio
                // Si lastHeartbeat es 0 o menor que el timestamp de hace 2 horas, son datos inválidos
                const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
                const hbAge = (lastHb > 0 && lastHb > (now - 86400000)) ? (now - lastHb) : 0;

                // 🛡️ v5.5: Solo enviar alerta de desconexión si realmente está desconectado
                // (>2 horas sin heartbeat Y sin otros eventos en el mismo período)
                if (hbAge < TWO_HOURS_MS) continue; // Tiene heartbeat reciente, no está desconectado

                // 🛡️ v5.5.1: Solo alertar 1 vez por desconexión — no spamear
                globalState.tickerLastSeen.delete(ticker); // Lo borramos para que no vuelva a alertar
                console.warn(`[WATCHDOG] 🔌 ${ticker}: DESCONECTADO hace ${inactiveMin} min.`);
                disconnectedFeed.push(`${ticker} (${inactiveMin} min)`);
            }
        }
        // 🆕 v7.9: aviso por Telegram agrupado, solo con mercado abierto
        if (disconnectedFeed.length > 0) {
            if (!isFxMarketClosed(new Date())) {
                sendTelegramAlert(`⚠️ [WATCHDOG] Feed desconectado hace >2h: ${disconnectedFeed.join(', ')}.`);
            } else {
                console.warn(`[WATCHDOG] 🔌 Desconectados durante el finde (mercado cerrado), sin Telegram: ${disconnectedFeed.join(', ')}`);
            }
        }
    }, WATCHDOG_INTERVAL_MS);
}

/**
 * 🆕 v7.2: Inyectar el ID de la posición de cTrader en la RAM
 * Esto permite que trading.ts pueda hacer cierres parciales y breakeven automáticamente
 */
/** RAM hold is installed before best-effort durable writes; never retry the broker order. */
export function hasUnresolvedExecutionIncidents(): boolean {
    return [...globalState.activeTrades.values()].some(t => hasPendingExecutionIncident(t as any));
}

/** Shared delayed-approval/AUTO entry policy; latches and alerts remain in existing risk evaluators. */
export async function recheckLiveExecutionRisk(ticker: string, nowMs = Date.now()): Promise<string | null> {
    // Synchronous policy is shared by AUTO and delayed manual approval, including
    // a final read after ledger awaits: latches/settings may change during I/O.
    const currentPolicy = (at: number): string | null => {
        const cfg = getConfigForTicker(ticker, at);
        if (!cfg.sessionEnabled) return 'BLOCKED_SESSION';
        if (globalState.globalKillswitches?.['GLOBAL_SYSTEM'] || globalState.globalKillswitches?.[ticker]) return 'BLOCKED_KILLSWITCH';
        if (hasUnresolvedExecutionIncidents()) return 'BLOCKED_EXECUTION_INCIDENT';
        if (at < globalState.streakKillswitchUntil) return 'BLOCKED_RACHA';
        if (at < globalState.vixKillswitchUntil) return 'BLOCKED_VIX';
        if (tickFlow.isSpreadAnomalous(ticker)) return 'BLOCKED_SPREAD';
        if ((cfg as any).rolloverEntryBlock !== false && isRolloverEntryWindow(ticker, at)) return 'BLOCKED_ROLLOVER';
        return null;
    };
    const blocked = currentPolicy(nowMs);
    if (blocked) return blocked;
    if (await evaluateGlobalKillswitch(nowMs, globalState, false)) return 'BLOCKED_GLOBAL';
    if (await evaluateAssetKillswitch(ticker, nowMs, globalState, false)) return 'BLOCKED_ASSET';
    return currentPolicy(Date.now());
}

export async function retainExecutionIncident(tradeId: string, journalId: string | undefined, result: import('../services/ctrader.js').CTraderOrderResult | null | undefined): Promise<boolean> {
    if (result && !result.success && !result.positionId && !result.executionUncertain) return false;
    let trade = globalState.activeTrades.get(tradeId);
    if (!trade) {
        // A lost candidate is still an account-wide obligation, not permission to send another order.
        trade = { tradeId, journalId, timestamp: Date.now(),
            ...(result?.riskSnapshot ? { ticker: result.riskSnapshot.ticker, direction: result.riskSnapshot.direction } : {}) } as ActiveTrade;
        globalState.activeTrades.set(tradeId, trade);
    }
    const fields: Record<string, any> = {
        executionIncidentPending: true, closeAccountingPending: true,
        executionUncertain: result?.executionUncertain === true || !result?.positionId,
        ctraderStatus: 'EXECUTION_PENDING_RECONCILIATION', result: null, rMultiple: null,
        ctraderError: result?.error ?? 'Execution/accounting outcome requires reconciliation',
        ...(result?.positionId ? { ctraderPositionId: result.positionId } : {}),
        ...(result?.executedPrice ? { ctraderExecutedPrice: result.executedPrice } : {}),
        ...(result?.lots != null ? { ctraderLots: result.lots } : {}),
        ...(Number.isFinite(result?.riskBudgetAccount) ? { riskBudgetAccount: result!.riskBudgetAccount } : {}),
    };
    if (trade) {
        // Preserve established identity; conflicting evidence is an incident, not a new position.
        if (trade.ctraderPositionId) fields.ctraderPositionId = trade.ctraderPositionId;
        Object.assign(trade, fields);
        freezeTradeRiskForTrade(trade, result?.riskSnapshot);
        fields.riskAccountingStatus = trade.riskAccountingStatus ?? 'UNVERIFIED';
        if (trade.riskSnapshot) { fields.riskSnapshot = trade.riskSnapshot; fields.accountCurrency = trade.accountCurrency; }
    }
    invalidateRiskCache();
    if (db) {
        const jid = journalId && !['ERR', 'N/A'].includes(journalId) ? journalId : trade?.journalId || tradeId;
        for (const [collection, id] of [['active_trades', tradeId], ['trade_journal', jid]]) {
            try { await db.collection(collection!).doc(id!).set(fields, { merge: true }); }
            catch (error: any) { console.error(`[EXECUTION] Incident retained in RAM; ${collection}/${id} persistence failed:`, error?.message); }
        }
    }
    return true;
}

export async function updateTradePositionId(tradeId: string, positionId: string, riskSnapshot?: TradeRiskSnapshot): Promise<void> {
    const trade = globalState.activeTrades.get(tradeId);
    if (!trade) throw new Error('Trade risk active identity unavailable');
    if (trade.isBacktest) return;
    if (trade.ctraderPositionId && trade.ctraderPositionId !== positionId) throw new Error('Trade risk position identity mismatch');
    const establishedRisk = trade.riskAccountingStatus === 'VERIFIED' && !!trade.riskSnapshot;
    trade.ctraderPositionId = positionId;
    const verified = freezeTradeRiskForTrade(trade, riskSnapshot);
    if (verified) {
        const frozen = trade.riskSnapshot!;
        trade.entryPrice = frozen.entryPrice;
        Object.defineProperty(trade, 'initialSlPrice', { value: frozen.initialSlPrice, enumerable: true, writable: false, configurable: false });
        trade.originalSlPrice = frozen.initialSlPrice;
        // A repeated link must not undo an existing broker-managed/trailing stop.
        if (!establishedRisk && !trade.tp1Hit && !trade.executionState) trade.slPrice = frozen.initialSlPrice;
        Object.assign(trade, { riskAmountAccount: frozen.riskAmountAccount, riskAccountingProvenance: frozen.source });
    }
    const fields = { ctraderPositionId: positionId, riskAccountingStatus: trade.riskAccountingStatus ?? 'UNVERIFIED',
        ...(verified ? { riskSnapshot: trade.riskSnapshot, accountCurrency: trade.accountCurrency,
            entryPrice: trade.entryPrice, initialSlPrice: trade.initialSlPrice, originalSlPrice: trade.originalSlPrice, slPrice: trade.slPrice,
            riskAmountAccount: trade.riskSnapshot!.riskAmountAccount, riskAccountingProvenance: trade.riskSnapshot!.source } : {}) };
    // Await this boundary before management: failures remain executed-but-pending, never aborted.
    const { db } = await import('./memory.js');
    if (!db) throw new Error('Trade risk persistence unavailable');
    await db.collection('active_trades').doc(tradeId).update(fields);
    console.log(`[RADAR] 🔗 Enlazado trade #${tradeId} con cTrader posID: ${positionId} en RAM`);
}

// C: pause→reopen+30m minimum. Outside it, missing/stale/wide spread remains closed.
// No cutoff auto-reopens entries; each attempt needs real bilateral quote evidence.
function isRolloverEntryWindow(ticker: string, nowMs: number): boolean {
    const snapshot = getRolloverLiveSnapshot(ticker, nowMs);
    const reference = getRolloverSpreadReference(ticker, snapshot?.bid ?? 1);
    return evaluateRolloverEntryGate(ticker, nowMs, snapshot, { live: true, ...reference }).blocked;
}

async function dispatchOteSignal(dispatchData: any, state: any, docRef: any, ctx: any) {
    const { ticker, nowMs, isBacktest, sessionThresholds, store } = ctx;
    const oteData = dispatchData;
    const { db: fireDb } = await import('./memory.js');
    const db = fireDb;

    // 🔧 FIX: safeSet debe estar en el scope de dispatchOteSignal (no hereda el de processTradingAlert)
    const safeSet = (data: any, options?: any) => {
        if (isBacktest) return Promise.resolve();
        if (docRef) return docRef.set(data, options);
        return Promise.resolve(); // sin Firestore, sin problema
    };

    // =========================================================================
    // EJECUCIÓN OTE FUERA DE LA TRANSACCIÓN
    // =========================================================================
    {
        console.log(`[SNIPER] 🎯 triggerOte=true para ${ticker} ${oteData.direction}. Puntos: ${oteData.points}. Evaluando killswitches...`);

        state.lastGatillo = {
            dir: oteData.direction as 'BUY' | 'SELL',
            price: oteData.entryPrice,
            time: nowMs,
            type: oteData.isChochEntry ? 'CHOCH' : 'OTE',
            status: 'EVALUANDO...',
            tf: oteData.tf
        };

        state.version = (state.version || 0) + 1;
        state.lastModified = nowMs;
        safeSet(state, { merge: true }).catch((err: any) => console.error(`[FIREBASE] Error guardando gatillo ${ticker}: ${err.message}`)); // Update status in UI immediately

        const config = getConfigForTicker(ticker, nowMs);
        const executionPolicy = resolveExecutionPolicy(config.executionPolicy);
        const executionInstrument = executionPolicy.profile === 'microstructure_v1'
            ? getLiveExecutionInstrument(ticker) ?? (config.executionInstrument?.source === 'explicit_model' ? config.executionInstrument : undefined) : undefined;
        if (executionPolicy.profile === 'microstructure_v1') {
            const q = getLastBidAsk(ticker, nowMs);
            const setup = oteData.executionTf ? getExecutionSnapshot(state, oteData.executionTf, nowMs) : undefined;
            if (!setup?.bar || !setup.closedBar || !(setup.atr14! > 0)
                || ![oteData.entryPrice,Number(oteData.stopLoss),Number(oteData.tp1),Number(oteData.tp2)].every(v => Number.isFinite(v) && v > 0)
                || !validateExecutionInstrument(executionInstrument) || executionInstrument.ticker !== ticker || !q || q.ts > nowMs || nowMs-q.ts > 10000
                || !(q.bid > 0 && q.ask >= q.bid) || !store.dynamicBotConfig.autoTrading) {
                state.lastGatillo.status = 'WAIT_DATA_EXECUTION_INSTRUMENT_QUOTE_OR_FILL_CALLBACK';
                store.activeTrades.delete(oteData.tradeId);
                return;
            }

        }
        if (!config.sessionEnabled) {
            console.log(`[RADAR] 🚫 Trading desactivado para ${ticker} en esta sesión (OTE bloqueado)`);
            state.lastGatillo.status = 'BLOCKED_SESSION';
            logBlockedSignal('SESSION', oteData, nowMs);
            safeSet(state).catch(() => { });
            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        const currentSession = getCurrentSession(nowMs);
        const warmupMin = (config as any).sessionWarmupMin ?? 15;
        if ((currentSession === 'LONDON' || currentSession === 'NY') && minutesSinceSessionOpen(nowMs) < warmupMin) {
            console.log(`[RADAR] 🚫 Trading bloqueado por warmup de sesión (${currentSession}) para ${ticker}`);
            state.lastGatillo.status = 'BLOCKED_WARMUP';
            logBlockedSignal('WARMUP', oteData, nowMs);
            safeSet(state).catch(() => { });
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        const isGlobalKilled = await evaluateGlobalKillswitch(nowMs, store, isBacktest);
        if (isGlobalKilled) {
            console.log(`[GLOBAL KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por riesgo global consolidado de la cuenta.`);
            state.lastGatillo.status = 'BLOCKED_GLOBAL';
            logBlockedSignal('GLOBAL_KILLSWITCH', oteData, nowMs);
            safeSet(state).catch(() => { });
            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        // 🆕 Killswitch POR ACTIVO (límites de asset_configs/{ticker})
        if (await evaluateAssetKillswitch(ticker, nowMs, store, isBacktest)) {
            console.log(`[ASSET KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por límite de riesgo del activo.`);
            state.lastGatillo.status = 'BLOCKED_ASSET';
            logBlockedSignal('ASSET_KILLSWITCH', oteData, nowMs);
            safeSet(state).catch(() => { });
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        if (nowMs < store.streakKillswitchUntil) {
            const remainingMin = Math.round((store.streakKillswitchUntil - nowMs) / 60000);
            console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por racha perdedora (${store.consecutiveLosses} pérdidas). Restan ${remainingMin} min de bloqueo.`);
            state.lastGatillo.status = 'BLOCKED_RACHA';
            logBlockedSignal('RACHA', oteData, nowMs);
            safeSet(state).catch(() => { });
            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }
        if (nowMs < store.vixKillswitchUntil) {
            const remainingMin = Math.round((store.vixKillswitchUntil - nowMs) / 60000);
            console.log(`[KILLSWITCH] ⛔ Setup ${ticker} ${oteData.direction} IGNORADO por VIX>30. Restan ${remainingMin} min de bloqueo.`);
            state.lastGatillo.status = 'BLOCKED_VIX';
            logBlockedSignal('VIX', oteData, nowMs);
            safeSet(state).catch(() => { });
            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
            return;
        }

        // ═══ TIMESFM FILTER (F1) — post-killswitches, pre-ejecución ═══
        // Espejo del gate en backtestEngine.ts createTrade. Regla de oro: si el puente
        // falla / forecast viejo / timeout → se loguea DEGRADADO y el trade SIGUE (nunca frenar).
        const tfmCfg = resolveTimesfmConfig((config as any).timesfm);
        if (tfmCfg.enabled && !isBacktest) {
            const atrNow = state.atr14 ?? 0;
            const tfmDecision: TimesfmDecision = atrNow > 0
                ? await fetchLiveTimesfmDecision({
                    ticker,
                    tfMinutes: parseInt(String(oteData.tf || '15').replace(/\D/g, '')) || 15,
                    signalDir: oteData.direction as 'BUY' | 'SELL',
                    currentPrice: oteData.entryPrice,
                    atr14: atrNow,
                    smcPoints: oteData.points,
                    cfg: tfmCfg,
                })
                : { action: 'APPROVE', riskMult: 1.0, forecastDir: 'FLAT', highConviction: false, spreadAtr: 0, forecastMedian: 0, reason: 'DEGRADADO: ATR no inicializado', degraded: true };
            const tfmAudit: Record<string, unknown> = {
                ts: nowMs, ticker, direction: oteData.direction, points: oteData.points,
                action: tfmDecision.action, riskMult: tfmDecision.riskMult,
                forecastDir: tfmDecision.forecastDir, spreadAtr: +tfmDecision.spreadAtr.toFixed(4),
                reason: tfmDecision.reason, degraded: tfmDecision.degraded, dryRun: tfmCfg.dryRun === true,
                tp2Dynamic: false,
            };
            console.log(`[TIMESFM${tfmCfg.dryRun ? ' DRY' : ''}] ${ticker} ${oteData.direction} → ${tfmDecision.action} (mult=${tfmDecision.riskMult}) — ${tfmDecision.reason}`);
            // 🆕 Radar v2: registrar veredicto para el dashboard (mapa en memoria + gatillo actual)
            lastTfmByTicker.set(ticker, {
                action: tfmDecision.action, riskMult: tfmDecision.riskMult,
                degraded: tfmDecision.degraded, dryRun: tfmCfg.dryRun === true, ts: nowMs,
            });
            (state.lastGatillo as any).tfm = {
                action: tfmDecision.action, riskMult: tfmDecision.riskMult,
                degraded: tfmDecision.degraded, dryRun: tfmCfg.dryRun === true,
            };
            if (tfmCfg.dryRun) {
                // F2 shadow: auditar sin aplicar — el trade sigue con riskMult intacto
            } else if (tfmDecision.action === 'REJECT') {
                appendTimesfmAudit(tfmCfg.auditPath ?? 'logs/timesfm_audit.jsonl', tfmAudit);
                state.lastGatillo.status = 'BLOCKED_TIMESFM';
            logBlockedSignal('TIMESFM', oteData, nowMs);
                safeSet(state).catch(() => { });
                store.activeTrades.delete(oteData.tradeId);
                if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                return;
            } else {
                oteData.timesfmAction = tfmDecision.action;
                oteData.riskMult = tfmDecision.riskMult;
                // Fase C: TP2 dinámico por q90 (SL sigue estructural/slBuff por diseño).
                if (tfmCfg.tp2Dynamic === 'q90' && tfmDecision.forecast && !tfmDecision.degraded) {
                    const dyn = resolveTp2FromForecast(tfmDecision.forecast, oteData.direction as 'BUY' | 'SELL', oteData.entryPrice, tfmCfg.tp2Q90Step ?? 2);
                    if (dyn !== null) {
                        oteData.tp2 = String(dyn);
                        oteData.tp2DynamicSource = 'q90';
                        tfmAudit.tp2Dynamic = true;
                        tfmAudit.tp2Price = dyn;
                    }
                }
            }
            appendTimesfmAudit(tfmCfg.auditPath ?? 'logs/timesfm_audit.jsonl', tfmAudit);
        }

        // Last target calculation follows any TimesFM request; legacy cap must not recap checked targets.
        if (executionPolicy.targets && executionInstrument) {
            const targets = computeExecutionTargets({ direction: oteData.direction, entryPrice: oteData.entryPrice, initialSlPrice: parseFloat(oteData.stopLoss),
                regime: executionInstrument.regime, adr: getAdrPrice(ticker), structuralTp1Price: parseFloat(oteData.tp1), requestedTp2Price: parseFloat(oteData.tp2) });
            if (!targets.valid) { state.lastGatillo.status = `WAIT_DATA_${targets.reason}`; store.activeTrades.delete(oteData.tradeId); return; }
            oteData.tp1 = String(targets.tp1Price); oteData.tp2 = String(targets.tp2Price); oteData.executionTargetsChecked = true;
            const candidate = store.activeTrades.get(oteData.tradeId);
            if (candidate) { candidate.tp1Price = targets.tp1Price; candidate.tp2Price = targets.tp2Price; }
        }
        let activeSessionId: string | undefined;
        if (isBacktest) {
            const { getCurrentSessionId } = await import('../services/backtesting.js');
            activeSessionId = getCurrentSessionId() || undefined;
        }

        // 🆕 v7.1: FILTRO DE OPERACIONES SELL POR ACTIVO (Anti-Short Bias)
        // Para activos con sesgo alcista (ej. NAS100), limita la cantidad de SELLs diarios
        // y/o exige un puntaje mínimo más alto para señales bajistas.
        if (oteData.direction === 'SELL') {
            const sellConfig = getConfigForTicker(ticker, nowMs);

            // 🛑 Verificar pérdidas consecutivas (MCL) direccionales por sesión y activo
            const currentSession = getCurrentSession(nowMs);
            const sessionConfig = sellConfig.sessions?.[currentSession];
            if (sessionConfig && sessionConfig.maxSellLosses !== undefined && sessionConfig.maxSellLosses > 0) {
                const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'SELL', nowMs, store, isBacktest, activeSessionId);
                if (currentConsecutiveLosses >= sessionConfig.maxSellLosses) {
                    console.log(`[MCL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${currentConsecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas en sesión ${currentSession}.`);
            logBlockedSignal('MCL_SELL', oteData, nowMs);
                    state.lastGatillo!.status = 'BLOCKED_MCL_LIMIT';
                    safeSet(state).catch(() => { });
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });

                    sendTelegramAlert(
                        `🚨 <b>[MCL LIMIT]</b> ${ticker} SELL ignorado.\n\n` +
                        `📊 Se alcanzaron <b>${currentConsecutiveLosses}/${sessionConfig.maxSellLosses}</b> pérdidas consecutivas de tipo SELL hoy en la sesión <b>${currentSession}</b>.\n` +
                        `💡 <i>Límite de pérdidas consecutivas (maxSellLosses) superado.</i>`
                    ).catch(() => { });
                    return;
                }
                console.log(`[MCL LIMIT] ✅ ${ticker} SELL permitido: ${currentConsecutiveLosses}/${sessionConfig.maxSellLosses} pérdidas consecutivas de tipo SELL.`);
            }

            // 📊 Verificar límite diario de SELLs
            if (sellConfig.maxSellsPerDay > 0) {
                const dailySells = await countDailySellsForTicker(ticker, nowMs, isBacktest, activeSessionId);
                if (dailySells >= sellConfig.maxSellsPerDay) {
                    console.log(`[SELL LIMIT] ⛔ Setup ${ticker} SELL BLOQUEADO: ${dailySells}/${sellConfig.maxSellsPerDay} SELLs diarios alcanzados.`);
            logBlockedSignal('SELL_LIMIT', oteData, nowMs);
                    state.lastGatillo!.status = 'BLOCKED_SELL_LIMIT';
                    safeSet(state).catch(() => { });
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });

                    sendTelegramAlert(
                        `⚠️ <b>[SELL LIMIT]</b> ${ticker} SELL ignorado.\n\n` +
                        `📊 Ya se ejecutaron <b>${dailySells}/${sellConfig.maxSellsPerDay}</b> operaciones SELL hoy en este activo.\n` +
                        `💡 <i>Configurá maxSellsPerDay en asset_configs para ajustar el límite.</i>`
                    ).catch(() => { });
                    return;
                }
                console.log(`[SELL LIMIT] ✅ ${ticker} SELL permitido: ${dailySells}/${sellConfig.maxSellsPerDay} SELLs usados hoy.`);
            }

        }

        // 🆕 v7.2: FILTRO DE OPERACIONES BUY (Anti-Long Bias)
        if (oteData.direction === 'BUY') {
            const buyConfig = getConfigForTicker(ticker, nowMs);

            // 🛑 Verificar pérdidas consecutivas (MCL) direccionales por sesión y activo
            const currentSession = getCurrentSession(nowMs);
            const sessionConfig = buyConfig.sessions?.[currentSession];
            if (sessionConfig && sessionConfig.maxBuyLosses !== undefined && sessionConfig.maxBuyLosses > 0) {
                const currentConsecutiveLosses = await countConsecutiveLosses(ticker, currentSession, 'BUY', nowMs, store, isBacktest, activeSessionId);
                if (currentConsecutiveLosses >= sessionConfig.maxBuyLosses) {
                    console.log(`[MCL LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas en sesión ${currentSession}.`);
                    logBlockedSignal('MCL_BUY', oteData, nowMs);
                    state.lastGatillo!.status = 'BLOCKED_MCL_LIMIT';
                    safeSet(state).catch(() => { });
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });

                    sendTelegramAlert(
                        `🚨 <b>[MCL LIMIT]</b> ${ticker} BUY ignorado.\n\n` +
                        `📊 Se alcanzaron <b>${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses}</b> pérdidas consecutivas de tipo BUY hoy en la sesión <b>${currentSession}</b>.\n` +
                        `💡 <i>Límite de pérdidas consecutivas (maxBuyLosses) superado.</i>`
                    ).catch(() => { });
                    return;
                }
                console.log(`[MCL LIMIT] ✅ ${ticker} BUY permitido: ${currentConsecutiveLosses}/${sessionConfig.maxBuyLosses} pérdidas consecutivas de tipo BUY.`);
            }

            // 📊 Verificar límite diario de BUYs
            if (buyConfig.maxBuysPerDay > 0) {
                const dailyBuys = await countDailyBuysForTicker(ticker, nowMs, isBacktest, activeSessionId);
                if (dailyBuys >= buyConfig.maxBuysPerDay) {
                    console.log(`[BUY LIMIT] ⛔ Setup ${ticker} BUY BLOQUEADO: ${dailyBuys}/${buyConfig.maxBuysPerDay} BUYs diarios alcanzados.`);
            logBlockedSignal('BUY_LIMIT', oteData, nowMs);
                    state.lastGatillo!.status = 'BLOCKED_BUY_LIMIT';
                    safeSet(state).catch(() => { });
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });

                    sendTelegramAlert(
                        `⚠️ <b>[BUY LIMIT]</b> ${ticker} BUY ignorado.\n\n` +
                        `📊 Ya se ejecutaron <b>${dailyBuys}/${buyConfig.maxBuysPerDay}</b> operaciones BUY hoy en este activo.\n` +
                        `💡 <i>Configurá maxBuysPerDay en asset_configs para ajustar el límite.</i>`
                    ).catch(() => { });
                    return;
                }
                console.log(`[BUY LIMIT] ✅ ${ticker} BUY permitido: ${dailyBuys}/${buyConfig.maxBuysPerDay} BUYs usados hoy.`);
            }

        }

        // 🆕 Filtro Anti-Piramidación y Lógica SAR (Stop and Reverse)
        let existingTradeForTicker: ActiveTrade | undefined;
        for (const trade of store.activeTrades.values()) {
            if (trade.ticker === ticker && trade.tradeId !== oteData.tradeId) {
                existingTradeForTicker = trade;
                break;
            }
        }

        // 🛡️ Extra check: Si no hay en RAM, revisemos cTrader real para evitar duplicados huérfanos
        let cTraderPos: any;
        if (!isBacktest && !existingTradeForTicker) {
            try {
                const ctrader = await import('../services/ctrader.js');
                if (ctrader.isCTraderReady()) {
                    const openPositions = await ctrader.getOpenPositions(ticker);
                    if (openPositions && openPositions.length > 0) {
                        cTraderPos = openPositions[0];
                        // tradeSide es un ENUM numérico de cTrader: 1 = BUY, 2 = SELL.
                        // Antes se leía como string ('1') y toda posición quedaba como SELL.
                        const sideRaw: any = cTraderPos.tradeData?.tradeSide ?? cTraderPos.tradeSide;
                        let cTraderDir = '';
                        if (sideRaw === 1 || String(sideRaw).toUpperCase() === 'BUY') cTraderDir = 'BUY';
                        else if (sideRaw === 2 || String(sideRaw).toUpperCase() === 'SELL') cTraderDir = 'SELL';
                        // Crear un mock de ActiveTrade para aplicar la misma lógica
                        existingTradeForTicker = {
                            tradeId: String(cTraderPos.positionId || cTraderPos.id || 'CTRADER_MOCK'),
                            ticker: ticker,
                            direction: (cTraderDir || 'SELL') as 'BUY' | 'SELL',
                            entryPrice: cTraderPos.openPrice ?? cTraderPos.entryPrice ?? cTraderPos.price ?? 0,
                            tp1Price: 0, tp2Price: 0, slPrice: 0,
                            tp1Hit: false, tp2Hit: false,
                            score: 0, // Score 0 significa que cualquier señal nueva le ganará en SAR
                            timestamp: Date.now(), isBacktest: isBacktest,
                            ctraderPositionId: String(cTraderPos.positionId || cTraderPos.id)
                        };
                        console.log(`[ANTI-PYRAMID] ⚠️ Trade encontrado en cTrader (huérfano en RAM): ${existingTradeForTicker.direction} posID: ${existingTradeForTicker.ctraderPositionId}`);
                    }
                }
            } catch (e) {
                console.error("[ANTI-PYRAMID] Error verificando posiciones cTrader:", e);
            }
        }

        let sarPendingClose: any = null;
        if (existingTradeForTicker) {
            const cleanupPrecreatedTrade = () => {
                if (oteData && oteData.tradeId) {
                    store.activeTrades.delete(oteData.tradeId);
                    if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                }
            };

            if (existingTradeForTicker.direction === oteData.direction) {
                // Mismo sentido -> Bloquear para evitar piramidación
                console.log(`[ANTI-PYRAMID] ⛔ Señal ${oteData.direction} ignorada para ${ticker}: ya hay una operación activa en la misma dirección.`);
            logBlockedSignal('ANTIPYRAMID', oteData, nowMs);
                cleanupPrecreatedTrade();
                if (state.lastGatillo) state.lastGatillo.status = 'BLOCKED_ANTIPYRAMID';
                safeSet(state).catch(() => { });
                if (!isBacktest) sendTelegramAlert(`⚠️ <b>SEÑAL IGNORADA</b> | ${ticker}\nSe detectó una nueva señal <b>${oteData.direction}</b>, pero ya hay una operación abierta en la misma dirección. (Anti-Piramidación)`).catch(() => { });
                return;
            } else {
                // Dirección Opuesta -> SAR (Stop and Reverse)
                if (oteData.points > existingTradeForTicker.score) {
                    console.log(`[SAR] 🔄 Reversión Activada (Diferida) para ${ticker}: Nueva señal ${oteData.direction} (Score: ${oteData.points}) supera a la activa (Score: ${existingTradeForTicker.score}).`);
                    sarPendingClose = existingTradeForTicker;
                } else {
                    // Puntaje menor o igual -> Ignorar la nueva señal
                    console.log(`[SAR] ⛔ Reversión Denegada para ${ticker}: Nueva señal ${oteData.direction} (Score: ${oteData.points}) no supera a la activa (Score: ${existingTradeForTicker.score}).`);
            logBlockedSignal('SAR_DENIED', oteData, nowMs);
                    cleanupPrecreatedTrade();
                    if (state.lastGatillo) state.lastGatillo.status = 'BLOCKED_SAR_DENIED';
                    safeSet(state).catch(() => { });
                    if (!isBacktest) sendTelegramAlert(`⚠️ <b>SEÑAL DESCARTADA</b> | ${ticker}\n\nSe detectó una señal <b>${oteData.direction}</b> (Puntaje: ${oteData.points}), pero se mantiene la operación <b>${existingTradeForTicker.direction}</b> actual porque tiene mayor o igual convicción (Puntaje: ${existingTradeForTicker.score}).`).catch(() => { });
                    return;
                }
            }
        }

        // 🧲 FILTRO DE CORRELACIÓN CROSS-ASSET (EWMA M15) — ago-2026
        // Shadow por defecto: audita sin bloquear (paridad exacta de trading).
        // Para activar el bloqueo real: asset_configs/{ticker}.correlationFilter = {shadow:false}.
        if (!isBacktest) {
            const corrCfgObj = getConfigForTicker(ticker, nowMs);
            const corrCfg = resolveCorrelationConfig((corrCfgObj as any).correlationFilter);
            const corrOpenTrades = [...store.activeTrades.values()]
                .filter(t => t.ticker.toUpperCase() !== ticker.toUpperCase() && !(t as any).isBacktest)
                .map(t => ({ ticker: t.ticker, direction: t.direction }));
            const corrVerdict = evaluateCorrelationGate(ticker, oteData.direction as 'BUY' | 'SELL', corrOpenTrades, corrCfg);
            if (corrVerdict.applied) {
                appendCorrelationAudit(corrCfg.auditPath, {
                    ts: nowMs, ticker, direction: oteData.direction, points: oteData.points,
                    wouldBlock: corrVerdict.wouldBlock, blockedBy: corrVerdict.blockedBy,
                    riskMult: corrVerdict.riskMult, shadow: corrCfg.shadow, degraded: corrVerdict.degraded,
                });
                if (corrVerdict.wouldBlock) {
                    const detail = corrVerdict.blockedBy.map(b => `${b.otherTicker}(${b.otherDir}) ρ=${b.rho.toFixed(2)} [${b.rule}]`).join('; ');
                    if (corrCfg.shadow) {
                        console.log(`[CORRELATION SHADOW] ${ticker} ${oteData.direction} habría sido BLOQUEADO por: ${detail}`);
                    } else {
                        console.log(`[CORRELATION] ⛔ ${ticker} ${oteData.direction} BLOQUEADO por correlación: ${detail}`);
                        state.lastGatillo.status = 'BLOCKED_CORRELATION';
            logBlockedSignal('CORRELATION', oteData, nowMs);
                        safeSet(state).catch(() => { });
                        store.activeTrades.delete(oteData.tradeId);
                        if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                        return;
                    }
                } else if (corrVerdict.riskMult < 1) {
                    if (corrCfg.shadow) {
                        console.log(`[CORRELATION SHADOW] ${ticker} ${oteData.direction} riskMult habría sido ×${corrVerdict.riskMult.toFixed(2)} (clúster positivo misma dirección)`);
                    } else {
                        oteData.riskMult = (oteData.riskMult ?? 1) * corrVerdict.riskMult;
                        console.log(`[CORRELATION] ${ticker} ${oteData.direction} riskMult ×${corrVerdict.riskMult.toFixed(2)} (clúster positivo misma dirección)`);
                    }
                }
                if (corrVerdict.degraded) console.log(`[CORRELATION] ⚠️ ${ticker}: algún par sin correlación calculada (fail-open).`);
            }
        }

        const mlRegimeShadow = evaluateLiveRegimeShadow(ticker, state, oteData, nowMs, config);
        if (mlRegimeShadow !== undefined) {
            oteData.mlRegimeShadow = mlRegimeShadow;
            if (state.lastGatillo) state.lastGatillo.mlRegimeShadow = mlRegimeShadow;
        }

        // 🧠 ML GATE EXTENDIDO (16-sep-2026): audita TODOS los gatillos — directas incluidas.
        // - OTE: el veto real sigue en AlphaModel (paridad de motor intacta); acá solo se audita.
        // - DIRECTAS (isChochEntry): acá se audita Y se bloquea si el gate del activo está ON
        //   (mlGateEnabled=true, panel GATE ML) y el modelo rechaza. Default OFF → telemetría.
        if (!isBacktest) {
            try {
                const { predict: mlPredictAll, isMLActive: mlActiveAll } = await import('../engine/MLFilter.js');
                if (mlActiveAll()) {
                    const tfKey = String(oteData.tf || '5m').toLowerCase().includes('15') ? '15'
                        : String(oteData.tf || '5m').toLowerCase().includes('3') ? '3' : '5';
                    const mlPredAll = mlPredictAll(
                        state, oteData.direction as 'BUY' | 'SELL', nowMs,
                        Number((oteData as any).chochPoints ?? 0), Number(oteData.points ?? 0), tfKey, ticker,
                        { auditOnly: true },
                    );
                    if (mlPredAll) {
                        const gateOn = (getConfigForTicker(ticker, nowMs) as any)?.mlGateEnabled === true;
                        const entryKind = oteData.isChochEntry ? 'DIRECTA' : 'OTE';
                        console.log(`[ML-AUDIT] ${ticker} ${oteData.direction} (${entryKind}, ${oteData.points}pts): prob=${mlPredAll.probability.toFixed(3)} umbral=${mlPredAll.threshold} gate=${gateOn ? 'ON' : 'OFF'} → ${mlPredAll.approved ? 'APROBADO' : 'RECHAZADO'}`);
                        try {
                            fs.appendFileSync('/opt/JARVIS/logs/ml_audit_all.jsonl', JSON.stringify({
                                ts: nowMs, ticker, direction: oteData.direction, entryType: entryKind,
                                points: oteData.points, prob: mlPredAll.probability,
                                threshold: mlPredAll.threshold, approved: mlPredAll.approved, gateOn,
                            }) + '\n');
                        } catch { /* audit best-effort */ }
                        if (oteData.isChochEntry && gateOn && !mlPredAll.approved) {
                            console.log(`[ML] ⛔ ${ticker} ${oteData.direction} DIRECTA BLOQUEADA por ML (prob=${mlPredAll.probability.toFixed(3)} < ${mlPredAll.threshold})`);
                            if (state.lastGatillo) state.lastGatillo.status = 'BLOCKED_ML_DIRECTA';
            logBlockedSignal('ML_DIRECTA', oteData, nowMs);
                            safeSet(state).catch(() => { });
                            store.activeTrades.delete(oteData.tradeId);
                            if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                            return;
                        }
                    }
                }
            } catch (e: any) {
                console.warn(`[ML-AUDIT] ⚠️ error en gate extendido: ${e.message}`);
            }
        }

        const fingerprint = `OTE_${ticker}_${oteData.direction}_${oteData.tp1}`;
        console.log(`[SNIPER] 🔍 Verificando duplicado: ${fingerprint}`);
        if (!isDuplicate(fingerprint, nowMs)) {

            state.lastGatillo.status = 'PROCESANDO...';
            safeSet(state).catch((err: any) => console.error('[SNIPER] ❌ Fallo guardando estado (safeSet):', err?.message ?? err));

            let kronosAnnotation = '';
            let kronosVerdict: string = 'SKIP';
            let sessionId: string | undefined;

            if (isBacktest) {
                const { getCurrentSessionId } = await import('../services/backtesting.js');
                sessionId = getCurrentSessionId() || undefined;
            } else if (envConfig.KRONOS_AI_ENABLED) {
                let kronosRawDetails = '';
                // Kronos AI local (LSTM, sin quota externa) — off por default (sin backtest)
                try {
                    const { evaluateWithKronos } = await import('../services/kronos.js');
                    const kRes = await evaluateWithKronos(
                        ticker,
                        oteData.direction as 'BUY' | 'SELL',
                        Number(oteData.entryPrice),
                        Number(oteData.stopLoss),
                        Number(oteData.tp1)
                    );
                    kronosVerdict = (kRes as any).isConfirmed ? 'CONFIRMED' : 'DIVERGENCE';
                    kronosRawDetails = (kRes as any).rawDetails || (kRes as any).details || '';
                    kronosAnnotation = (kRes as any).trend === null
                        ? `\n\n🤖 <b>Kronos AI:</b> ${(kRes as any).details}`
                        : `\n\n🤖 <b>Kronos AI:</b> ${(kRes as any).isConfirmed ? '🟢 CONFIRMADO' : '🟠 DIVERGENCIA'}\n${(kRes as any).details}`;
                } catch { kronosVerdict = 'ERROR'; }
            }

            const isChoch = oteData.events?.some((e: string) => e.includes('CHoCH🚀'));
            const isBos = oteData.events?.some((e: string) => e.includes('BOS🔨'));
            const breakType = isChoch ? 'CHoCH' : isBos ? 'BOS' : 'SMC';
            const entryTypeLabel = oteData.isChochEntry
                ? (isBos ? 'BOS Directo' : 'CHoCH Directo')
                : `OTE (basado en ${breakType})`;

            let headerLabel = 'OTE';
            if (oteData.isChochEntry) {
                headerLabel = isBos ? 'BOS DIRECTO' : 'CHOCH DIRECTO';
            } else {
                headerLabel = `OTE (${breakType})`;
            }

            let msg = `${isBacktest ? "🧪 <b>BACKTESTING</b> | " : "🔥 "}<b>ALERTA FRANCOTIRADOR ${headerLabel} | ${ticker} | ${oteData.dirText}</b>\n\n`;
            msg += (oteData.confluenceReport || '').trim() + '\n\n';
            msg += `🎯 <b>Tipo de Entrada:</b> ${entryTypeLabel}\n`;
            msg += `🎯 <b>Puntaje Total:</b> ${oteData.points} Puntos\n`;
            msg += `🧱 <b>Confluencias:</b> ${oteData.events?.join(', ')}\n\n`;

            const config = getConfigForTicker(ticker, nowMs);
            let avisoRiesgo = oteData.points >= 8
                ? `Operar con riesgo estándar (${config.baseRiskPercentage}%).`
                : `Setup de puntaje medio. Riesgo reducido (${config.baseRiskPercentage / 2}%).`;

            const jarvisNote = oteData.isChochEntry
                ? `Gatillo de entrada directa por ${isBos ? 'BOS' : 'CHoCH'} confirmado. ${avisoRiesgo}`
                : `Llegada a zona OTE confirmada. ${avisoRiesgo}`;
            msg += `🧠 <b>Jarvis:</b> ${jarvisNote}\n\n`;
            msg += `📐 <b>Niveles de Ejecución (GATILLO):</b>\n`;
            msg += `🎯 Precio de Entrada: ${oteData.entryPrice}\n`;
            msg += `🛑 Stop Loss Sugerido: ${oteData.stopLoss}\n`;
            msg += `💰 Take Profit 1 (Interno): ${oteData.tp1}\n`;
            msg += `🚀 Take Profit 2 (Externo): ${oteData.tp2}\n`;

            msg += kronosAnnotation;

            console.log(`[SNIPER] 📨 Mensaje FRANCOTIRADOR construido para ${ticker} (${msg.length} chars). isBacktest=${isBacktest}`);

            // 🛡️ Dedupe: el mismo gatillo puede llegar 2 veces en <1s (doble evento SMC)
            // y cada dispatch creaba un doc → trades duplicados en la bitácora.
            let journalId: string | undefined;
            const dedupeKey = `${ticker}:${oteData.direction}`;
            const lastJournalTs = journalDedupe.get(dedupeKey) || 0;
            if (!isBacktest && nowMs - lastJournalTs < 30_000) {
                console.log(`[JOURNAL] ⏭️ Doc duplicado evitado para ${ticker} ${oteData.direction} (segundo dispatch del mismo gatillo en <30s)`);
                journalId = undefined;
            } else {
                journalDedupe.set(dedupeKey, nowMs);
                journalId = await logTrade({
                    ticker, direction: oteData.direction as 'BUY' | 'SELL',
                    grade: oteData.points >= 8 ? 'A+' : 'B', points: oteData.points, events: oteData.events,
                    macroContext: oteData.marketBias,
                    kronosVerdict: isBacktest ? 'SKIP_BT' : kronosVerdict,
                    timestamp: nowMs,
                    mode: isBacktest ? 'backtesting' : 'live',
                    sessionId,
                    entryPrice: oteData.entryPrice,
                    tp1Price: parseFloat(oteData.tp1),
                    tp2Price: oteData.tp2 !== 'Buscando DOL macro...' && oteData.tp2
                        ? (oteData.executionTargetsChecked ? parseFloat(oteData.tp2) : capTp2Price(ticker, oteData.direction as 'BUY' | 'SELL', oteData.entryPrice, parseFloat(oteData.stopLoss), parseFloat(oteData.tp2)))
                        : undefined,
                    slPrice: parseFloat(oteData.stopLoss),
                    initialSlPrice: store.activeTrades.get(oteData.tradeId)?.initialSlPrice ?? parseFloat(oteData.stopLoss),
                    isChochEntry: oteData.isChochEntry,
                    // 🧠 MACHINE LEARNING FEATURES (Fase 1)
                    hourOfDay: new Date(nowMs).getHours(),
                    dayOfWeek: new Date(nowMs).getDay(),
                    session: getCurrentSession(nowMs),
                    bias4H: state.marketBias['240'] === oteData.direction ? 'ALIGNED' : state.marketBias['240'] === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
                    bias1H: state.marketBias['60'] === oteData.direction ? 'ALIGNED' : state.marketBias['60'] === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
                    vwapDistance: (oteData.events.includes('VWAP_Premium') || oteData.events.includes('VWAP_Discount')) ? 1 : 0,
                    tf: oteData.tf
                }).catch(() => 'ERR');
            }

            // 🧠 REGISTRO EN ACTIVE TRADES SI ES ENTRADA DIRECTA (isChochEntry: true)
            let activeTrade = store.activeTrades.get(oteData.tradeId);
            if (!activeTrade) {
                activeTrade = {
                    tradeId: oteData.tradeId,
                    ticker,
                    direction: oteData.direction as 'BUY' | 'SELL',
                    entryPrice: oteData.entryPrice,
                    tp1Price: parseFloat(oteData.tp1),
                    tp2Price: oteData.tp2 && oteData.tp2 !== 'Buscando DOL macro...'
                        ? (oteData.executionTargetsChecked ? parseFloat(oteData.tp2) : capTp2Price(ticker, oteData.direction as 'BUY' | 'SELL', oteData.entryPrice, parseFloat(oteData.stopLoss), parseFloat(oteData.tp2)))
                        : oteData.entryPrice * 1.5,
                    slPrice: parseFloat(oteData.stopLoss),
                    initialSlPrice: parseFloat(oteData.stopLoss), // 🛡️ SL estructural original (el PnL R se calcula contra este, no contra el SL vigente)
                    tp1Hit: false,
                    tp2Hit: false,
                    slHalfwayHit: false,
                    score: oteData.points || 0,
                    timestamp: nowMs, isBacktest: isBacktest
                };
                // 🆕 Congelar genes de gestión del gatillo en el trade (Firestore-safe: solo si existen)
                const oteMgmt = (oteData as any).mgmtOverrides;
                if (oteMgmt) activeTrade.mgmtOverrides = oteMgmt;
                store.activeTrades.set(oteData.tradeId, activeTrade);
                if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).set(activeTrade).catch(() => { });
                console.log(`[SNIPER] 💾 Registrado trade activo DIRECTO para ${ticker} #${oteData.tradeId}`);
            }

            if (mlRegimeShadow !== undefined) {
                activeTrade.mlRegimeShadow = mlRegimeShadow;
                if (db && !isBacktest) void db.collection('active_trades').doc(oteData.tradeId).update({ mlRegimeShadow })
                    .catch((e: any) => console.warn('[ML-REGIME-SHADOW] Active telemetry not persisted:', e?.message));
            }
            if (journalId && journalId !== 'ERR' && journalId !== 'N/A') {
                activeTrade.journalId = journalId;
                if (mlRegimeShadow !== undefined && db && !isBacktest) void db.collection('trade_journal').doc(journalId).update({ mlRegimeShadow })
                    .catch((e: any) => console.warn('[ML-REGIME-SHADOW] Journal telemetry not persisted:', e?.message));
                // 💾 Actualizar el journalId en Firebase
                if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).update({ journalId }).catch(() => { });
            }

            // 🤖 cTrader: Send trade with confirmation buttons (semi-automatic mode)
            if (!isBacktest) {
                let autoExecutionAttempted = false;
                let autoExecutionResult: import('../services/ctrader.js').CTraderOrderResult | null | undefined;
                try {
                    const { config: globalConfig } = await import('../config.js');
                    const { sendTradeConfirmation } = await import('../services/ctrader_confirmation.js');
                    const ctraderConfigured = !!(globalConfig.CTRADER_CLIENT_ID && globalConfig.CTRADER_ACCESS_TOKEN);

                    if (ctraderConfigured) {
                        const recheckKillswitchesBeforeExecution = async (): Promise<string | null> => {
                            const blocked = await recheckLiveExecutionRisk(ticker);
                            if (blocked === 'BLOCKED_ROLLOVER') {
                                console.log(`[ROLLOVER-C] Entry ${ticker} blocked: broker calendar / fresh normalized spread evidence.`);
                                logBlockedSignal('ROLLOVER', oteData, nowMs);
                            }
                            return blocked;
                        };

                        const blockedBy = await recheckKillswitchesBeforeExecution();
                        if (blockedBy) {
                            console.log(`[KILLSWITCH] ⛔ TOCTOU Prevención: Ejecución bloqueada por ${blockedBy} para ${ticker}`);
                            if (state.lastGatillo) state.lastGatillo.status = blockedBy;
                            safeSet(state).catch(() => { });
                            store.activeTrades.delete(oteData.tradeId);
                            if (db && !isBacktest) {
                                db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                                // 🛡️ FIX 24-sep-2026: marcar el journal como ABORTED/SKIP (igual que
                                // el path de error de ejecución). Antes el doc quedaba SIN_STATUS
                                // para siempre (medido: K4OKQO y L7BVX2, bloqueadas por rollover).
                                if (journalId && journalId !== 'ERR' && journalId !== 'N/A') {
                                    db.collection('trade_journal').doc(journalId).update({
                                        result: 'SKIP',
                                        ctraderStatus: 'ABORTED',
                                        skipReason: `Ejecución bloqueada por killswitch (${blockedBy}) antes de llegar al broker.`,
                                    }).catch(() => { });
                                }
                            }
                            return;
                        }

                        if (store.dynamicBotConfig.autoTrading) {
                            // 🚀 MODO AUTOMÁTICO: Ejecutar directamente
                            const { executeMarketOrder } = await import('../services/ctrader.js');
                            const { config: envConfig } = await import('../config.js');
                            console.log(`[SNIPER] 🤖 Modo AUTO activado. Ejecutando ${ticker} inmediatamente...`);

                            const rolloverFillPolicy = structuredClone(getConfigForTicker(ticker,Date.now()).rolloverPolicy);
                            const requestedRiskPercent = envConfig.CTRADER_RISK_PERCENT * (oteData.riskMult ?? 1) * getSessionSizingFactor(getCurrentSession(Date.now()));
                            (activeTrade as any).requestedRiskPercent = requestedRiskPercent;
                            autoExecutionAttempted = true;
                            const result = autoExecutionResult = await executeMarketOrder({
                                ticker,
                                direction: oteData.direction as 'BUY' | 'SELL',
                                entryPrice: oteData.entryPrice,
                                slPrice: parseFloat(oteData.stopLoss),
                                tp1Price: parseFloat(oteData.tp1),
                                tp2Price: oteData.tp2 !== 'Buscando DOL macro...' && oteData.tp2
                        ? (oteData.executionTargetsChecked ? parseFloat(oteData.tp2) : capTp2Price(ticker, oteData.direction as 'BUY' | 'SELL', oteData.entryPrice, parseFloat(oteData.stopLoss), parseFloat(oteData.tp2)))
                        : undefined,
                                tradeId: oteData.tradeId,
                                beforeExecution: recheckKillswitchesBeforeExecution,
                                rolloverEntryBlock: getConfigForTicker(ticker, Date.now()).rolloverEntryBlock !== false,
                                riskPercent: requestedRiskPercent, // Requested budget is audit context, never the actual filled denominator.
                            });

                            if (result?.success && result.positionId) {
                                const executionFillAckMs = Date.now();
                                const executionFillAckQuote = getLastBidAsk(ticker, executionFillAckMs);
                                try {
                                    await updateTradePositionId(oteData.tradeId, result.positionId, result.riskSnapshot);
                                    const riskTrade = store.activeTrades.get(oteData.tradeId);
                                    const frozenRisk = riskTrade?.riskAccountingStatus === 'VERIFIED' ? riskTrade.riskSnapshot : undefined;
                                    const budgetFields = {
                                        ...(Number.isFinite(result.riskBudgetAccount) ? { riskBudgetAccount: result.riskBudgetAccount } : {}),
                                        ...(Number.isFinite((riskTrade as any)?.requestedRiskPercent) ? { requestedRiskPercent: (riskTrade as any).requestedRiskPercent } : {}),
                                    };
                                    if (riskTrade) Object.assign(riskTrade, budgetFields);
                                    if (db && Object.keys(budgetFields).length) await db.collection('active_trades').doc(oteData.tradeId).update(budgetFields);
                                    if (db && journalId && !isBacktest) await db.collection('trade_journal').doc(journalId).update({
                                        ctraderPositionId: result.positionId, ctraderLots: result.lots,
                                        ctraderExecutedPrice: result.executedPrice, entryPrice: result.executedPrice,
                                        ctraderStatus: 'EXECUTED', ctraderDemo: globalConfig.CTRADER_DEMO, ...budgetFields,
                                        riskAccountingStatus: riskTrade?.riskAccountingStatus ?? 'UNVERIFIED',
                                        ...(frozenRisk ? { riskSnapshot: frozenRisk, accountCurrency: frozenRisk.currency } : {}),
                                    });
                                } catch (error: any) {
                                    // Broker has filled: install RAM safety before any best-effort durable retry.
                                    await retainExecutionIncident(oteData.tradeId, journalId, result);
                                    console.error(`[SNIPER] EXECUTED posID ${result.positionId}; accounting persistence pending: ${error.message}`);
                                    await sendTelegramAlert(`⚠️ ${ticker} ejecutado en cTrader (posID ${result.positionId}); persistencia de riesgo pendiente.`).catch(() => {});
                                    return;
                                }
                                if (sarPendingClose) {
                                    const alreadyPending = (sarPendingClose as any).closeAccountingPending;
                                    (sarPendingClose as any).closeAccountingPending = true;
                                    invalidateRiskCache();
                                    try {
                                        if (sarPendingClose.ctraderPositionId && !alreadyPending) {
                                            const ctrader = await import('../services/ctrader.js');
                                            await ctrader.closePosition(sarPendingClose.ctraderPositionId);
                                        }
                                    } catch (e) {
                                        console.error('[SAR] Cierre incierto; se verifican deals antes de retirar gestión:', e);
                                    }
                                    const sarAccountingReady = await completeLiveTradeClose(sarPendingClose, store, { reversalClosed: true, reconciled: true });
                                    if (sarAccountingReady) console.log(`[SAR] ✅ #${sarPendingClose.tradeId}: contabilidad real durable.`);
                                }

                                // 🛡️ FIX (30-sep-2026): normalizar niveles del activeTrade con los del
                                // OTE EJECUTADO. El trade pudo haber sido pre-creado por el radar con
                                // otros niveles (caso real USOIL 30-sep: activeTrade entry 94.3346 vs
                                // fill real 93.3, TP2 99.53 vs 98.23 del broker) → el gestor interno
                                // operaba contra niveles que el broker no tenía.
                                const exTrade = store.activeTrades.get(oteData.tradeId);
                                if (exTrade && !exTrade.isBacktest) {
                                    if (executionPolicy.profile === 'microstructure_v1') {
                                        const filledAtMs = executionFillAckMs;
                                        const q = executionFillAckQuote;
                                        const frozen = freezeExecutionFill(exTrade, { policy: executionPolicy, instrument: executionInstrument,
                                            executedPrice: result.executedPrice, filledAtMs, lots: result.lots,
                                            quote: q ? { bid: q.bid, ask: q.ask, timestampMs: q.ts, source: 'broker' } : undefined });
                                        if (frozen) exTrade.mgmtOverrides = JSON.parse(JSON.stringify({
                                            partialClosePct: exTrade.mgmtOverrides?.partialClosePct ?? config.partialClosePct ?? .5,
                                            slAfterTp1: exTrade.mgmtOverrides?.slAfterTp1 ?? config.slAfterTp1 ?? 'midpoint',
                                            tp15BeEnabled: exTrade.mgmtOverrides?.tp15BeEnabled ?? config.tp15BeEnabled ?? true,
                                            atrTrailEnabled: exTrade.mgmtOverrides?.atrTrailEnabled ?? config.atrTrailEnabled ?? true,
                                            structuralTrailEnabled: exTrade.mgmtOverrides?.structuralTrailEnabled ?? config.structuralTrailEnabled ?? false,
                                            minimal_roi: exTrade.mgmtOverrides?.minimal_roi ?? config.minimal_roi ?? {},
                                        }));
                                        (exTrade as any).executionFillUnverified = !frozen;
                                        (exTrade as any).executionTf = oteData.executionTf ?? (oteData.tf === '5M' ? '5' : oteData.tf === '15M' ? '15' : oteData.tf);
                                        if (db && frozen) {
                                            const fields = JSON.parse(JSON.stringify({ executionPolicy: exTrade.executionPolicy, executionInstrument: exTrade.executionInstrument,
                                                executionState: exTrade.executionState, executionLots: result.lots, initialSlPrice: exTrade.initialSlPrice,
                                                executionTf: (exTrade as any).executionTf, mgmtOverrides: exTrade.mgmtOverrides, entryPrice: result.executedPrice }));
                                            if (journalId) await db.collection('trade_journal').doc(journalId).update(fields);
                                            await db.collection('active_trades').doc(oteData.tradeId).update(fields);
                                        }
                                    }
                                    exTrade.entryPrice = Number(result.executedPrice) || Number(exTrade.entryPrice);
                                    // updateTradePositionId normalized the verified opening stop before SAR; never undo broker/trailing protection here.
                                    // initialSlPrice is immutable; do not rewrite it after execution.
                                    exTrade.tp1Price = parseFloat(oteData.tp1);
                                    exTrade.tp2Price = oteData.tp2 && oteData.tp2 !== 'Buscando DOL macro...'
                                        ? (oteData.executionTargetsChecked ? parseFloat(oteData.tp2) : capTp2Price(ticker, oteData.direction as 'BUY' | 'SELL', oteData.entryPrice, parseFloat(oteData.stopLoss), parseFloat(oteData.tp2)))
                                        : exTrade.tp2Price;
                                    store.activeTrades.set(oteData.tradeId, exTrade);
                                    if (rolloverFillPolicy?.profile === 'rollover_triage_v1') {
                                        // Only this acknowledged NEW fill can establish immutable rollover R/policy.
                                        // Scoped broker lookup maps the actual symbol; no requested SL/entry fallback.
                                        try {
                                            const positions = await rolloverBroker.getOpenPositions(ticker);
                                            const matches = Array.isArray(positions) ? positions.filter(p => String(p.positionId) === result.positionId) : [];
                                            if (matches.length === 1 && captureRolloverVerifiedFill(exTrade,matches[0],rolloverFillPolicy,Date.now())) {
                                                exTrade.journalId = journalId;
                                                exTrade.rolloverTriageState = {pending:null,widenReference:null};
                                                exTrade.rolloverTriageTracked = true;
                                                rolloverTriageRecords.set(oteData.tradeId,exTrade);
                                                await persistLiveRolloverRecord(oteData.tradeId,exTrade,undefined,'FILL');
                                            }
                                        } catch (error: any) {
                                            exTrade.rolloverTriageDurable = false;
                                            console.error('[ROLLOVER] Fill capture/storage unavailable; triage held:',error.message);
                                        }
                                    } else if (db) await db.collection('active_trades').doc(oteData.tradeId).set(exTrade);
                                    console.log(`[SNIPER] 🔄 Niveles del trade ${oteData.tradeId} normalizados al OTE ejecutado (entry ${result.executedPrice}, SL ${exTrade.slPrice}, TP1 ${exTrade.tp1Price}, TP2 ${exTrade.tp2Price}).`);
                                }
                                const successMsg = `🚀 <b>AUTO-EJECUCIÓN EXITOSA</b>\n\n${msg}\n\n✅ <b>Ejecutado a:</b> ${result.executedPrice}\n🆔 <b>posID:</b> ${result.positionId}`;
                                await sendTelegramAlert(successMsg);
                            } else if (await retainExecutionIncident(oteData.tradeId, journalId, result)) {
                                await sendTelegramAlert(`⚠️ ${ticker}: ejecución pendiente de reconciliación${result?.positionId ? ` (posID ${result.positionId})` : ''}. Sin reintento; nuevas entradas retenidas.`).catch(() => {});
                            } else {
                                const notice = buildExecutionNotice(result.error, 'AUTO');
                                const errorMsg = `${notice.headingHtml}\n\n${msg}\n\n${notice.reasonHtml}`;
                                await sendTelegramAlert(errorMsg);
                                // 🛡️ FIX: la orden NO se ejecutó en cTrader (abortada por guardrail de volumen,
                                // rechazo, etc). El trade ya quedó registrado en active_trades + journal ANTES
                                // de intentar la ejecución. Hay que LIMPIARLO para que no quede como posición
                                // "viva" que luego el gestor marca LOSS (y dispara el killswitch) por un
                                // trade que nunca existió en cTrader.
                                store.activeTrades.delete(oteData.tradeId);
                                if (db && !isBacktest) {
                                    db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
                                    if (journalId && journalId !== 'ERR' && journalId !== 'N/A') {
                                        db.collection('trade_journal').doc(journalId).update({
                                            result: 'SKIP',
                                            ctraderStatus: 'ABORTED',
                                            skipReason: `Ejecución abortada en cTrader: ${result.error}`,
                                            ctraderError: result.error ?? null,
                                        }).catch(() => { });
                                    }
                                }
                                console.log(`[SNIPER] 🧹 Trade ${oteData.tradeId} abortado limpiado de active_trades y marcado SKIP en journal.`);
                            }
                        } else {
                            // ⏸️ MODO SEMI-AUTOMÁTICO: Enviar alerta WITH cTrader execution buttons
                            await sendTradeConfirmation({
                                tradeId: oteData.tradeId,
                                ticker,
                                direction: oteData.direction as 'BUY' | 'SELL',
                                dirText: oteData.dirText,
                                entryPrice: oteData.entryPrice,
                                slPrice: parseFloat(oteData.stopLoss),
                                tp1Price: parseFloat(oteData.tp1),
                                tp2Price: oteData.tp2 !== 'Buscando DOL macro...' && oteData.tp2
                        ? (oteData.executionTargetsChecked ? parseFloat(oteData.tp2) : capTp2Price(ticker, oteData.direction as 'BUY' | 'SELL', oteData.entryPrice, parseFloat(oteData.stopLoss), parseFloat(oteData.tp2)))
                        : undefined,
                                points: oteData.points,
                                grade: oteData.points >= 8 ? 'A+' : 'B',
                                events: oteData.events || [],
                                confluenceReport: oteData.confluenceReport || '',
                                kronosVerdict: kronosVerdict,
                                alertMessage: msg,
                                journalId: typeof journalId === 'string' ? journalId : undefined,
                                isChochEntry: oteData.isChochEntry,
                                sarPendingClose,
                                riskMult: oteData.riskMult ?? 1, // 🆕 TimesFM F1
                            });
                            console.log(`[SNIPER] ✅ Alerta FRANCOTIRADOR + botones cTrader enviada para ${ticker}`);
                        }
                    } else {
                        // cTrader not configured — send normal alert (original behavior)
                        await sendTelegramAlert(msg);
                        console.log(`[SNIPER] ✅ Alerta FRANCOTIRADOR enviada (sin cTrader) para ${ticker}`);
                    }
                } catch (teleErr: any) {
                    if (autoExecutionAttempted) await retainExecutionIncident(oteData.tradeId, journalId, autoExecutionResult);
                    // Fallback to normal alert if confirmation system fails
                    console.error(`[SNIPER] ⚠️ Error en sistema de confirmación, enviando alerta normal:`, teleErr.message);
                    try { await sendTelegramAlert(msg); } catch { }
                }
            } else {
                console.log(`[SNIPER] ⏭️ Modo backtest — alerta FRANCOTIRADOR NO enviada a Telegram`);
            }

            state.lastGatillo.status = 'ENVIADO';
            safeSet(state).catch(() => { });
        } else {
            console.log(`[SNIPER] ⚠️ DUPLICADO bloqueado: ${fingerprint}`);
            state.lastGatillo.status = 'DUPLICADO';
            safeSet(state).catch(() => { });

            // Limpiar si se pre-creó en evaluateImpulse (para OTE)
            store.activeTrades.delete(oteData.tradeId);
            if (db && !isBacktest) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => { });
        }
    }

}