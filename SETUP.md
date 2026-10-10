# 🚨 RECUPERACIÓN DE DESASTRE — JARVIS en servidor nuevo

Este repo es el respaldo completo del bot. Con estos pasos, en ~15 minutos JARVIS
queda operando en un VPS limpio. Los datos del bot (asset_configs, trade_journal,
active_trades, telemetría) viven en **Firestore (Google Cloud)** — sobreviven la
muerte del servidor sin hacer nada.

## Requisitos previos

- Ubuntu 22.04/24.04, ~8GB RAM (el VPS de producción hoy: 7.8GB).
- Node 24 vía nvm (`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install 24 && nvm alias default 24`). Los jobs systemd usan el binario de nvm (`/root/.nvm/versions/node/v24.19.0/bin/`), no el de sistema.
- Python 3.10+ con venv (para KRONOS_API y el optimizador).
- Git, pm2 global (`npm i -g pm2`), ufw.
- La **passphrase de respaldo** (la que protege `secrets/*.enc`). Guardada FUERA del servidor.

## Pasos

1. **Clonar y dependencias**
   ```bash
   git clone https://github.com/boninoagustin/JARVIS.git /opt/JARVIS
   cd /opt/JARVIS && npm ci
   cd jarvis-os && npm ci && cd ..
   python3 -m venv kronos_api/venv
   kronos_api/venv/bin/pip install -r kronos_api/requirements.txt
   python3 -m venv scripts/timesfm/.venv
   scripts/timesfm/.venv/bin/pip install -r scripts/timesfm/requirements.txt
   python3 -m venv scripts/hyperopt/.venv
   scripts/hyperopt/.venv/bin/pip install -r scripts/hyperopt/requirements.txt
   # (periodic_opt usa /usr/bin/python3 directamente, sin venv)
   ```

2. **Secretos** (pide la passphrase interactivamente)
   ```bash
   bash scripts/secrets_decrypt.sh
   ```
   Verificar: `.env` (bot) y `jarvis-os/.env` (dashboard) quedan creados con permisos 600.

3. **Procesos**
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save && pm2 startup   # auto-arranque en boot
   ```

4. **TimesFM bridge** (filtro direccional — si no levanta, el filtro degrada silenciosamente)
   ```bash
   cp scripts/timesfm/jarvis-timesfm-bridge.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now jarvis-timesfm-bridge
   curl -s localhost:8788/health   # {"ok": true, ...}
   ```

5. **Optimizador periódico (SÁBADO 06:00 CEST, ~14 pasos — NO "dominical")**
   ```bash
   cp scripts/periodic_opt/jarvis-periodic-opt.service /etc/systemd/system/
   cp scripts/periodic_opt/jarvis-periodic-opt.timer /etc/systemd/system/
   cp scripts/periodic_opt/jarvis-asset-scout.service /etc/systemd/system/     # screening sáb 03:00
   cp scripts/periodic_opt/jarvis-asset-scout.timer /etc/systemd/system/
   cp scripts/periodic_opt/jarvis-opt-failure-notify.service /etc/systemd/system/  # notificación de fallo por Telegram
   cp scripts/periodic_opt/jarvis-detection-tune.service /etc/systemd/system/      # tune detección SMC (dom 02:00, ex-bruteforcer)
   cp scripts/periodic_opt/jarvis-detection-tune.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now jarvis-periodic-opt.timer jarvis-asset-scout.timer jarvis-detection-tune.timer
   ```

6. **Seguridad** (mismo esquema que el VPS actual)
   ```bash
   # SSH solo clave:
   echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config.d/50-cloud-init.conf
   systemctl reload ssh
   # Firewall: default deny, solo lo necesario
   ufw default deny incoming && ufw allow 22/tcp && ufw enable
   # Dashboard/WS/API solo por Tailscale (100.64.0.0/10):
   ufw allow from 100.64.0.0/10 to any port 5173 proto tcp
   ufw allow from 100.64.0.0/10 to any port 8081 proto tcp
   ufw allow from 100.64.0.0/10 to any port 8000 proto tcp
   # Tailscale:
   curl -fsSL https://tailscale.com/install.sh | sh && tailscale up
   ```

7. **Verificación**
   ```bash
   pm2 logs JARVIS --lines 30 | grep -E "Conectado exitosamente|TELEMETRY"
   tail -3 ~/.pm2/logs/JARVIS-out.log   # cTrader conectado + telemetría activa
   curl -s localhost:5173/ | head -1    # dashboard HTML
   ```
   Dashboard: `http://<IP-tailscale>:5173` desde una PC en el tailnet.

## Respaldo diario (ya corriendo en el VPS actual)

Crontab de root en el VPS: `10 5 * * *` hace commit+push automático de /opt/JARVIS
(excluye `scripts/hyperopt/*.db` y `backups/`). Los secretos NO van crudos al repo:
solo `secrets/*.enc` encriptados (AES-256-CBC, passphrase fuera del servidor).

## Cambiar la passphrase / actualizar secretos

```bash
bash scripts/secrets_encrypt.sh && git add secrets && git commit -m "secrets" && git push
```

## Estado CONGELADO del optimizador (⚠️ importante)

El flag `AUTO_APPLY_ENABLED` en `scripts/periodic_opt/run_weekly.py` controla si el optimizador AUTO-APLICA sus propuestas. Estado actual: **CONGELADO (`False`)** — corre y genera proposals, pero NO escribe configs. `killswitch_tune.ts`, `directional_mcl_tune.ts` y `tf_sweep_weekly.ts` honran `--dry-run` cuando está congelado (verificar sus flags antes de descongelar).

- **Descongelar**: poner `AUTO_APPLY_ENABLED=True` en `run_weekly.py` y quitar los `--dry-run` del service.

## Runbook de rollback de configs

1. Snapshot previo por activo: `scripts/periodic_opt/opt_out/prev_<TICKER>_<fecha>.json`.
2. Rollback de un activo: restaurar el doc en Firestore desde `backups/` (hay `backups/*_tuned*.json`).
3. Fallo de Firestore en caliente: el bot es fail-open con `.catch` silencioso → monitorear `~/.pm2/logs/JARVIS-error.log`; un doc de config inválido bloquea el activo (fail-closed, buscar `[CONFIG] INVÁLIDO`).

## Notas

- BTCUSD está deshabilitado a nivel config (Firestore), el optimizador no lo pisa.
- El bot corre en DEMO (`CTRADER_DEMO=true` en .env) — pasar a LIVE solo explícitamente.
- Kimi/PC ya no tocan este repo: el VPS es la única fuente de verdad.
