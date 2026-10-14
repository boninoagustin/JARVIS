// ─── Renovación automática del access token de cTrader (sep-2026) ─────────────
// El access token dura ~30 días (expires_in 2.628.000s). Este módulo lo renueva
// ANTES de expirar usando el refresh token contra openapi.ctrader.com/apps/token
// (cluster REST — distinto del WS demo/live.ctraderapi.com, funciona aunque el WS caiga).
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;      // ~30,4 días (valor real de expires_in)
const RENEW_THRESHOLD_MS = 3 * 24 * 3600 * 1000; // renovar cuando queden <3 días
const CHECK_INTERVAL_MS = 12 * 3600 * 1000;      // chequeo periódico cada 12h
const MIN_RETRY_GAP_MS = 6 * 3600 * 1000;        // si un refresh falla, no reintentar antes de 6h

let lastAttemptTs = 0;
let intervalStarted = false;

function readEnvFile(): string {
    return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}

function readEnvValue(key: string): string {
    const m = readEnvFile().match(new RegExp(`^${key}=(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/** Escribe varias claves del .env con UN solo backup. Preserva el resto del archivo. */
function writeEnvValues(pairs: Record<string, string>): void {
    let txt = readEnvFile();
    fs.copyFileSync(ENV_PATH, `${ENV_PATH}.bak-token-${Date.now()}`);
    for (const [key, value] of Object.entries(pairs)) {
        if (txt.includes(`\n${key}=`) || txt.startsWith(`${key}=`)) {
            txt = txt.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
        } else {
            txt = txt.replace(/\n?$/, `\n${key}=${value}\n`);
        }
    }
    fs.writeFileSync(ENV_PATH, txt, 'utf8');
}

/** Tiempo restante de validez del access token actual (ms). 0 = sin fecha registrada. */
export function tokenRemainingMs(): number {
    const issued = Number(readEnvValue('CTRADER_TOKEN_ISSUED_AT')) || 0;
    if (!issued) return 0;
    return issued + TOKEN_TTL_MS - Date.now();
}

/**
 * Renueva el access token con el refresh token (POST /apps/token).
 * Actualiza el .env (con backup) y la config EN MEMORIA para que la próxima conexión
 * use el token nuevo sin reiniciar el proceso.
 */
export async function refreshCtraderToken(force = false): Promise<boolean> {
    if (!force && Date.now() - lastAttemptTs < MIN_RETRY_GAP_MS) return false;
    lastAttemptTs = Date.now();

    const refreshToken = readEnvValue('CTRADER_REFRESH_TOKEN') || process.env.CTRADER_REFRESH_TOKEN || '';
    if (!refreshToken) {
        console.warn('[CTRADER-TOKEN] ⚠️ No hay CTRADER_REFRESH_TOKEN en .env — renovación automática deshabilitada.');
        return false;
    }
    try {
        const resp = await fetch('https://openapi.ctrader.com/apps/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: readEnvValue('CTRADER_CLIENT_ID') || config.CTRADER_CLIENT_ID,
                client_secret: readEnvValue('CTRADER_CLIENT_SECRET') || config.CTRADER_CLIENT_SECRET,
            }),
            signal: AbortSignal.timeout(20000),
        });
        if (!resp.ok) {
            console.error(`[CTRADER-TOKEN] ❌ Refresh rechazado (HTTP ${resp.status}) — token revocado o credenciales inválidas. Se necesita renovación manual.`);
            return false;
        }
        const data: any = await resp.json();
        const newAccess: string = data.access_token || data.accessToken;
        const newRefresh: string = data.refresh_token || data.refreshToken || refreshToken;
        if (!newAccess) {
            console.error('[CTRADER-TOKEN] ❌ Respuesta del refresh sin access_token.');
            return false;
        }
        const now = Date.now();
        writeEnvValues({
            CTRADER_ACCESS_TOKEN: newAccess,
            CTRADER_REFRESH_TOKEN: newRefresh,
            CTRADER_TOKEN_ISSUED_AT: String(now),
        });
        // 🛡️ Actualizar la config en memoria: la próxima conexión usa el token nuevo.
        config.CTRADER_ACCESS_TOKEN = newAccess;
        console.log(`[CTRADER-TOKEN] ✅ Token renovado — vence ~${new Date(now + TOKEN_TTL_MS).toISOString().slice(0, 10)}. La próxima conexión usará el nuevo.`);
        return true;
    } catch (e: any) {
        console.error(`[CTRADER-TOKEN] ❌ No se pudo renovar (¿openapi.ctrader.com caído?): ${e?.message || e}`);
        return false;
    }
}

/** Renueva si el token está por vencer (<3 días) o si no hay fecha de emisión registrada. */
export async function refreshIfNeeded(): Promise<boolean> {
    const remaining = tokenRemainingMs();
    if (remaining === 0) {
        console.warn('[CTRADER-TOKEN] ⚠️ Sin fecha de emisión registrada — refrescando una vez para fijarla.');
        return refreshCtraderToken(true);
    }
    if (remaining < RENEW_THRESHOLD_MS) {
        console.log(`[CTRADER-TOKEN] ⏳ Token por vencer en ${(remaining / 86400000).toFixed(1)} días — renovando.`);
        return refreshCtraderToken(true);
    }
    return false;
}

/** Chequeo periódico cada 12h (unref: no bloquea el proceso). */
export function startTokenAutoRenewal(): void {
    if (intervalStarted) return;
    intervalStarted = true;
    setInterval(() => { refreshIfNeeded().catch(() => { }); }, CHECK_INTERVAL_MS).unref();
    console.log('[CTRADER-TOKEN] 🔄 Renovación automática activa (chequeo cada 12h; renueva a <3 días del vencimiento).');
}
