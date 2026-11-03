# Cambios de operación — 02-nov-2026

Registro de los cambios de infraestructura hechos sobre el servidor (no viven en git,
pero acá queda el qué y el por qué). Todo es reversible.

## 1. Tune de detección: horario y presupuesto

- **Timer**: domingo **02:00 → 05:00** (`jarvis-detection-tune.timer.d/override.conf`).
  El ciclo del sábado (periodic-opt, 06:00) termina el domingo entre 01:26 y 08:54;
  a las 02:00 los dos jobs competían por CPU.
- **Timeout**: 6 h → 12 h → **18 h** (`jarvis-detection-tune.service.d/override.conf`).
  Medición real del 2-nov: 14 activos en **10 h 13 min** (14 h 28 min de CPU).
- ⚠️ **Lección**: `systemctl restart` sobre un timer con `Persistent=true` dispara el
  service de inmediato si hay una ventana vencida (pasó el 2-nov a las 00:39: arrancó
  una corrida completa, aplicó NZDUSD y reinició el bot a las 10:17). Para cambiar el
  horario sin correrlo: `systemctl stop`, editar, `start`.

## 2. Avisos y digest

- `opt_failure_notify.sh`: mensaje legible, unidad correcta (toma `MONITOR_UNIT` o la
  infiere de la unidad en `failed`) y `DRY_RUN=1` para probar.
- `jarvis-weekly-digest.timer`: **lunes 08:00**, digest por Telegram con estado de los
  jobs (incluye "no corrió"), candidatos, auto-aplicados, tests prospectivos, modelos,
  trades de la semana, abiertas, salud y tune.

## 3. Backup diario (estaba roto desde el 29-oct)

- Causa: `git add -A -- . ':!backups'` es **error de pathspec** (backups/ ya está
  ignorado) → la cadena `&&` cortaba antes del commit y el error iba a cron (sin MTA).
- Fix: commit diario 05:10 con log en `/var/log/jarvis_git_backup.log`.
- **El push a origin está desactivado a propósito**: el repo es **público**.

## 4. Seguridad

- `fail2ban` instalado y activo (jail sshd, `bantime=1d`, whitelist 138.219.212.0/24
  y loopback). Contexto: ~2.400 intentos SSH fallidos por día, todos rechazados
  (sshd ya es key-only, root sin password).
- `acct` (process accounting) activo: `lastcomm` permite auditar qué comando corrió
  cada usuario. Motivado por un reinicio del bot sin rastro el 2-nov.

## 5. Ciclo semanal: test prospectivo

- Drop-in `jarvis-periodic-opt.service.d/prospective.conf`: al final del ciclo corre
  `autoregister` → `evaluate` → `promote` → `model_health`, todos con `-` (un fallo
  no tumba el ciclo).

## 6. Integridad de modelos y presets (02-nov, código)

- `MLFilter.loadModelFromJSON`: **piso de evidencia** — no carga modelos con
  `accuracy < 0.55` o `train_samples < 50`; el ticker rechazado se marca para **no**
  caer al modelo DEFAULT (que es de otro activo) y usa la heurística.
- `train_ml_weekly.promote_candidate`: mismo piso antes de promover (devuelve
  `HOLD_SAMPLE` / `HOLD_ACCURACY`, no es un error del ciclo).
- `smc_config.loadOptimizedPreset`: avisa cuando un preset existe pero no tiene
  parámetros aplicables (caso `{}` de USTECH100/XPTUSD). Esos dos archivos se
  eliminaron: sin archivo, el motor usa el preset base (mismo comportamiento).
- Roster de entrenamiento: se agregaron XPDUSD y CHFJPY (los de más muestra).

## 7. Qué NO se tocó

- Push del backup a origin (el repo es público): pendiente de decisión.
- Modelos propios para el resto de los activos: no hay muestra suficiente (mismo
  techo que el optimizador).

## 7. Incidente del 02-nov 23:55 → 03-nov 00:00 (CLI de pm2 roto, sin downtime del bot)

**Qué pasó**: al crear un wrapper de auditoría en `/usr/local/bin/pm2` con `cat >`,
se escribió **a través del symlink** (`/usr/local/bin/pm2 → /root/.nvm/.../bin/pm2 →
../lib/node_modules/pm2/bin/pm2`), sobrescribiendo el CLI real con el wrapper. El
wrapper hacía `exec .../bin/pm2`, que ya era el wrapper → **recursión infinita**.
Todos los comandos `pm2` se colgaban (incluido `pm2 list`, `pm2 pid`, y el watchdog).

**Impacto**: ninguno sobre el bot — los procesos siguieron corriendo (uptime 13 h,
restarts 10 sin cambios). El daemon (God) estaba sano; solo el CLI quedó inutilizable.

**Fix**: se restauró `node_modules/pm2/bin/pm2` desde `npm pack pm2@7.0.3` (misma
versión que el daemon). Verificado con `pm2 list` (3 apps online).

**Lección**: antes de escribir un archivo con `>`, verificar que no sea symlink
(`ls -l`). Los wrappers van en un **nombre nuevo**: ahora existe `/usr/local/bin/pm2-audit`,
que loguea `user/uid/tty/ppid/args` en el journal (`journalctl -t pm2-audit`) y
ejecuta el pm2 real. Usar `pm2-audit restart JARVIS` para dejar rastro.

## 8. Cambio de cuenta — 03-nov-2026 (demo USD nueva)

- **Cuenta**: `traderLogin 5954670` → `ctidTraderAccountId **49413826**` (ojo: la API usa el
  ctidTraderAccountId, no el número de login). Demo Spotware, **USD, $5.000, 1:100**.
- `.env`: `CTRADER_ACCOUNT_ID=49413826`, `CTRADER_ACCESS_TOKEN=<nuevo>`, `CTRADER_DEMO=true`.
  Backup del anterior en `.env.bak-20261103-switch`.
- ⚠️ **`CTRADER_REFRESH_TOKEN` quedó vacío a propósito**: el refresh viejo renueva un token
  que cubre SOLO la cuenta anterior (verificado con `getAccountsByToken`), así que habilitarlo
  habría pisado el token nuevo. El access token vence ~03-dic-2026: antes de esa fecha hay que
  sacar el refresh token de la nueva autorización para reactivar la renovación automática.
- **Archivo de datos de la cuenta vieja** (`account_reset.ts --archive --date 20261103`):
  trade_journal 182, execution_metrics 257, trigger_telemetry 65, opt_reports 34,
  detection_health 46, ml_gate_evals 28, corr_gate_evals 19, exits_gate_evals 13,
  timesfm_gate_evals 12, rollover_evals 3, optimization_rollouts 3, autotune_reports 2,
  ghost_positions 2, prospective_tests 2, detection_diagnostics 1, health_check 1 →
  `<coleccion>_archive_20261103`. `auto_state` reiniciado (sin aplicaciones heredadas).
  Se conservaron `asset_configs`, `app_settings`, `firebase_config`, `system`.
- **Backup previo**: `backups/firestore_export_20261103/` (22 colecciones, 811 documentos).
- Verificación post-switch: `Modo: DEMO`, `Moneda de la cuenta detectada: USD`,
  conversiones suscriptas USDCAD/USDJPY/EURUSD/NZDUSD/AUDUSD, `account_state` = 5000 USD.
