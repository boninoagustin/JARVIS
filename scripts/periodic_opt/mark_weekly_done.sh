#!/bin/bash
# Marca la semana como COMPLETADA — sólo se ejecuta como último ExecStartPost del ciclo.
# Revisión 5 (06-nov-2026): antes la marca la escribía el guard cuando terminaba Python,
# pero los pasos obligatorios (push_reports, ml, evals) corren DESPUÉS: si uno fallaba, la
# unidad fallaba pero la marca quedaba y el reintento se omitía. Ahora la marca es el sello
# de la unidad completa (systemd omite los post restantes ante un fallo).
set -u
MARK_DIR=/var/lib/jarvis
mkdir -p "$MARK_DIR"
WEEK=$(date -u +%G-W%V)
echo "$WEEK" > "$MARK_DIR/weekly_cycle_last"
echo "mark: semana $WEEK completada (unidad terminada con éxito)"
