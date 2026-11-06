#!/bin/bash
# Sello semanal + obligación de continuación al tune — revisión 6 (06-nov-2026).
#
# Hallazgos que corrige (revisión 5 de auditoría):
#  1) la marca se escribía sin comprobar errores y el paso estaba prefijado con '-'
#     (systemd ignoraba el fallo): se podía anunciar éxito sin checkpoint.
#  2) se sellaba la semana ANTES de encolar el tune: si el encolado fallaba o el host caía
#     entre ambos pasos, la continuación se perdía (el ciclo ya no vuelve a correr esa semana).
#
# Diseño:
#  1. Escribe la OBLIGACIÓN de continuación (atomic: tmp + mv + readback).
#  2. Escribe el SELLO semanal (atomic + readback).
#  3. Encola el tune. Si falla, la obligación queda y un timer de recuperación la retoma.
#  4. Si el encolado funciona, borra la obligación.
# Cualquier fallo de persistencia → exit != 0 (la unidad falla y NO se anuncia éxito).
#
# Env (para tests): MARK_DIR, TUNE_START_CMD
set -eu
MARK_DIR="${MARK_DIR:-/var/lib/jarvis}"
TUNE_START_CMD="${TUNE_START_CMD:-systemctl start --no-block jarvis-detection-tune.service}"
WEEK=$(date -u +%G-W%V)

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

# 1) obligación de continuación
persist "$MARK_DIR/weekly_tune_pending" "$WEEK" "continuación" || exit 1
# 2) sello semanal
persist "$MARK_DIR/weekly_cycle_last" "$WEEK" "sello semanal" || exit 1

# 3) encolar el tune
if $TUNE_START_CMD; then
  rm -f "$MARK_DIR/weekly_tune_pending"
  echo "ok: semana $WEEK sellada y tune encolado"
  exit 0
fi
echo "fail: no se pudo encolar el tune; la obligación queda pendiente (timer de recuperación)"
exit 1
