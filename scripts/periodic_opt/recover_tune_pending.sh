#!/bin/bash
# Recupera la obligación de continuación ciclo→tune (revisión 7, 06-nov-2026).
#
# Estados del registro durable (weekly_continuation.json):
#   pending   → encolado pedido; si no hay tune activo, se reencola.
#   started   → el consumidor arrancó; si la unidad está inactiva, fue interrumpida → pending.
#   completed → ya consumida: se limpia SIN re-ejecutar (idempotencia).
#   failed    → reintento acotado (máx 3 intentos) → luego expired.
#   expired   → vencida por política; no se re-ejecuta y se informa (el digest la reporta).
#
# Ya NO compara la semana con la actual: un pendiente del sábado se recupera el lunes
# (revisión 6 de auditoría). Sólo expira por antigüedad (>5 días) o por exceso de intentos.
#
# Env (tests): CONT_DIR, TUNE_START_CMD
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/weekly_continuation_lib.sh"
TUNE_START_CMD="${TUNE_START_CMD:-systemctl start --no-block jarvis-detection-tune.service}"
MAX_ATTEMPTS=3
MAX_AGE_SEC=$((5 * 86400))

if [ ! -f "$CONT_FILE" ]; then
  echo "no-pending"
  exit 0
fi

STATE=$(cont_read '.state')
RUN_ID=$(cont_read '.runId')
WEEK=$(cont_read '.week')
CREATED=$(cont_read '.createdAt')
ATTEMPTS=$(cont_read '.attempts'); ATTEMPTS=${ATTEMPTS:-0}

# vencimiento explícito por antigüedad
if [ -n "$CREATED" ]; then
  CREATED_EPOCH=$(date -u -d "$CREATED" +%s 2>/dev/null || echo "")
  if [ -n "$CREATED_EPOCH" ]; then
    AGE=$(( $(date -u +%s) - CREATED_EPOCH ))
    if [ "$AGE" -gt "$MAX_AGE_SEC" ]; then
      cont_write --arg at "$(wc_now)" '.state="expired" | .expiredAt=$at' \
        && echo "expired: obligación de $WEEK ($RUN_ID) vencida por antigüedad (>5 días) — requiere atención"
      exit 1
    fi
  fi
fi

case "$STATE" in
  completed)
    rm -f "$CONT_FILE" "$TUNE_ID_FILE" 2>/dev/null
    echo "completed: corrida $RUN_ID ya consumida; se limpia sin re-ejecutar"
    exit 0
    ;;
  expired)
    echo "expired: corrida $RUN_ID sin acción (el digest la reporta)"
    exit 0
    ;;
  started)
    ST=$(systemctl show -p ActiveState --value jarvis-detection-tune.service 2>/dev/null || echo unknown)
    case "$ST" in
      active|activating|reloading)
        echo "running: el tune de $RUN_ID sigue en curso ($ST)"
        exit 0
        ;;
    esac
    echo "interrupted: el tune de $RUN_ID arrancó y la unidad está $ST → se reencola"
    cont_write '.state="pending"' || { echo "fail: no se pudo marcar pending"; exit 1; }
    ;;
  failed)
    echo "failed: el tune de $RUN_ID falló → se reintenta"
    cont_write '.state="pending"' || { echo "fail: no se pudo marcar pending"; exit 1; }
    ;;
  pending|"")
    : # sigue pendiente
    ;;
  *)
    echo "warn: estado desconocido '$STATE' → se trata como pending"
    cont_write '.state="pending"' || true
    ;;
esac

ATTEMPTS=$((ATTEMPTS + 1))
if [ "$ATTEMPTS" -gt "$MAX_ATTEMPTS" ]; then
  cont_write --arg at "$(wc_now)" --argjson n "$ATTEMPTS" '.state="expired" | .attempts=$n | .expiredAt=$at' \
    && echo "expired: $RUN_ID superó $MAX_ATTEMPTS intentos de encolado — requiere atención"
  exit 1
fi
cont_write --argjson n "$ATTEMPTS" '.attempts=$n' || { echo "fail: no se pudo persistir attempts"; exit 1; }

# identidad para el consumidor + encolado
printf '%s\n' "$RUN_ID" > "$TUNE_ID_FILE.tmp" 2>/dev/null \
  && mv -f "$TUNE_ID_FILE.tmp" "$TUNE_ID_FILE" 2>/dev/null \
  && [ "$(cat "$TUNE_ID_FILE" 2>/dev/null)" = "$RUN_ID" ] \
  || { echo "fail: no se pudo escribir tune_run_id"; exit 1; }

if $TUNE_START_CMD; then
  echo "requeued: runId $RUN_ID (intento $ATTEMPTS)"
  exit 0
fi
echo "fail: no se pudo reencolar el tune (intento $ATTEMPTS)"
exit 1
