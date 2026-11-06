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
  if [ "$RC" -eq 0 ]; then
    cont_write --arg at "$(wc_now)" '.state="completed" | .completedAt=$at' \
      || echo "warn: no se pudo persistir completed (runId $RUN_ID)"
  else
    cont_write --arg at "$(wc_now)" '.state="failed" | .completedAt=$at' \
      || echo "warn: no se pudo persistir failed (runId $RUN_ID)"
  fi
  rm -f "$TUNE_ID_FILE" 2>/dev/null || true
fi

exit "$RC"
