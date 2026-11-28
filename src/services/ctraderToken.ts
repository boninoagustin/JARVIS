// ─── Renovación automática del access token de cTrader (sep-2026) ─────────────
// El access token dura ~30 días (expires_in 2.628.000s). Este módulo lo renueva
// ANTES de expirar usando el refresh token contra openapi.ctrader.com/apps/token
// (cluster REST — distinto del WS demo/live.ctraderapi.com, funciona aunque el WS caiga).
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

// H11: sobreescribible para tests (no toca el .env real).
const ENV_PATH = process.env.CTRADER_ENV_PATH || path.resolve(process.cwd(), '.env');
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

/**
 * H11 (auditoría 2026-11-05): escritura ATÓMICA del .env.
 * - backup con permisos 0600,
 * - tmp + fsync + rename (un crash no deja el .env truncado),
 * - modo 0600 y readback de las claves escritas.
 */
function writeEnvValues(pairs: Record<string, string>): void {
    let txt = readEnvFile();
    const backup = `${ENV_PATH}.bak-token-${Date.now()}`;
    try {
        fs.copyFileSync(ENV_PATH, backup);
        fs.chmodSync(backup, 0o600);
    } catch (e: any) {
        console.warn(`[CTRADER-TOKEN] ⚠️ No se pudo crear el backup (${e?.message || e}); se continúa con la escritura atómica.`);
    }
    for (const [key, value] of Object.entries(pairs)) {
        if (txt.includes(`\n${key}=`) || txt.startsWith(`${key}=`)) {
            txt = txt.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
        } else {
            txt = txt.replace(/\n?$/, `\n${key}=${value}\n`);
        }
    }
    const tmp = `${ENV_PATH}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeFileSync(fd, txt, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, ENV_PATH);
    try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* best-effort */ }
    // readback: el par nuevo tiene que estar en el archivo final
    const after = readEnvFile();
    for (const key of Object.keys(pairs)) {
        if (!new RegExp(`^${key}=`, 'm').test(after)) {
            throw new Error(`readback falló: ${key} no quedó en ${ENV_PATH}`);
        }
    }
}

/** Tiempo restante de validez del access token actual (ms). 0 = sin fecha registrada. */
export function tokenRemainingMs(): number {
    const issued = Number(readEnvValue('CTRADER_TOKEN_ISSUED_AT')) || 0;
    if (!issued) return 0;
    return issued + TOKEN_TTL_MS - Date.now();
}

/**
 * Sincroniza `config.CTRADER_ACCESS_TOKEN` desde el `.env` en disco si otro proceso
 * (ej. un script CLI con lock compartido) rotó el token mientras `JARVIS` estaba vivo.
 */
export function syncAccessTokenFromEnv(): string {
    const diskToken = readEnvValue('CTRADER_ACCESS_TOKEN');
    if (diskToken && diskToken !== config.CTRADER_ACCESS_TOKEN) {
        config.CTRADER_ACCESS_TOKEN = diskToken;
        console.log('[CTRADER-TOKEN] 🔄 Access token recargado en memoria desde .env.');
    }
    return diskToken || config.CTRADER_ACCESS_TOKEN || '';
}

function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e?.code === 'EPERM';
    }
}

async function withCrossProcessTokenLock<T>(fn: () => Promise<T>, maxWaitMs = 25_000): Promise<T> {
    const lockPath = `${ENV_PATH}.token.lock`;
    const deadline = Date.now() + maxWaitMs;
    let acquired = false;
    while (Date.now() < deadline) {
        try {
            const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
            try {
                fs.writeFileSync(fd, `${process.pid}:${Date.now()}\n`, 'utf8');
            } finally {
                fs.closeSync(fd);
            }
            acquired = true;
            break;
        } catch (e: any) {
            if (e?.code !== 'EEXIST') throw e;
            try {
                const raw = fs.readFileSync(lockPath, 'utf8').trim();
                const [pidStr, tsStr] = raw.split(':');
                const lockPid = Number(pidStr);
                const lockTs = Number(tsStr);
                const staleAge = Number.isFinite(lockTs) && Date.now() - lockTs > 60_000;
                const deadOwner = Number.isInteger(lockPid) && lockPid > 0 && lockPid !== process.pid && !isPidAlive(lockPid);
                if (staleAge || deadOwner) {
                    try { fs.unlinkSync(lockPath); } catch { /* otro proceso lo limpió */ }
                    continue;
                }
            } catch { /* en tránsito */ }
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    if (!acquired) {
        console.warn(`[CTRADER-TOKEN] ⚠️ Timeout esperando lock inter-proceso (${lockPath}); abortando refresh concurrente.`);
        return false as unknown as T;
    }
    try {
        return await fn();
    } finally {
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
    }
}

/**
 * Renueva el access token con el refresh token (POST /apps/token).
 * Actualiza el .env (con backup) y la config EN MEMORIA para que la próxima conexión
 * use el token nuevo sin reiniciar el proceso.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * H11: SINGLEFLIGHT (en proceso + inter-proceso vía .env.token.lock).
 * Varios orígenes llaman al refresh (auto-renewal, connectCTrader, scripts CLI).
 * Todos convergen sin quemar el refresh_token single-use en paralelo.
 */
export function refreshCtraderToken(force = false): Promise<boolean> {
    if (refreshInFlight) {
        console.log('[CTRADER-TOKEN] ↔️ refresh ya en curso — se reutiliza (singleflight)');
        return refreshInFlight;
    }
    if (!force && Date.now() - lastAttemptTs < MIN_RETRY_GAP_MS) return Promise.resolve(false);
    const prevDiskToken = readEnvValue('CTRADER_ACCESS_TOKEN');
    const prevIssuedAt = Number(readEnvValue('CTRADER_TOKEN_ISSUED_AT')) || 0;
    lastAttemptTs = Date.now();
    refreshInFlight = withCrossProcessTokenLock(() => doRefresh(prevDiskToken, prevIssuedAt)).finally(() => { refreshInFlight = null; });
    return refreshInFlight;
}

async function doRefresh(prevDiskToken = '', prevIssuedAt = 0): Promise<boolean> {
    // Si otro proceso acaba de rotar el token mientras esperábamos el lock, reutilizar el nuevo .env sin repetir POST.
    const currentDiskToken = readEnvValue('CTRADER_ACCESS_TOKEN');
    const currentIssuedAt = Number(readEnvValue('CTRADER_TOKEN_ISSUED_AT')) || 0;
    if (currentDiskToken && ((prevDiskToken && currentDiskToken !== prevDiskToken) || (currentIssuedAt > prevIssuedAt && currentIssuedAt + TOKEN_TTL_MS - Date.now() >= RENEW_THRESHOLD_MS))) {
        config.CTRADER_ACCESS_TOKEN = currentDiskToken;
        console.log('[CTRADER-TOKEN] ↔️ Otro proceso ya renovó el token en .env — adoptado sin re-rotar.');
        return true;
    }
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
