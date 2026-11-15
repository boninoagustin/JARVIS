#!/bin/bash
# Guarda del ciclo semanal de optimización — v2 (revisión 4, 06-nov-2026).
#
# Problema: con Type=oneshot el scout está en "activating" mientras trabaja y
# `systemctl is-active` NO lo considera activo → el wrapper arrancaba el ciclo en paralelo.
# Además, un "skip" con exit 0 hacía que systemd ejecutara los ExecStartPost y OnSuccess.
#
# Diseño:
#   --condition : lo usa ExecCondition=. Devuelve 0 si el ciclo DEBE correr; !=0 si debe
#                 omitirse (marca semanal, scout trabajando, lock ocupado). Un ExecCondition
#                 fallido hace que systemd OMITA la unidad: no corre ExecStart, ni
#                 ExecStartPost, ni OnSuccess. Es la deduplicación completa, no sólo de Python.
#   --run       : lo usa ExecStart=. Espera al scout con detección real de estados, toma el
#                 lock y ejecuta run_weekly.py. Si el lock se ocupa en la carrera, falla
#                 cerrado (exit 1) para no ejecutar postprocesos de un ciclo ajeno.
#   --check     : modo humano/test: imprime la decisión sin ejecutar nada.
#   --force     : ignora la marca semanal (operador).
#
# Estados del scout: active|activating|reloading|deactivating → se considera "trabajando".
# Si systemd no responde (error/estado desconocido) → FAIL CLOSED (se asume trabajando).
set -u
REPO=/opt/JARVIS
MARK_DIR=/var/lib/jarvis
MARK="$MARK_DIR/weekly_cycle_last"
LOCK=/tmp/jarvis_weekly_cycle.lock
# Revisión 5: si Python terminó OK pero un post falló, el reintento NO repite la optimización.
PYDONE_DIR=/var/lib/jarvis
SCOUT_UNIT=jarvis-asset-scout.service
SCOUT_WAIT_MAX_SEC=$((3 * 3600))   # 3 h (antes el contador daba 6 min por error de unidades)

MODE=--run
FORCE=0
for a in "$@"; do
  case "$a" in
    --condition|--check) MODE="$a" ;;
    --run) MODE=--run ;;
    --force) FORCE=1 ;;
  esac
done

WEEK=$(date -u +%G-W%V)
mkdir -p "$MARK_DIR"

mark_is_current() {
  [ "$FORCE" = "1" ] && return 1
  [ -f "$MARK" ] && [ "$(cat "$MARK" 2>/dev/null)" = "$WEEK" ]
}

# Estado del scout. Override para tests: SCOUT_STATE_OVERRIDE=activating
scout_state() {
  if [ -n "${SCOUT_STATE_OVERRIDE:-}" ]; then echo "$SCOUT_STATE_OVERRIDE"; return 0; fi
  local st
  if ! st=$(systemctl show -p ActiveState --value "$SCOUT_UNIT" 2>/dev/null); then
    echo "unknown"; return 0
  fi
  [ -z "$st" ] && st="unknown"
  echo "$st"
}
scout_is_running() {
  local st; st=$(scout_state)
  case "$st" in
    active|activating|reloading|deactivating) return 0 ;;
    unknown) return 0 ;;   # fail closed
    *) return 1 ;;
  esac
}

case "$MODE" in
  --condition)
    if mark_is_current; then echo "skip: ya corrió la semana $WEEK"; exit 1; fi
    if scout_is_running; then echo "skip: scout trabajando ($(scout_state))"; exit 1; fi
    exec 8>"$LOCK"
    if ! flock -n 8; then echo "skip: lock del ciclo ocupado"; exit 1; fi
    echo "run-ok: semana $WEEK (marca libre, scout inactivo, lock libre)"
    exit 0
    ;;
  --check)
    echo "semana: $WEEK"
    echo "marca: $( [ -f "$MARK" ] && cat "$MARK" 2>/dev/null || echo '(ninguna)' )$( [ "$FORCE" = "1" ] && echo ' (ignorada por --force)' )"
    echo "scout: $(scout_state)"
    echo "lock: $( cmp -s /dev/null /dev/null && ( exec 8>"$LOCK"; if flock -n 8; then echo libre; else echo ocupado; fi ) )"
    if mark_is_current; then echo "decisión: skip (marca)"; else
      if scout_is_running; then echo "decisión: esperaría al scout"; else echo "decisión: correría"; fi
    fi
    exit 0
    ;;
