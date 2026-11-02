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

## 6. Qué NO se tocó

- `train_ml_weekly.py` y `MLFilter.ts` (guard de modelos): pendiente.
- Push del backup: pendiente de decisión.

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
