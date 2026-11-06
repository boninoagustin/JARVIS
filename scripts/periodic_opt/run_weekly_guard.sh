#!/bin/bash
# Guarda del ciclo semanal de optimización — D1-b (2ª revisión, 06-nov-2026).
#
# Problema que resuelve: el timer del ciclo seguía activo por su cuenta, así que si el
# Asset Scout tardaba >30 min el ciclo arrancaba en paralelo. Además no había deduplicación
# semanal: dos disparadores podían iniciar dos corridas.
#
# Reglas:
#   1) Espera a que el Asset Scout termine (máx 3 h) para no solaparlo.
#   2) flock NO bloqueante: si otro wrapper ya está corriendo, éste sale (0).
#   3) Marca semanal ISO (YYYY-Www) en /var/lib/jarvis: si el ciclo ya corrió esta semana,
#      no vuelve a correr.
#   4) La marca se escribe SÓLO si run_weekly terminó con éxito.
#
# Uso:
#   run_weekly_guard.sh            # ejecuta el ciclo (con las guardas)
#   run_weekly_guard.sh --check    # sólo informa qué haría (para tests)
#   run_weekly_guard.sh --force    # ignora la marca semanal (operador)
set -u
REPO=/opt/JARVIS
MARK_DIR=/var/lib/jarvis
MARK="$MARK_DIR/weekly_cycle_last"
LOCK=/tmp/jarvis_weekly_cycle.lock
KEEPALIVE_FILE="$MARK_DIR/weekly_cycle_keepalive"
CHECK=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
  esac
done

WEEK=$(date -u +%G-W%V)
mkdir -p "$MARK_DIR"

check_only() { echo "$1"; [ "$CHECK" = "1" ] && exit 0 || true; }

# 1) ¿ya corrió esta semana?
if [ "$FORCE" != "1" ] && [ -f "$MARK" ] && [ "$(cat "$MARK" 2>/dev/null)" = "$WEEK" ]; then
  echo "skip: el ciclo ya corrió esta semana ($WEEK)"
  exit 0
fi

# 2) esperar a que termine el Asset Scout (máx 3 h)
WAITED=0
while systemctl is-active --quiet jarvis-asset-scout.service 2>/dev/null; do
  if [ "$WAITED" -ge 360 ]; then
    echo "abort: el Asset Scout sigue activo tras 3 h; no se solapa el ciclo"
    exit 1
  fi
  sleep 30
  WAITED=$((WAITED+30))
done

# 3) flock no bloqueante (si otro wrapper corre, salir)
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "skip: otro ciclo ya está en ejecución (lock ocupado)"
  exit 0
fi

# re-chequear la marca después de tomar el lock (otro pudo terminar mientras esperábamos)
if [ "$FORCE" != "1" ] && [ -f "$MARK" ] && [ "$(cat "$MARK" 2>/dev/null)" = "$WEEK" ]; then
  echo "skip: el ciclo ya corrió esta semana ($WEEK)"
  exit 0
fi

if [ "$CHECK" = "1" ]; then
  echo "would-run: semana $WEEK (scout inactivo, lock libre, sin marca)"
  exit 0
fi

echo "run: ciclo semanal $WEEK (espera scout ${WAITED}s)"
cd "$REPO" || exit 1
# keepalive: permite a un monitor distinguir "corriendo" de "colgado" por la fecha del archivo
touch "$KEEPALIVE_FILE"
/usr/bin/python3 "$REPO/scripts/periodic_opt/run_weekly.py"
RC=$?
if [ "$RC" -eq 0 ]; then
  echo "$WEEK" > "$MARK"
  echo "done: ciclo $WEEK completado"
else
  echo "fail: ciclo $WEEK terminó con código $RC (no se marca la semana)"
fi
exit "$RC"