esac

# ── --run ──
if mark_is_current; then
  echo "skip: ya corrió la semana $WEEK"
  exit 0
fi

START=$SECONDS
while scout_is_running; do
  if [ $((SECONDS - START)) -ge "$SCOUT_WAIT_MAX_SEC" ]; then
    echo "abort: el scout sigue trabajando tras $((SCOUT_WAIT_MAX_SEC/3600)) h; no se solapa"
    exit 1
  fi
  sleep 30
done

exec 9>"$LOCK"
if ! flock -n 9; then
  # Carrera con otro wrapper: no ejecutamos Python NI postprocesos de un ciclo ajeno.
  echo "abort: otro ciclo tomó el lock durante la carrera; se omite esta corrida"
  exit 1
fi

if mark_is_current; then
  echo "skip: ya corrió la semana $WEEK"
  exit 0
fi

# Reintento tras fallo de un post: la optimización de esta semana ya está hecha.
PYDONE="$PYDONE_DIR/weekly_python_done_$WEEK"
if [ -f "$PYDONE" ]; then
  echo "retry: la optimización de $WEEK ya terminó; se re-ejecutan sólo los postprocesos"
  ls -1t "$PYDONE_DIR"/weekly_python_done_* 2>/dev/null | tail -n +3 | xargs -r rm -f
  exit 0
fi

echo "run: ciclo semanal $WEEK (espera scout $((SECONDS - START))s)"
cd "$REPO" || exit 1
# Atribución de semana (fix 15-nov-2026): el sello debe corresponder a la semana en
# la que ARRANCÓ el ciclo, no a la de finalización. Un ciclo largo que cruza el lunes
# 00:00 UTC marcaba la semana siguiente y consumía su cupo (el ciclo W45 selló W46 el
# 9-nov, dejando sin turno al viernes 13).
if ! printf '%s\n' "$WEEK" > "$MARK_DIR/weekly_cycle_week.tmp" 2>/dev/null \
   || ! mv -f "$MARK_DIR/weekly_cycle_week.tmp" "$MARK_DIR/weekly_cycle_week" 2>/dev/null \
   || [ "$(cat "$MARK_DIR/weekly_cycle_week" 2>/dev/null)" != "$WEEK" ]; then
  echo "fail: no se pudo persistir la semana de inicio del ciclo ($WEEK)"
  exit 1
fi
touch "$MARK_DIR/weekly_cycle_keepalive"
/usr/bin/python3 "$REPO/scripts/periodic_opt/run_weekly.py"
RC=$?
if [ "$RC" -eq 0 ]; then
  # La marca semanal NO se escribe acá: la escribe el último ExecStartPost (mark_weekly_done.sh)
  # cuando TODA la unidad terminó bien. Acá sólo se registra que la OPTIMIZACIÓN terminó, para
  # que un reintento por fallo de un post no repita las 20 h del ciclo.
  # Persistencia del checkpoint PYDONE: si no se puede escribir, el ciclo FALLA (no se puede
  # certificar que la optimización terminó → un reintento la repetirá, que es lo seguro).
  if ! touch "$PYDONE" 2>/dev/null || [ ! -f "$PYDONE" ]; then
    echo "fail: no se pudo persistir el checkpoint PYDONE ($PYDONE) — ciclo NO certificado"
    exit 1
  fi
  echo "done-python: ciclo $WEEK (optimización terminada; marca final en el último ExecStartPost)"
else
  echo "fail: ciclo $WEEK terminó con código $RC (no se marca la semana)"
fi
exit "$RC"
