#!/bin/bash
# Wrapper del tune semanal — consumidor de la obligación de continuación (revisión 7).
# Registra de forma DURABLE: started al comenzar y completed/failed al terminar, ligado al
# runId que dejó el ciclo en tune_run_id. Un tune MANUAL (sin runId) no toca el registro,
# así que no puede "consumir" la obligación semanal por error.
#
# Env (tests): CONT_DIR
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/weekly_continuation_lib.sh"

TUNE_CMD="${TUNE_CMD:-bash /opt/JARVIS/scripts/periodic_opt/run_detection_tune.sh}"
RUN_ID=$(cat "$TUNE_ID_FILE" 2>/dev/null || echo "")
MATCH=0
if [ -n "$RUN_ID" ] && [ "$(cont_read '.runId')" = "$RUN_ID" ]; then
  MATCH=1
fi

if [ "$MATCH" = "1" ]; then
  cont_write --arg at "$(wc_now)" '.state="started" | .startedAt=$at' \
    || echo "warn: no se pudo persistir started (runId $RUN_ID)"
fi

$TUNE_CMD
RC=$?

if [ "$MATCH" = "1" ]; then
  AT=$(wc_now)
  if [ "$RC" -eq 0 ]; then
    # Estado terminal. Si no se puede persistir, se intenta dejar 'stale' (la recuperación
    # repara el registro sin re-ejecutar cuando Result=success); nunca se miente con un warn.
    cont_write --arg at "$AT" '.state="completed" | .completedAt=$at' \
      || cont_write --arg at "$AT" '.state="stale" | .note="completed-write-failed" | .completedAt=$at' \
      || echo "warn: no se pudo persistir el estado terminal (runId $RUN_ID) — la recuperación lo repara por Result"
  else
    cont_write --arg at "$AT" '.state="failed" | .completedAt=$at' \
      || cont_write --arg at "$AT" '.state="stale" | .note="failed-write-failed" | .completedAt=$at' \
      || echo "warn: no se pudo persistir el estado terminal (runId $RUN_ID)"
  fi
  rm -f "$TUNE_ID_FILE" 2>/dev/null || true
fi

exit "$RC"
