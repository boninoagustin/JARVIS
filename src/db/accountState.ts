// accountState.ts — Pusher del estado de cuenta (saldo/equity) a Firestore cada 5 min
// + Escudo duro monetario Prop Firm (Funding Pips): ancla diaria 17:00 NY, drawdown inicial,
// gate de admisión monetario y cierre de emergencia cada 15s si hay posiciones abiertas.
import { db } from './memory.js';
import { config } from '../config.js';
import { getAccountInfo, getVerifiedAccountCurrency, isCTraderReady, closeAllPositions } from '../services/ctrader.js';
import { getFxDayStartMs, invalidateRiskCache } from '../engine/PortfolioModel.js';
import {
    resolvePropFirmLimits,
    updatePropFirmAnchorState,
    computeOpenPositionRemainingRiskAccount,
    evaluatePropFirmEntryGate,
    evaluatePropFirmEmergencyKill,
    type PropFirmAnchor,
    type PropFirmEntryVerdict,
} from '../engine/PropFirmGuard.js';

let running = false;
let lastPush = 0;
let cachedAnchor: PropFirmAnchor | null = null;
let cachedAccountSample: { balance: number; equity: number; currency: string; openPositions: number; atMs: number } | null = null;
let anchorHydrated = false;
let emergencyCloseInFlight = false;
let lastEmergencyAlertAt = 0;

async function reconstructTodayStartBalance(fxDayStartMs: number, currentBalance: number, currency: string): Promise<number | null> {
    if (!db) return null;
    try {
        const snap = await db.collection('trade_journal').get();
        if (snap.empty) return null;
        let todayNetPnl = 0;
        let foundAny = false;
        for (const doc of snap.docs) {
            const t = doc.data();
            if (!t || t.mode === 'backtesting' || t.duplicateOf || t.ctraderStatus === 'ABORTED') continue;
            if (!['WIN', 'LOSS', 'BREAKEVEN'].includes(t.result)) continue;
            if (t.accountCurrency && t.accountCurrency !== currency) continue;
            const closedMs = typeof t.closedAt === 'number' ? t.closedAt : (typeof t.closedAt === 'string' ? Date.parse(t.closedAt) : NaN);
            if (!Number.isFinite(closedMs) || closedMs < fxDayStartMs) continue;
            const pnl = Number(t.ctrader_real_pnl);
            if (!Number.isFinite(pnl)) continue;
            todayNetPnl += pnl;
            foundAny = true;
        }
        if (!foundAny) return null;
        const reconstructed = currentBalance - todayNetPnl;
        return Number.isFinite(reconstructed) && reconstructed > 0 ? reconstructed : null;
    } catch {
        return null;
    }
}

async function ensureAnchorHydrated(): Promise<void> {
    if (anchorHydrated || !db) return;
    try {
        const snap = await db.collection('system').doc('account_state').get();
        const data = snap.data();
        if (data?.propFirmAnchor && typeof data.propFirmAnchor === 'object') {
            cachedAnchor = data.propFirmAnchor as PropFirmAnchor;
        } else if (data && Number(data.initialBalance) > 0) {
            cachedAnchor = {
                fxDayStartMs: Number(data.fxDayStartMs) || 0,
                dayStartBalance: Number(data.dayStartBalance) || Number(data.balance) || 0,
                dayStartEquity: Number(data.dayStartEquity) || Number(data.equity) || 0,
                dayStartReference: Number(data.dayStartReference) || Math.max(Number(data.balance) || 0, Number(data.equity) || 0),
                initialBalance: Number(data.initialBalance),
                peakBalance: Number(data.peakBalance) || Number(data.initialBalance),
                currency: String(data.currency || 'USD'),
                updatedAt: Number(data.updatedAt) || 0,
            };
        }
        anchorHydrated = true;
    } catch {
        // se reintenta en la próxima lectura
    }
}

