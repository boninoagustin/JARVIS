/**
 * PropFirmGuard.ts — Escudo duro monetario a nivel cuenta (Funding Pips / Prop Firm).
 *
 * Complementa a PortfolioModel.ts (que opera sobre trades CERRADOS en unidades R) con
 * límites monetarios reales e inviolables sobre el equity/balance vivo del broker:
 *   1. Daily Loss Limit (Funding Pips = 5% desde max(balance, equity) a las 17:00 NY).
 *   2. Max Overall Drawdown (Funding Pips = 8% / 10% estático desde el balance inicial).
 *   3. Worst-Case Open + New SL Check: impide abrir una posición si el SL combinado de
 *      las posiciones abiertas actuales + el presupuesto de la nueva orden perforaría
 *      el colchón diario o total de la cuenta.
 *   4. Emergency Equity Shield: si con posiciones abiertas el equity vivo perfora el
 *      umbral de emergencia (ej. 4.5% diario / 7.5% total), ordena liquidación total
 *      inmediata antes de alcanzar el hard breach del broker (5.0% / 8.0%).
 *
 * Módulo 100% puro y sin efectos secundarios.
 */

export interface PropFirmLimits {
    enabled: boolean;
    /** Regla dura del broker (Funding Pips = 5%). Informativa + referencia de validación. */
    maxDailyLossPct: number;
    /** Corte de ADMISIÓN de nuevas entradas por pérdida diaria actual (default 4.0%). */
    dailyEntryStopPct: number;
    /** Techo de peor escenario diario si TODAS las abiertas + la nueva tocan SL (default 4.5%). */
    maxWorstCaseDailyPct: number;
    /** Umbral de cierre de emergencia de posiciones abiertas antes del 5% diario (default 4.5%). */
    emergencyCloseDailyPct: number;
    /** Regla dura de drawdown total estático sobre balance inicial (default 8.0%). */
    maxTotalDrawdownPct: number;
    /** Corte de ADMISIÓN de nuevas entradas por drawdown total actual (default 7.0%). */
    totalEntryStopPct: number;
    /** Techo de peor escenario total si TODAS las abiertas + la nueva tocan SL (default 7.5%). */
    maxWorstCaseTotalPct: number;
    /** Umbral de cierre de emergencia antes del max drawdown total (default 7.5%). */
    emergencyCloseTotalPct: number;
    /** Balance inicial explícito de la cuenta (opcional; si > 0 prevalece sobre inferencia). */
    configuredInitialBalance?: number;
}

export interface PropFirmAnchor {
    fxDayStartMs: number;
    dayStartBalance: number;
    dayStartEquity: number;
    /** Regla Funding Pips: el límite diario se mide desde max(balance_reset, equity_reset). */
    dayStartReference: number;
    initialBalance: number;
    peakBalance: number;
    currency: string;
    updatedAt: number;
}

export interface PropFirmGateMetrics {
    dailyDrawdownPct: number;
    totalDrawdownPct: number;
    worstCaseDailyPct: number;
    worstCaseTotalPct: number;
    dayStartReference: number;
    initialBalance: number;
    liveEquity: number;
    openRemainingRiskAccount: number;
    newRiskBudgetAccount: number;
}

export interface PropFirmEntryVerdict {
    allowed: boolean;
    reason: string | null;
    metrics: PropFirmGateMetrics;
}

export interface PropFirmEmergencyVerdict {
    triggerEmergencyClose: boolean;
    reason: string | null;
    dailyDrawdownPct: number;
    totalDrawdownPct: number;
}

const STANDARD_PROP_TIERS = [5_000, 10_000, 25_000, 50_000, 100_000, 200_000];

