#!/bin/bash
# Recupera la obligación de continuación ciclo→tune (revisión 8, 06-nov-2026).
#
# Estados del registro durable (weekly_continuation.json):
#   pending   → encolado pedido. Si el tune está ACTIVO no se toca (ni intentos ni reencolado).
#   started   → el consumidor arrancó. Si la unidad está inactiva se distingue:
#                 · Result=success  → terminó bien y sólo falló el registro → se REPARA
#                   (completed) sin re-ejecutar.
#                 · otro             → interrumpida de verdad → pending.
#   stale     → estado terminal no persistido por el wrapper → se repara por Result.
#   completed → ya consumida: se limpia SIN re-ejecutar (idempotencia).
#   failed    → reintento acotado (máx 3) → luego expired.
#   expired   → vencida; no se re-ejecuta, se informa (exit 1 = requiere atención).
#
# Env (tests): CONT_DIR, TUNE_START_CMD, TUNE_STATE_CMD, TUNE_RESULT_CMD
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/weekly_continuation_lib.sh"
TUNE_START_CMD="${TUNE_START_CMD:-systemctl start --no-block jarvis-detection-tune.service}"
TUNE_STATE_CMD="${TUNE_STATE_CMD:-systemctl show -p ActiveState --value jarvis-detection-tune.service}"
# Evidencia POSITIVA de completado: Result=success es el default de systemd cuando la unidad
# no corrió en este boot (verificado en el host: Result=success con ExecMain*Timestamp vacíos).
# Se exige haber arrancado Y salido en este boot, con status 0.
TUNE_START_TS_CMD="${TUNE_START_TS_CMD:-systemctl show -p ExecMainStartTimestamp --value jarvis-detection-tune.service}"
TUNE_EXIT_TS_CMD="${TUNE_EXIT_TS_CMD:-systemctl show -p ExecMainExitTimestamp --value jarvis-detection-tune.service}"
TUNE_STATUS_CMD="${TUNE_STATUS_CMD:-systemctl show -p ExecMainStatus --value jarvis-detection-tune.service}"
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

unit_active() {
  case "$($TUNE_STATE_CMD 2>/dev/null || echo unknown)" in
    active|activating|reloading) return 0 ;;
    *) return 1 ;;
  esac
}
unit_completed_evidence() {
  local start exit_ts status
  start=$($TUNE_START_TS_CMD 2>/dev/null || echo "")
  exit_ts=$($TUNE_EXIT_TS_CMD 2>/dev/null || echo "")
  status=$($TUNE_STATUS_CMD 2>/dev/null || echo "")
  case "$start" in ""|n/a|unknown) return 1 ;; esac
  case "$exit_ts" in ""|n/a|unknown) return 1 ;; esac
  [ "$status" = "0" ] || return 1
  return 0
}

case "$STATE" in
  completed)
    rm -f "$CONT_FILE" "$TUNE_ID_FILE" 2>/dev/null
    echo "completed: corrida $RUN_ID ya consumida; se limpia sin re-ejecutar"
    exit 0
    ;;
  expired)
    echo "expired: corrida $RUN_ID sin acción (el digest la reporta)"
    exit 1
    ;;
  pending)
    if unit_active; then
      # El tune está corriendo aunque el wrapper no haya podido registrar 'started'.
      echo "running: el tune de $RUN_ID está activo; no se incrementan intentos"
      exit 0
    fi
    ;;
  stale)
    # Estado terminal no persistido: sólo se repara con evidencia POSITIVA de salida.
    if unit_completed_evidence; then
      if ! cont_write --arg at "$(wc_now)" '.state="completed" | .completedAt=$at'; then
        echo "fail: no se pudo persistir la reparación de $RUN_ID; se conserva el registro"
        exit 1
      fi
      rm -f "$CONT_FILE" "$TUNE_ID_FILE" 2>/dev/null
      echo "repaired: $RUN_ID con evidencia de salida OK; registro reparado sin re-ejecutar"
      exit 0
    fi
    echo "stale: el tune de $RUN_ID no tiene evidencia de salida OK → se reintenta"
    cont_write '.state="pending"' || { echo "fail: no se pudo marcar pending"; exit 1; }
    ;;
  started)
    if unit_active; then
      echo "running: el tune de $RUN_ID sigue en curso"
      exit 0
    fi
    if unit_completed_evidence; then
      # Terminó bien en este boot y sólo falló la persistencia: reparar, NO re-ejecutar.
      if ! cont_write --arg at "$(wc_now)" '.state="completed" | .completedAt=$at'; then
        echo "fail: no se pudo persistir la reparación de $RUN_ID; se conserva el registro"
        exit 1
      fi
      rm -f "$CONT_FILE" "$TUNE_ID_FILE" 2>/dev/null
      echo "repaired: $RUN_ID con evidencia de salida OK → reparado sin re-ejecutar"
      exit 0
    fi
    echo "interrupted: el tune de $RUN_ID no tiene evidencia de salida (crash/reboot) → se reencola"
    cont_write '.state="pending"' || { echo "fail: no se pudo marcar pending"; exit 1; }
    ;;
  failed)
    echo "failed: el tune de $RUN_ID falló → se reintenta"
    cont_write '.state="pending"' || { echo "fail: no se pudo marcar pending"; exit 1; }
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