export async function refreshPropFirmState(nowMs = Date.now()): Promise<{
    anchor: PropFirmAnchor;
    balance: number;
    equity: number;
    currency: string;
    openPositions: number;
} | null> {
    if (!isCTraderReady()) return null;
    await ensureAnchorHydrated();
    const info = await getAccountInfo();
    if (!info || !(info.balance > 0) || !(info.equity > 0)) return null;
    const currency = getVerifiedAccountCurrency() ?? info.currency ?? 'USD';
    const fxDayStartMs = getFxDayStartMs(nowMs);
    const limits = resolvePropFirmLimits(process.env);
    const needMidDayReconstruction = !cachedAnchor || cachedAnchor.fxDayStartMs !== fxDayStartMs || cachedAnchor.currency !== currency;
    const reconstructedDayStartBalance = needMidDayReconstruction
        ? await reconstructTodayStartBalance(fxDayStartMs, info.balance, currency)
        : null;

    const nextAnchor = updatePropFirmAnchorState(
        cachedAnchor,
        {
            balance: info.balance,
            equity: info.equity,
            currency,
            nowMs,
            reconstructedDayStartBalance,
        },
        fxDayStartMs,
        limits.configuredInitialBalance,
    );
    if (!nextAnchor) return null;
    cachedAnchor = nextAnchor;
    cachedAccountSample = {
        balance: info.balance,
        equity: info.equity,
        currency,
        openPositions: info.openPositions ?? 0,
        atMs: nowMs,
    };
    return {
        anchor: nextAnchor,
        balance: info.balance,
        equity: info.equity,
        currency,
        openPositions: info.openPositions ?? 0,
    };
}

/**
 * Gate monetario duro pre-ejecución (compartido por AUTO y confirmación manual).
 * Si cTrader no está conectado o PropFirmGuard está deshabilitado, no bloquea acá
 * (la conexión tiene su propio gate en executeMarketOrder).
 */
export async function evaluateLivePropFirmGate(opts: {
    activeTrades: Iterable<[string, Record<string, any>]>;
    fallbackRiskFor: (ticker: string) => number;
    requestedRiskPercent?: number;
    excludeTradeId?: string;
    nowMs?: number;
}): Promise<PropFirmEntryVerdict | null> {
    const limits = resolvePropFirmLimits(process.env);
    if (!limits.enabled || !isCTraderReady()) return null;
    const nowMs = opts.nowMs ?? Date.now();
    const useCached = cachedAnchor && cachedAccountSample
        && cachedAnchor.fxDayStartMs === getFxDayStartMs(nowMs)
        && nowMs >= cachedAccountSample.atMs
        && nowMs - cachedAccountSample.atMs <= 15_000;
    const snap = useCached
        ? { anchor: cachedAnchor!, ...cachedAccountSample! }
        : await refreshPropFirmState(nowMs);
    if (!snap) return null;

    const openRemainingRiskAccount = computeOpenPositionRemainingRiskAccount(
        opts.activeTrades,
        snap.equity,
        opts.fallbackRiskFor,
        opts.excludeTradeId,
    );
    const pct = Number.isFinite(opts.requestedRiskPercent) && (opts.requestedRiskPercent as number) > 0
        ? Math.min(opts.requestedRiskPercent as number, 3)
        : Math.min(config.CTRADER_RISK_PERCENT, 3);
    const newRiskBudgetAccount = snap.equity * (pct / 100);

    return evaluatePropFirmEntryGate({
        anchor: snap.anchor,
        liveBalance: snap.balance,
        liveEquity: snap.equity,
        newRiskBudgetAccount,
        openRemainingRiskAccount,
        limits,
    });
}

