// accountState.ts — Pusher del estado de cuenta (saldo/equity) a Firestore cada 5 min.
// El panel Diario Analítico lo lee para mostrar el SALDO USD vivo (doc system/account_state).
// sep-2026: requerido para el P&L devengado en USD (neto del período + saldo de cuenta).
import { db } from './memory.js';
import { getAccountInfo, isCTraderReady } from '../services/ctrader.js';

let running = false;
let lastPush = 0;

export async function pushAccountState(force = false): Promise<void> {
    if (!db) return;
    if (!force && Date.now() - lastPush < 60_000) return; // throttle mínimo anti-spam
    if (!isCTraderReady()) {
        if (force) console.log('[ACCOUNT-STATE] ⏸️ cTrader no listo — se reintenta en el próximo ciclo.');
        return; // sin conexión al broker no hay estado real que pushear
    }
    try {
        const info = await getAccountInfo();
        if (!info) {
            console.log('[ACCOUNT-STATE] ⚠️ getAccountInfo devolvió null — se reintenta en el próximo ciclo.');
            return;
        }
        lastPush = Date.now();
        await db.collection('system').doc('account_state').set({
            balance: info.balance,
            equity: info.equity,
            currency: info.currency || 'USD',
            openPositions: info.openPositions ?? 0,
            updatedAt: Date.now(),
        }, { merge: true });
        console.log(`[ACCOUNT-STATE] ✅ saldo $${info.balance} equity $${info.equity} → Firestore.`);
    } catch (e: any) {
        console.warn('[ACCOUNT-STATE] error pusheando estado:', e.message);
    }
}

export function startAccountStatePusher(): void {
    if (running) return;
    running = true;
    pushAccountState(true);
    setInterval(() => pushAccountState(), 5 * 60 * 1000); // cada 5 min (pedido explícito de Bon)
    console.log('[ACCOUNT-STATE] Pusher ACTIVO: saldo/equity a Firestore cada 5 min.');
}
