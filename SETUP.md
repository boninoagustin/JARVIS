# 🚨 RECUPERACIÓN DE DESASTRE — JARVIS en servidor nuevo

Este repo es el respaldo completo del bot. Con estos pasos, en ~15 minutos JARVIS
queda operando en un VPS limpio. Los datos del bot (asset_configs, trade_journal,
active_trades, telemetría) viven en **Firestore (Google Cloud)** — sobreviven la
muerte del servidor sin hacer nada.

## Requisitos previos

- Ubuntu 22.04/24.04, ~8GB RAM (el VPS de producción hoy: 7.8GB).
- Node 22 (`curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs`).
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

5. **Optimizador dominical**
   ```bash
   cp scripts/periodic_opt/jarvis-periodic-opt.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now jarvis-periodic-opt
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

## Notas

- BTCUSD está deshabilitado a nivel config (Firestore), el optimizador no lo pisa.
- El bot corre en DEMO (`CTRADER_DEMO=true` en .env) — pasar a LIVE solo explícitamente.
- Kimi/PC ya no tocan este repo: el VPS es la única fuente de verdad.