async function runEmergencyEquityShield(): Promise<void> {
    if (emergencyCloseInFlight || !isCTraderReady()) return;
    try {
        const { globalState } = await import('./trading.js');
        const hasRamOpen = [...globalState.activeTrades.values()].some((t: any) => !t.isBacktest && t.ctraderPositionId != null);
        const recentOpen = (cachedAccountSample?.openPositions ?? 0) > 0;
        if (!hasRamOpen && !recentOpen) return;

        const snap = await refreshPropFirmState(Date.now());
        if (!snap || snap.openPositions <= 0) return;

        const limits = resolvePropFirmLimits(process.env);
        const verdict = evaluatePropFirmEmergencyKill({
            anchor: snap.anchor,
            liveBalance: snap.balance,
            liveEquity: snap.equity,
            openPositions: snap.openPositions,
            limits,
        });
        if (!verdict.triggerEmergencyClose) return;

        emergencyCloseInFlight = true;
        console.error(`[PROPFIRM-SHIELD] 🚨 ${verdict.reason} → ejecutando closeAllPositions() de emergencia!`);
        const fxDayStart = getFxDayStartMs(Date.now());
        const endOfDayMs = getFxDayStartMs(fxDayStart + 30 * 60 * 60 * 1000) - 1000;
        globalState.globalPortfolioKillswitchUntil = Math.max(globalState.globalPortfolioKillswitchUntil, endOfDayMs);
        invalidateRiskCache();

        const res = await closeAllPositions();
        await pushAccountState(true);

        if (Date.now() - lastEmergencyAlertAt > 60_000) {
            lastEmergencyAlertAt = Date.now();
            try {
                const { bot } = await import('../bot/telegram.js');
                const msg = `🚨 <b>[ESCUDO DURO PROP FIRM ACTIVADO]</b> 🚨\n\n`
                    + `📋 <b>Causa:</b> ${verdict.reason}\n`
                    + `🛑 <b>Posiciones cerradas de emergencia:</b> ${res.closed} OK, ${res.failed} fallidas\n`
                    + `🔒 <b>Nuevas entradas bloqueadas</b> hasta el próximo reset diario (17:00 NY).\n\n`
                    + (res.failed > 0 ? `⚠️ <b>ATENCIÓN:</b> ${res.failed} posición(es) no confirmaron cierre — verificar cTrader manualmente YA.` : `✅ Todas las posiciones verificadas cerradas antes del hard breach del broker.`);
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    await bot.api.sendMessage(userId, msg, { parse_mode: 'HTML' }).catch(() => {});
                }
            } catch (e: any) {
                console.error('[PROPFIRM-SHIELD] Error enviando alerta Telegram:', e?.message);
            }
        }
    } catch (e: any) {
        console.warn('[PROPFIRM-SHIELD] Error en chequeo de emergencia:', e?.message);
    } finally {
        emergencyCloseInFlight = false;
    }
}

export async function pushAccountState(force = false): Promise<void> {
    if (!db) return;
    if (!force && Date.now() - lastPush < 60_000) return; // throttle mínimo anti-spam
    if (!isCTraderReady()) {
        if (force) console.log('[ACCOUNT-STATE] ⏸️ cTrader no listo — se reintenta en el próximo ciclo.');
        return; // sin conexión al broker no hay estado real que pushear
    }
    try {
        const snap = await refreshPropFirmState(Date.now());
        if (!snap) {
            console.log('[ACCOUNT-STATE] ⚠️ getAccountInfo devolvió null — se reintenta en el próximo ciclo.');
            return;
        }
        lastPush = Date.now();
        await db.collection('system').doc('account_state').set({
            balance: snap.balance,
            equity: snap.equity,
            currency: snap.currency || 'USD',
            openPositions: snap.openPositions ?? 0,
            fxDayStartMs: snap.anchor.fxDayStartMs,
            dayStartBalance: snap.anchor.dayStartBalance,
            dayStartEquity: snap.anchor.dayStartEquity,
            dayStartReference: snap.anchor.dayStartReference,
            initialBalance: snap.anchor.initialBalance,
            peakBalance: snap.anchor.peakBalance,
            propFirmAnchor: snap.anchor,
            updatedAt: Date.now(),
        }, { merge: true });
        console.log(`[ACCOUNT-STATE] ✅ saldo $${snap.balance} equity $${snap.equity} (apertura día $${snap.anchor.dayStartReference}, inicial $${snap.anchor.initialBalance}) → Firestore.`);
    } catch (e: any) {
        console.warn('[ACCOUNT-STATE] error pusheando estado:', e.message);
    }
}

export function startAccountStatePusher(): void {
    if (running) return;
    running = true;
    pushAccountState(true);
    setInterval(() => pushAccountState(), 5 * 60 * 1000); // cada 5 min (pedido explícito de Bon)
    setInterval(() => { runEmergencyEquityShield().catch(() => {}); }, 15_000).unref();
    console.log('[ACCOUNT-STATE] Pusher ACTIVO (5 min) + Escudo Prop Firm (15s con posiciones abiertas).');
}