function finitePos(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolvePropFirmLimits(env: Record<string, unknown> = process.env): PropFirmLimits {
    const rawEnabled = String(env.PROPFIRM_GUARD_ENABLED ?? 'true').trim().toLowerCase();
    const enabled = rawEnabled !== 'false' && rawEnabled !== '0' && rawEnabled !== 'off';
    const maxDailyLossPct = finitePos(env.PROPFIRM_MAX_DAILY_LOSS_PCT, 5.0);
    const dailyEntryStopPct = Math.min(maxDailyLossPct - 0.2, finitePos(env.PROPFIRM_DAILY_ENTRY_STOP_PCT, 4.0));
    const maxWorstCaseDailyPct = Math.min(maxDailyLossPct - 0.2, finitePos(env.PROPFIRM_MAX_WORST_CASE_DAILY_PCT, 4.5));
    const emergencyCloseDailyPct = Math.min(maxDailyLossPct - 0.1, finitePos(env.PROPFIRM_EMERGENCY_CLOSE_DAILY_PCT, 4.5));

    const maxTotalDrawdownPct = finitePos(env.PROPFIRM_MAX_TOTAL_DRAWDOWN_PCT, 8.0);
    const totalEntryStopPct = Math.min(maxTotalDrawdownPct - 0.5, finitePos(env.PROPFIRM_TOTAL_ENTRY_STOP_PCT, 7.0));
    const maxWorstCaseTotalPct = Math.min(maxTotalDrawdownPct - 0.2, finitePos(env.PROPFIRM_MAX_WORST_CASE_TOTAL_PCT, 7.5));
    const emergencyCloseTotalPct = Math.min(maxTotalDrawdownPct - 0.1, finitePos(env.PROPFIRM_EMERGENCY_CLOSE_TOTAL_PCT, 7.5));

    const cfgInit = Number(env.PROPFIRM_INITIAL_BALANCE);
    return {
        enabled,
        maxDailyLossPct,
        dailyEntryStopPct,
        maxWorstCaseDailyPct,
        emergencyCloseDailyPct,
        maxTotalDrawdownPct,
        totalEntryStopPct,
        maxWorstCaseTotalPct,
        emergencyCloseTotalPct,
        ...(Number.isFinite(cfgInit) && cfgInit > 0 ? { configuredInitialBalance: cfgInit } : {}),
    };
}

/**
 * Si no se configuró PROPFIRM_INITIAL_BALANCE en .env ni existía persistido,
 * infiere el escalón estándar de Funding Pips cuando el balance está en [-8%, +15%]
 * de un tamaño de cuenta estándar (ej. $5,108.79 -> $5,000); de lo contrario usa el balance actual.
 */
export function inferStandardPropAccountSize(balance: number): number {
    if (!Number.isFinite(balance) || balance <= 0) return 0;
    for (const tier of STANDARD_PROP_TIERS) {
        if (balance >= tier * 0.92 && balance <= tier * 1.15) {
            return tier;
        }
    }
    return balance;
}

export function updatePropFirmAnchorState(
    prev: Partial<PropFirmAnchor> | null | undefined,
    sample: {
        balance: number;
        equity: number;
        currency: string;
        nowMs: number;
        /** Si el bot arrancó a mitad del día FX y ya hubo cierres hoy, balance - netRealizedToday reconstruye la apertura. */
        reconstructedDayStartBalance?: number | null;
    },
    fxDayStartMs: number,
    configuredInitialBalance?: number,
): PropFirmAnchor | null {
    const { balance, equity, currency, nowMs } = sample;
    if (!Number.isFinite(balance) || balance <= 0 || !Number.isFinite(equity) || equity <= 0 || !currency || !Number.isFinite(fxDayStartMs)) {
        return null;
    }
    const sameCurrency = prev?.currency === currency;
    const prevInitial = sameCurrency && Number.isFinite(prev?.initialBalance) && (prev!.initialBalance as number) > 0
        ? (prev!.initialBalance as number)
        : 0;
    const initialBalance = (configuredInitialBalance && configuredInitialBalance > 0)
        ? configuredInitialBalance
        : (prevInitial > 0 ? prevInitial : inferStandardPropAccountSize(balance));

    const prevPeak = sameCurrency && Number.isFinite(prev?.peakBalance) && (prev!.peakBalance as number) > 0
        ? (prev!.peakBalance as number)
        : initialBalance;
    const peakBalance = Math.max(prevPeak, balance, initialBalance);

    const sameDay = sameCurrency && prev?.fxDayStartMs === fxDayStartMs
        && Number.isFinite(prev?.dayStartReference) && (prev!.dayStartReference as number) > 0;

    const recon = Number(sample.reconstructedDayStartBalance);
    const hasRecon = Number.isFinite(recon) && recon > 0;

    if (sameDay) {
        const dayStartBalance = hasRecon
            ? Math.max(prev!.dayStartBalance ?? balance, recon)
            : (prev!.dayStartBalance ?? balance);
        const dayStartEquity = prev!.dayStartEquity ?? equity;
        const dayStartReference = Math.max(prev!.dayStartReference!, dayStartBalance, dayStartEquity);
        return {
            fxDayStartMs,
            dayStartBalance,
            dayStartEquity,
            dayStartReference,
            initialBalance,
            peakBalance,
            currency,
            updatedAt: nowMs,
        };
    }

    const dayStartBalance = hasRecon ? recon : balance;
    const dayStartEquity = hasRecon ? Math.max(equity, recon) : equity;
    const dayStartReference = Math.max(dayStartBalance, dayStartEquity);
    return {
        fxDayStartMs,
        dayStartBalance,
        dayStartEquity,
        dayStartReference,
        initialBalance,
        peakBalance,
        currency,
        updatedAt: nowMs,
    };
}

/**
 * Estima el riesgo monetario restante (en moneda de cuenta) de las posiciones abiertas
 * si todas tocaran su SL vigente en este instante:
 * - Si el SL ya está del lado ganador o en breakeven (BUY: sl >= entry, SELL: sl <= entry),
 *   el riesgo estructural de precio es 0.
 * - Si tiene riskSnapshot congelado, escala por (distancia actual al SL / distancia inicial al SL)
 *   y por la fracción restante tras parcial TP1.
 * - Si es adoptada/legacy sin riskSnapshot, usa requestedRiskPercent o fallbackRiskPct sobre liveEquity.
 */
export function computeOpenPositionRemainingRiskAccount(
    entries: Iterable<[string, Record<string, any>]>,
    liveEquity: number,
    fallbackRiskFor: (ticker: string) => number,
    excludeTradeId?: string,
): number {
    if (!Number.isFinite(liveEquity) || liveEquity <= 0) return 0;
    let totalAccountRisk = 0;
    for (const [tid, tr] of entries) {
        if (tid === excludeTradeId || !tr || tr.isBacktest) continue;
        const hasPosition = tr.ctraderPositionId != null;
        const reqPct = Number(tr.requestedRiskPercent);
        if (!hasPosition && !(Number.isFinite(reqPct) && reqPct > 0)) continue;

        const dir = tr.direction === 'BUY' ? 1 : tr.direction === 'SELL' ? -1 : 0;
        const entry = Number(tr.entryPrice);
        const curSl = Number(tr.slPrice);
        if (dir !== 0 && Number.isFinite(entry) && entry > 0 && Number.isFinite(curSl) && curSl > 0) {
            const lockedOrBe = dir === 1 ? curSl >= entry : curSl <= entry;
            if (lockedOrBe) continue;
        }

        const snap = tr.riskSnapshot;
        const initRiskAccount = Number(snap?.riskAmountAccount ?? tr.riskAmountAccount);
        const initEntry = Number(snap?.entryPrice ?? entry);
        const initSl = Number(snap?.initialSlPrice ?? tr.initialSlPrice ?? tr.originalSlPrice);
        const partialRatio = tr.tp1Hit && Number.isFinite(Number(tr.tp1PartialPct)) && Number(tr.tp1PartialPct) > 0 && Number(tr.tp1PartialPct) < 1
            ? (1 - Number(tr.tp1PartialPct))
            : (tr.tp1Hit ? 0.5 : 1.0);

        if (Number.isFinite(initRiskAccount) && initRiskAccount > 0 && Number.isFinite(initEntry) && Number.isFinite(initSl)) {
            const initDist = Math.abs(initEntry - initSl);
            const curDist = Number.isFinite(curSl) && curSl > 0 ? Math.abs(initEntry - curSl) : initDist;
            const distScale = initDist > 0 ? Math.min(2.0, Math.max(0, curDist / initDist)) : 1.0;
            totalAccountRisk += initRiskAccount * distScale * partialRatio;
            continue;
        }

        const pct = Number.isFinite(reqPct) && reqPct > 0 ? Math.min(reqPct, 3) : Math.min(Math.max(0, fallbackRiskFor(String(tr.ticker ?? ''))), 3);
        totalAccountRisk += liveEquity * (pct / 100) * partialRatio;
    }
    return totalAccountRisk;
}

export function evaluatePropFirmEntryGate(input: {
    anchor: PropFirmAnchor;
    liveBalance: number;
    liveEquity: number;
    newRiskBudgetAccount: number;
    openRemainingRiskAccount: number;
    limits: PropFirmLimits;
}): PropFirmEntryVerdict {
    const { anchor, liveEquity, newRiskBudgetAccount, openRemainingRiskAccount, limits } = input;
    const dayRef = anchor.dayStartReference;
    const initRef = anchor.initialBalance;
    const safeNew = Math.max(0, Number.isFinite(newRiskBudgetAccount) ? newRiskBudgetAccount : 0);
    const safeOpen = Math.max(0, Number.isFinite(openRemainingRiskAccount) ? openRemainingRiskAccount : 0);

    const dailyDrawdownPct = dayRef > 0 ? Math.max(0, ((dayRef - liveEquity) / dayRef) * 100) : 0;
    const totalDrawdownPct = initRef > 0 ? Math.max(0, ((initRef - liveEquity) / initRef) * 100) : 0;

    const worstEquity = liveEquity - safeOpen - safeNew;
    const worstCaseDailyPct = dayRef > 0 ? Math.max(0, ((dayRef - worstEquity) / dayRef) * 100) : 0;
    const worstCaseTotalPct = initRef > 0 ? Math.max(0, ((initRef - worstEquity) / initRef) * 100) : 0;

    const metrics: PropFirmGateMetrics = {
        dailyDrawdownPct,
        totalDrawdownPct,
        worstCaseDailyPct,
        worstCaseTotalPct,
        dayStartReference: dayRef,
        initialBalance: initRef,
        liveEquity,
        openRemainingRiskAccount: safeOpen,
        newRiskBudgetAccount: safeNew,
    };

    if (!limits.enabled) return { allowed: true, reason: null, metrics };
    if (!(dayRef > 0 && initRef > 0 && Number.isFinite(liveEquity) && liveEquity > 0)) {
        return { allowed: false, reason: 'BLOCKED_PROPFIRM_STATE_INVALID', metrics };
    }
    if (dailyDrawdownPct >= limits.dailyEntryStopPct - 1e-9) {
        return {
            allowed: false,
            reason: `BLOCKED_PROPFIRM_DAILY_DD (${dailyDrawdownPct.toFixed(2)}% >= ${limits.dailyEntryStopPct.toFixed(2)}% | ref=${dayRef.toFixed(2)})`,
            metrics,
        };
    }
    if (totalDrawdownPct >= limits.totalEntryStopPct - 1e-9) {
        return {
            allowed: false,
            reason: `BLOCKED_PROPFIRM_TOTAL_DD (${totalDrawdownPct.toFixed(2)}% >= ${limits.totalEntryStopPct.toFixed(2)}% | init=${initRef.toFixed(2)})`,
            metrics,
        };
    }
    if (worstCaseDailyPct > limits.maxWorstCaseDailyPct + 1e-9) {
        return {
            allowed: false,
            reason: `BLOCKED_PROPFIRM_WORST_CASE_DAILY (peor caso ${worstCaseDailyPct.toFixed(2)}% > tope ${limits.maxWorstCaseDailyPct.toFixed(2)}% antes del ${limits.maxDailyLossPct}% diario)`,
            metrics,
        };
    }
    if (worstCaseTotalPct > limits.maxWorstCaseTotalPct + 1e-9) {
        return {
            allowed: false,
            reason: `BLOCKED_PROPFIRM_WORST_CASE_TOTAL (peor caso ${worstCaseTotalPct.toFixed(2)}% > tope ${limits.maxWorstCaseTotalPct.toFixed(2)}% antes del ${limits.maxTotalDrawdownPct}% total)`,
            metrics,
        };
    }
    return { allowed: true, reason: null, metrics };
}

export function evaluatePropFirmEmergencyKill(input: {
    anchor: PropFirmAnchor;
    liveBalance: number;
    liveEquity: number;
    openPositions: number;
    limits: PropFirmLimits;
}): PropFirmEmergencyVerdict {
    const { anchor, liveEquity, openPositions, limits } = input;
    const dayRef = anchor.dayStartReference;
    const initRef = anchor.initialBalance;
    const dailyDrawdownPct = dayRef > 0 ? Math.max(0, ((dayRef - liveEquity) / dayRef) * 100) : 0;
    const totalDrawdownPct = initRef > 0 ? Math.max(0, ((initRef - liveEquity) / initRef) * 100) : 0;

    if (!limits.enabled || !(openPositions > 0) || !(dayRef > 0 && initRef > 0 && Number.isFinite(liveEquity) && liveEquity > 0)) {
        return { triggerEmergencyClose: false, reason: null, dailyDrawdownPct, totalDrawdownPct };
    }
    if (dailyDrawdownPct >= limits.emergencyCloseDailyPct - 1e-9) {
        return {
            triggerEmergencyClose: true,
            reason: `EMERGENCY_DAILY_DRAWDOWN (${dailyDrawdownPct.toFixed(2)}% >= ${limits.emergencyCloseDailyPct.toFixed(2)}% | equity=${liveEquity.toFixed(2)} vs apertura=${dayRef.toFixed(2)})`,
            dailyDrawdownPct,
            totalDrawdownPct,
        };
    }
    if (totalDrawdownPct >= limits.emergencyCloseTotalPct - 1e-9) {
        return {
            triggerEmergencyClose: true,
            reason: `EMERGENCY_TOTAL_DRAWDOWN (${totalDrawdownPct.toFixed(2)}% >= ${limits.emergencyCloseTotalPct.toFixed(2)}% | equity=${liveEquity.toFixed(2)} vs inicial=${initRef.toFixed(2)})`,
            dailyDrawdownPct,
            totalDrawdownPct,
        };
    }
    return { triggerEmergencyClose: false, reason: null, dailyDrawdownPct, totalDrawdownPct };
}
