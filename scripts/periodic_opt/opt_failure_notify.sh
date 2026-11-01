#!/bin/bash
# Aviso por Telegram cuando falla una unidad programada de JARVIS.
# 21-sep-2026 (original) · 02-nov-2026: mensaje legible para humanos, unidad disparadora
# correcta y sin volcados crudos del journal (antes: 1600 chars de log ilegible).
#
# Uso: opt_failure_notify.sh [unidad]
#   Unidad: $1 → MONITOR_UNIT (lo pone systemd en las unidades lanzadas por OnFailure=)
#   → si systemd no lo propaga (p.ej. "multiple trigger source candidates"), se infiere
#   de la unidad jarvis-* que esté en estado failed.
#   DRY_RUN=1 imprime el mensaje en stdout en vez de enviarlo.

UNIT="${1:-${MONITOR_UNIT:-}}"
if [ -z "$UNIT" ]; then
  UNIT=$(systemctl list-units 'jarvis-*.service' --state=failed --plain --no-legend 2>/dev/null \
         | awk 'NR==1{print $1}')
fi
[ -z "$UNIT" ] && UNIT="jarvis-periodic-opt.service"

case "$UNIT" in
  jarvis-detection-tune.service)
    TITULO="el tune semanal de detección SMC"
    IMPLICA="la búsqueda quedó cortada: activos sin re-tunear y el panel de salud sin refrescar. El bot sigue operando con los presets anteriores."
    ;;
  jarvis-periodic-opt.service)
    TITULO="el ciclo de optimización semanal"
    IMPLICA="el ciclo no terminó: revisar hyperopt y reportes del domingo. El bot sigue operando con la configuración vigente."
    ;;
  jarvis-asset-scout.service)
    TITULO="el screening de activos del sábado"
    IMPLICA="no se propusieron candidatos nuevos esta semana. No afecta la operación."
    ;;
  *)
    TITULO="$UNIT"
    IMPLICA="revisar el journal de la unidad."
    ;;
esac

case "${MONITOR_SERVICE_RESULT:-}" in
  timeout)
    LIM=$(systemctl show "$UNIT" -p TimeoutStartUSec --value 2>/dev/null)
    case "$LIM" in ''|infinity) RES_TXT="timeout — el job superó el tiempo máximo permitido" ;;
                   *) RES_TXT="timeout — superó el límite de ${LIM}" ;; esac
    ;;
  exit-code) RES_TXT="terminó con error (exit ${MONITOR_EXIT_STATUS:-?})" ;;
  signal)    RES_TXT="lo terminó una señal (${MONITOR_EXIT_STATUS:-?})" ;;
  '')        RES_TXT="sin datos de systemd (fin anormal)" ;;
  *)         RES_TXT="$MONITOR_SERVICE_RESULT" ;;
esac

# Últimas líneas del journal: sin ruido de trading en vivo, sin JSON, sin la
# retahíla de systemd (Failed with result / Finished / Consumed), recortadas.
RAW_J=$(journalctl -u "$UNIT" -n 200 --no-pager -o cat 2>/dev/null)
CPU=$(printf '%s\n' "$RAW_J" | grep -a 'Consumed .* CPU time' | tail -1 | sed -E 's/.*Consumed (.*) CPU time.*/\1/')
LINES=$(printf '%s\n' "$RAW_J" \
  | grep -avE 'expired_forming_bar|no mapeado|\[CTRADER-TB\]|\[CONFIG\]|Applied Detection params|Loaded optimized preset|"[A-Za-z_]+":' \
  | grep -avE '^[A-Za-z0-9_.@-]+\.service: |^(Failed to start|Finished |Starting |Stopping |Deactivated |Triggering )' \
  | awk 'length($0) > 150 { print substr($0,1,147) "..." ; next } { print }' \
  | grep -avE '^[[:space:]]*$' \
  | tail -3 | sed 's/^/• /')

MSG="🚨 JARVIS — falló ${TITULO}
🕒 $(date '+%d/%m %H:%M %Z')
📄 Unidad: ${UNIT}
🧾 Resultado: ${RES_TXT}
⚠️ Qué implica: ${IMPLICA}"
if [ -n "${CPU:-}" ]; then
  MSG="${MSG}
⏱ CPU consumida: ${CPU}"
fi
if [ -n "$LINES" ]; then
  MSG="${MSG}
🔍 Últimas líneas:
${LINES}"
fi
MSG="${MSG}
🛠 Revisar: journalctl -u ${UNIT} -n 50"

if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$MSG"
  exit 0
fi

TOKEN=$(grep -oE 'TELEGRAM_BOT_TOKEN="[^"]+"' /opt/JARVIS/.env | head -1 | sed 's/TELEGRAM_BOT_TOKEN="//; s/"$//')
CHAT_ID=$(grep -oE 'TELEGRAM_ALLOWED_USER_IDS="[^"]+"' /opt/JARVIS/.env | head -1 | sed 's/TELEGRAM_ALLOWED_USER_IDS="//; s/"$//')
CHAT_ID="${CHAT_ID:-1348898450}"
[ -z "$TOKEN" ] && exit 0
curl -s -m 20 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  --data-urlencode "text=${MSG}" >/dev/null 2>&1
exit 0
