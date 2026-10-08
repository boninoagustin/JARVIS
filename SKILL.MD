# JARVIS — Bot de trading SMC/ICT (TypeScript)

Bot algorítmico que opera en vivo contra cTrader (OpenAPI), gestionado por Telegram (grammy), con estado y configuración en Firestore. Dashboard React/Vite (`jarvis-os`), API Kronos (FastAPI) y optimizador periódico separados.

> ⚠️ Este archivo reemplaza al antiguo "Equipo Alejabot" (remanente del proyecto pre-trading, borrado en la auditoría oct-2026). Para recuperación ante desastre: **`SETUP.md`**.

## Arquitectura

| Proceso | Qué es | Puerto |
|---|---|---|
| `JARVIS` (PM2) | Bot vivo: decisión + ejecución + Telegram | — |
| `JARVIS_OS` (PM2) | Dashboard Vite (`npm run dev`) | 5173 |
| `KRONOS_API` (PM2) | API FastAPI de backtest | 8000 |
| WebSocket | Estados de radar al dashboard | 8081 |
| `jarvis-timesfm-bridge` (systemd) | Filtro direccional TimesFM | 8788 |
| `jarvis-asset-scout.timer` | Screening de activos | sáb 03:00 CEST |
| `jarvis-periodic-opt.timer` | Optimizador semanal (~14 pasos) | sáb 06:00 CEST |

## Operación (reglas que el bot aplica)

- **Roster dinámico**: un ticker opera si `enabled && !disabledReason` en `asset_configs/{ticker}` (Firestore). Sin la key `enabled`, NO opera (opt-in explícito).
- **Entrada SMART**: decide entre directa u OTE (riesgo >1.5×ATR → OTE; vela clímax → OTE; R:R≥1.5 o momentum extremo → directa; resto → OTE).
- **Killswitch global**: `evaluateGlobalKillswitch` cierra el día si el PnL acumulado toca `maxDailyLossR` (día FX cambia 17:00 NY).
- **Rollover diario 21:00 UTC**: el feed muere ~20:29→21:00, spread de reapertura ~19 pips. Reglas A/D detrás de `rolloverBeEnabled` (SL→BE pre-rollover) y `rolloverEntryBlock` (bloquear entradas en el gap).
- **Bono macro escalonado**: 3/3 = +5, 2/3 = +2, ≤1 = 0.

## Emergencia

- **Restart del bot**: `pm2 restart JARVIS --update-env`. Reconstruye estado SMC desde histórico (reinicio controlado). Verificar `Conectado exitosamente` + `N configs cargadas` en `~/.pm2/logs/JARVIS-out.log`.
- **Rollback de config**: snapshots en `scripts/periodic_opt/opt_out/prev_<TICKER>_<fecha>.json` y `backups/`. Restaurar el doc en Firestore.
- **Doc de config inválido**: el bot lo BLOQUEA (fail-closed), log `[CONFIG] INVÁLIDO` en `JARVIS-error.log`.
- **Optimizador congelado**: `AUTO_APPLY_ENABLED=False` en `run_weekly.py` → solo propone, no aplica. Ver `SETUP.md`.

## Auditorías

Informes completos en `audit_reports/` (tanda1..5 + `audit_resultado_<fecha>.md`). Regla del operador: **todo cambio de estrategia se backtestea antes de aplicarse al vivo**.
