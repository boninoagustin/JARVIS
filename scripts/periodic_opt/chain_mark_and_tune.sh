#!/bin/bash
# Sello semanal + encolado del tune con IDENTIDAD DE CORRIDA (revisión 7, 06-nov-2026).
#
# Estado durable (weekly_continuation.json): runId, week, state, timestamps, attempts.
#   pending   → encolado solicitado, el tune todavía no registró su inicio
#   started   → el wrapper del tune registró el inicio (consumidor)
#   completed → el wrapper registró el fin correcto
#   failed    → el tune terminó con error
#   expired   → vencida por política (no se re-ejecuta; el digest la reporta)
#
# El registro NO se borra al encolar (un arranque aceptado no es recepción durable):
# lo limpia el recuperador cuando el consumidor registró completed.
#
# Env (tests): CONT_DIR, TUNE_START_CMD
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=weekly_continuation_lib.sh
. "$HERE/weekly_continuation_lib.sh"
MARK_DIR="${MARK_DIR:-$CONT_DIR}"
TUNE_START_CMD="${TUNE_START_CMD:-systemctl start --no-block jarvis-detection-tune.service}"
# Never seal a stale sidecar or infer the week from completion time. The Python
# receipt must bind run identity, original week, full frozen roster and summary SHA.
SUMMARY="${WEEKLY_SUMMARY:-$HERE/opt_out/weekly_selection_summary.json}"
CTX=$(python3 "$HERE/weekly_cycle_state.py" verify --state-dir "$MARK_DIR" --summary "$SUMMARY") || {
  echo 'fail: no se sella ni encola tune sin evidencia válida de optimización'; exit 1;
}
WEEK=$(printf '%s' "$CTX" | jq -r '.week')
RUN_ID=$(printf '%s' "$CTX" | jq -r '.run_id')
CTX_INVOCATION=$(printf '%s' "$CTX" | jq -r '.invocation_id // ""')
if [ -n "${INVOCATION_ID:-}" ] && [ "$CTX_INVOCATION" != "$INVOCATION_ID" ]; then
  echo 'fail: contexto pertenece a otra invocación de systemd'; exit 1
fi
NOW=$(wc_now)
# Do not overwrite a running or unconsumed obligation with a different run.
OLD_ID=$(cont_read '.runId')
OLD_STATE=$(cont_read '.state')
if [ -n "$OLD_ID" ] && [ "$OLD_ID" != "$RUN_ID" ]; then
  case "$OLD_STATE" in completed|expired) ;; *) echo 'fail: continuación anterior todavía pendiente'; exit 1 ;; esac
fi
if [ "$OLD_ID" = "$RUN_ID" ]; then
  case "$OLD_STATE" in
    started|completed) echo "ok: continuación $RUN_ID ya recibida ($OLD_STATE)"; exit 0 ;;
    pending|failed) ;;  # retain the same obligation and retry delivery
    *) echo 'fail: estado de continuación no recuperable'; exit 1 ;;
  esac
fi

mkdir -p "$MARK_DIR" || { echo "fail: no se pudo crear $MARK_DIR"; exit 1; }

persist() { # $1=archivo  $2=valor  $3=etiqueta
  local f="$1" v="$2" label="$3"
  if ! printf '%s\n' "$v" > "$f.tmp" 2>/dev/null; then
    echo "fail: no se pudo escribir $f.tmp ($label)"; return 1
  fi
  if ! mv -f "$f.tmp" "$f" 2>/dev/null; then
    echo "fail: no se pudo renombrar $f ($label)"; return 1
  fi
  if [ "$(cat "$f" 2>/dev/null)" != "$v" ]; then
    echo "fail: readback de $f no coincide ($label)"; return 1
  fi
  return 0
}

# 1) obligación de continuación CON runId (el consumidor la reconoce).
# Re-delivery of the same run must not reset creation time or retry counters.
if [ "$OLD_ID" != "$RUN_ID" ]; then
  cont_write --arg runId "$RUN_ID" --arg week "$WEEK" --arg at "$NOW" \
    '{runId:$runId, week:$week, state:"pending", createdAt:$at, startedAt:null, completedAt:null, attempts:0}' \
    || { echo "fail: no se pudo persistir la obligación de continuación"; exit 1; }
fi

# 2) sello semanal
persist "$MARK_DIR/weekly_cycle_last" "$WEEK" "sello semanal" || exit 1

# 3) identificar la corrida para el consumidor y encolar
persist "$TUNE_ID_FILE" "$RUN_ID" "runId del tune" || exit 1
if $TUNE_START_CMD; then
  # NO se borra el registro: pending hasta que el wrapper del tune marque started.
  echo "ok: semana $WEEK sellada · runId $RUN_ID encolado (pending)"
  exit 0
fi
echo "fail: no se pudo encolar el tune; la obligación queda pending (runId $RUN_ID)"
exit 1
