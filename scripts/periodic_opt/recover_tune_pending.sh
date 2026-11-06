#!/bin/bash
# Recupera la obligación de continuación al tune — revisión 6 (06-nov-2026).
# La usa jarvis-weekly-continuation.timer (sábado 04/06/08/10 CET): si el sello semanal se
# escribió pero el tune no llegó a encolarse (fallo o caída del host), lo reintenta.
# Es idempotente: si el tune ya está activo/en cola, no hace nada.
# Env (para tests): MARK_DIR, TUNE_START_CMD
set -eu
MARK_DIR="${MARK_DIR:-/var/lib/jarvis}"
TUNE_START_CMD="${TUNE_START_CMD:-systemctl start --no-block jarvis-detection-tune.service}"
PEND="$MARK_DIR/weekly_tune_pending"

if [ ! -f "$PEND" ]; then
  echo "no-pending"
  exit 0
fi
WEEK=$(cat "$PEND" 2>/dev/null || echo "")
NOW=$(date -u +%G-W%V)
if [ "$WEEK" != "$NOW" ]; then
  echo "warn: obligación de $WEEK (semana anterior) — se descarta para no repetir el tune"
  rm -f "$PEND"
  exit 0
fi

ST=$(systemctl show -p ActiveState --value jarvis-detection-tune.service 2>/dev/null || echo unknown)
case "$ST" in
  active|activating|reloading)
    echo "tune ya activo ($ST); se limpia la obligación"
    rm -f "$PEND"
    exit 0
    ;;
esac

if $TUNE_START_CMD; then
  rm -f "$PEND"
  echo "recovered: tune encolado para $WEEK"
  exit 0
fi
echo "fail: sigue sin poder encolarse el tune; la obligación queda pendiente"
exit 1
