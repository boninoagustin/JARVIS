#!/bin/bash
# ============================================================
# Watchdog externo de ruta cTrader + reconexión segura de JARVIS
# Corre cada 15 min vía crontab de root.
# Avisos por Telegram usando el MISMO canal que el bot JARVIS.
#
# Lógica:
#   Ruta DOWN  -> avisa 1 sola vez por caída. No toca nada.
#   Ruta UP + bot offline:
#     - si hace <1h del último reinicio: solo cuenta intentos;
#       tras 3 corridas consecutivas avisa "posible token vencido".
#     - si hace >=1h: consulta trades activos en Firestore.
#         * 0 trades        -> pm2 restart JARVIS + aviso
#         * N>0 trades      -> NO reinicia (riesgo positionId), aviso manual
#         * Firestore falla -> NO reinicia, aviso manual
#   Ruta UP + bot conectado -> no hace nada.
# ============================================================
set -u

LOG=/opt/JARVIS/watchdog.log
STATE_FILE=/opt/JARVIS/.watchdog_state
LAST_RESTART_FILE=/opt/JARVIS/.watchdog_last_restart
FAIL_COUNT_FILE=/opt/JARVIS/.watchdog_fail_count
LAST_NOTIFY_FILE=/opt/JARVIS/.watchdog_last_notify
ENV=/opt/JARVIS/.env
OUTLOG=/root/.pm2/logs/JARVIS-out.log
# FIX (07-sep-2026): la Open API escucha en 5035 (protobuf) / 5036 (JSON), NO en 443.
# Doc oficial: help.ctrader.com/open-api → "Connect to endpoints".
# El puerto 443 nunca responde → falsa alarma de "ruta caída" desde el 07-sep 02:06.
HOST=demo.ctraderapi.com
PORT=5035

ts() { date '+%Y-%m-%d %H:%M:%S %Z'; }
now_epoch() { date +%s; }
log() { echo "$(ts) $1" >> "$LOG"; }

# ---------- Telegram (mismo canal del bot) ----------
TOKEN=$(grep -m1 -E '^TELEGRAM_BOT_TOKEN=' "$ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
CHAT_ID=$(grep -m1 -E '^TELEGRAM_ALLOWED_USER_IDS=' "$ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" | cut -d, -f1 | xargs)

notify() {
  local msg="$1"
  local last=0
  [ -f "$LAST_NOTIFY_FILE" ] && last=$(cat "$LAST_NOTIFY_FILE" 2>/dev/null || echo 0)
  local now=$(now_epoch)
  if [ $((now - last)) -lt 1800 ]; then
    log "[notify-rate-limited] $msg"
    return
  fi
  if [ -n "$TOKEN" ] && [ -n "$CHAT_ID" ]; then
    # FIX (07-sep-2026): validar la respuesta real de Telegram. Antes el curl
    # descartaba la salida y se logueaba "[TELEGRAM]" aunque el envío fallara.
    local resp
    resp=$(curl -s -m 15 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" --data-urlencode "text=${msg}")
    if echo "$resp" | grep -q '"ok":true'; then
      log "[TELEGRAM-OK] $msg"
    else
      log "[TELEGRAM-ERROR] falló el envío: $(echo "$resp" | head -c 200)"
    fi
  else
    log "[TELEGRAM-ERROR] TOKEN o CHAT_ID vacíos — no se envió: $msg"
  fi
  echo "$now" > "$LAST_NOTIFY_FILE"
}

# ---------- 1) Ruta TCP ----------
ROUTE=DOWN
for i in 1 2 3; do
  if nc -z -w 8 "$HOST" "$PORT" >/dev/null 2>&1; then ROUTE=UP; break; fi
done

PREV=$(cat "$STATE_FILE" 2>/dev/null || echo "UP")

# ---------- 2) Estado del bot (señales frescas del out.log) ----------
# FIX (07-sep-2026): 300 líneas era insuficiente con el volumen de trendbars (~50MB/h);
# se amplía a 5000 (~2-3 min de log) para no quedar en "señales ambiguas".
BOT_OFFLINE=0; BOT_ONLINE=0
if tail -n 2000 "$OUTLOG" 2>/dev/null | grep -aq "cTrader no conectado"; then BOT_OFFLINE=1; fi
if tail -n 5000 "$OUTLOG" 2>/dev/null | grep -aq "Conectado exitosamente"; then BOT_ONLINE=1; fi

# ---------- 3) Trades activos (Firestore) ----------
trades_count() {
  cd /opt/JARVIS || return
  timeout 60 npx tsx scripts/watchdog_trades_check.ts 2>/dev/null | grep -aE '^[0-9]+$' | tail -1
}

case "$ROUTE" in
  DOWN)
    if [ "$PREV" != "DOWN" ]; then
      echo "DOWN" > "$STATE_FILE"
      notify "🔴 JARVIS watchdog: ruta a cTrader CAÍDA (TCP $HOST:$PORT no responde). El bot no puede operar. Quedo vigilando y aviso cuando vuelva."
    else
      log "ruta sigue DOWN — sin cambios"
    fi
    ;;
  UP)
    if [ "$BOT_OFFLINE" = "1" ]; then
      LAST_RESTART=0
      [ -f "$LAST_RESTART_FILE" ] && LAST_RESTART=$(cat "$LAST_RESTART_FILE" 2>/dev/null || echo 0)
      now=$(now_epoch)
      if [ $((now - LAST_RESTART)) -ge 3600 ]; then
        echo 0 > "$FAIL_COUNT_FILE"
        ACTIVE_TRADES=$(trades_count)
        [ -z "$ACTIVE_TRADES" ] && ACTIVE_TRADES="unknown"
        if [ "$ACTIVE_TRADES" = "0" ]; then
          pm2 restart JARVIS >/dev/null 2>&1
          echo "$now" > "$LAST_RESTART_FILE"
          echo "UP" > "$STATE_FILE"
          notify "🟢 JARVIS watchdog: ruta a cTrader restaurada. Bot reiniciado para reconectar (0 trades activos)."
        elif [ "$ACTIVE_TRADES" = "unknown" ]; then
          echo "UP" > "$STATE_FILE"
          notify "🟢 JARVIS watchdog: ruta restaurada pero el bot sigue offline y no pude verificar trades activos (Firestore). NO reinicio — revisión manual."
        else
          echo "UP" > "$STATE_FILE"
          notify "🟢 JARVIS watchdog: ruta restaurada, bot offline PERO hay $ACTIVE_TRADES trades activos — NO reinicio automático (riesgo positionId). Reiniciá vos si corresponde."
        fi
      else
        FAIL=$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)
        FAIL=$((FAIL + 1))
        echo "$FAIL" > "$FAIL_COUNT_FILE"
        log "ruta UP + bot offline tras reinicio reciente (<1h), corrida fallida nº $FAIL"
        if [ "$FAIL" -ge 3 ]; then
          notify "⚠️ JARVIS watchdog: la ruta a cTrader ya funciona pero el bot sigue sin conectar tras reinicios. Probable TOKEN VENCIDO — revisar https://openapi.ctrader.com"
        fi
      fi
    elif [ "$BOT_ONLINE" = "1" ]; then
      echo "UP" > "$STATE_FILE"
      echo 0 > "$FAIL_COUNT_FILE"
      log "ruta UP y bot conectado — todo sano"
    else
      log "ruta UP, señales ambiguas — sin acción"
    fi
    ;;
esac

exit 0
