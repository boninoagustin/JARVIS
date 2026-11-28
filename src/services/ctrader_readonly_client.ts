/**
 * ctrader_readonly_client.ts — Sesión efímera y 100% read-only para scripts CLI
 * (`fetch_history.ts`, `asset_scout.ts`, herramientas de diagnóstico).
 *
 * Evita importar `src/services/ctrader.ts` ni `src/db/trading.ts` en procesos auxiliares:
 *   - NO dispara `reconcileCTraderPositions()` contra Firestore/active_trades.
 *   - NO levanta listeners `onSnapshot` de `asset_configs` ni `syncScannerRoster()`.
 *   - NO suscribe spots ni live trendbars que compitan con el proceso vivo `JARVIS`.
 *   - Coordina la lectura/renovación del token OAuth mediante el lock inter-proceso de `ctraderToken.ts`.
 *   - Cierra siempre el socket TLS (`client.disconnect()`) al terminar.
 */
import * as dotenv from 'dotenv';
import { CTrader } from 'ctrader-ts';
import { authenticateOwnedClient } from './ctrader_auth_owned.js';
import { refreshCtraderToken, refreshIfNeeded, syncAccessTokenFromEnv } from './ctraderToken.js';

dotenv.config();

const CONNECT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function connectReadOnlyCTraderClient(): Promise<CTrader> {
    const clientId = (process.env.CTRADER_CLIENT_ID || '').trim();
    const clientSecret = (process.env.CTRADER_CLIENT_SECRET || '').trim();
    const accountId = parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10) || 0;
    const isDemo = (process.env.CTRADER_DEMO || 'true').toLowerCase() === 'true';

    await refreshIfNeeded().catch(() => {});
    let accessToken = syncAccessTokenFromEnv() || (process.env.CTRADER_ACCESS_TOKEN || '').trim();
    if (!clientId || !accessToken || !accountId) {
        throw new Error('Credenciales cTrader incompletas para cliente read-only (CLIENT_ID / ACCESS_TOKEN / ACCOUNT_ID).');
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        accessToken = syncAccessTokenFromEnv() || accessToken;
        let timedOut = false;
        const pendingClient = new CTrader({
            host: isDemo ? 'demo.ctraderapi.com' : 'live.ctraderapi.com',
            port: 5035,
            accountId,
            maxReconnectAttempts: 0,
        });
        try {
            const authPromise = authenticateOwnedClient(pendingClient, {
                clientId,
                clientSecret,
                accountId,
                accessToken,
            });
            authPromise.then((c) => {
                if (timedOut) {
                    try { c.disconnect(); } catch { /* noop */ }
                }
            }).catch(() => {});

            return await withTimeout(authPromise, CONNECT_TIMEOUT_MS, 'connectReadOnlyCTraderClient')
                .catch((err) => {
                    timedOut = true;
                    try { pendingClient.disconnect(); } catch { /* noop */ }
                    throw err;
                });
        } catch (err: any) {
            lastErr = err;
            const msg = String(err?.message || '');
            if (/token|access|auth|credential|authoriz/i.test(msg)) {
                await refreshCtraderToken(true).catch(() => {});
            }
            if (attempt < MAX_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, 3000 * attempt));
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'Failed to connect read-only cTrader client'));
}

export async function withReadOnlyCTraderClient<T>(fn: (client: CTrader) => Promise<T>): Promise<T> {
    const client = await connectReadOnlyCTraderClient();
    try {
        return await fn(client);
    } finally {
        try { client.disconnect(); } catch { /* noop */ }
    }
}
