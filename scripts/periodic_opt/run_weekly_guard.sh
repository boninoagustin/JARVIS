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
REPO="${REPO:-/opt/JARVIS}"
MARK_DIR="${MARK_DIR:-/var/lib/jarvis}"
MARK="$MARK_DIR/weekly_cycle_last"
LOCK="${WEEKLY_LOCK:-/tmp/jarvis_weekly_cycle.lock}"
STATE_HELPER="$REPO/scripts/periodic_opt/weekly_cycle_state.py"
SUMMARY="$REPO/scripts/periodic_opt/opt_out/weekly_selection_summary.json"
PROGRESS="$REPO/scripts/periodic_opt/opt_out/weekly_progress.json"
state_args=(--state-dir "$MARK_DIR" --summary "$SUMMARY" --progress "$PROGRESS")
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

# Only a context + exact receipt + completed summary can deduplicate a cycle.
# An empty legacy PYDONE or a sidecar week is never completion evidence.
PLAN_FORCE=()
[ "$FORCE" = "1" ] && PLAN_FORCE=(--force)
if ! PLAN=$(python3 "$STATE_HELPER" plan "${state_args[@]}" --week "$WEEK" "${PLAN_FORCE[@]}"); then
  # ExecCondition rc=1 means a harmless skip to systemd. Invalid evidence must instead
  # reach ExecStart and fail there, so OnFailure notifies rather than silently skipping.
  if [ "$MODE" = "--condition" ]; then
    echo 'run-required: evidencia inválida; ExecStart fallará cerrado y notificará'
    exit 0
  fi
  exit 1
fi
PLAN_ACTION=$(printf '%s' "$PLAN" | jq -r '.action')
mark_is_current() { [ "$PLAN_ACTION" = "skip" ]; }

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
  echo "skip: ciclo $WEEK ya certificado; postprocesos bloqueados en ExecStart"
  exit 1
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
  echo "skip: ciclo $WEEK ya certificado; postprocesos bloqueados en ExecStart"
  exit 1
fi

cd "$REPO" || exit 1
# Require the actual roster, never the loader's fallback, and freeze it in the context.
if [ -n "${WEEKLY_ROSTER_JSON:-}" ]; then
  ROSTER_JSON="$WEEKLY_ROSTER_JSON"  # isolated regression fixtures
else
  ROSTER_DOC=$(npx tsx "$REPO/scripts/periodic_opt/get_active_tickers.ts") || exit 1
  ROSTER_JSON=$(printf '%s' "$ROSTER_DOC" | jq -ce 'select(.source == "firestore") | .tickers') || {
    echo 'fail: no se pudo verificar el roster Firestore'; exit 1;
  }
fi
BEGIN=$(python3 "$STATE_HELPER" begin "${state_args[@]}" --week "$WEEK" --tickers-json "$ROSTER_JSON" "${PLAN_FORCE[@]}") || exit 1
ACTION=$(printf '%s' "$BEGIN" | jq -r '.action')
[ "$ACTION" = "skip" ] && { echo 'skip: ciclo certificado durante la carrera; postprocesos bloqueados'; exit 1; }
export JARVIS_WEEKLY_CONTEXT="$MARK_DIR/weekly_cycle_context.json"
WEEK=$(printf '%s' "$BEGIN" | jq -r '.context.week')
RUN_ID=$(printf '%s' "$BEGIN" | jq -r '.context.run_id')
# Digest binds to the last actual ExecStart context, not a later harmless condition skip.
echo "cycle-context: run=$RUN_ID week=$WEEK invocation=${INVOCATION_ID:-}"
# Compatibility sidecar only; no consumer may use it as proof.
printf '%s\n' "$WEEK" > "$MARK_DIR/weekly_cycle_week" || exit 1
if [ "$ACTION" = "posts" ]; then
  echo "retry: evidencia verificada de $WEEK; sólo postprocesos (misma identidad)"
  exit 0
fi
RESUME_ARGS=()
[ "$ACTION" = "resume" ] && RESUME_ARGS=(--resume)
FROZEN_TICKERS=$(printf '%s' "$BEGIN" | jq -r '.context.tickers | join(",")')
echo "run: ciclo semanal $WEEK ($ACTION, espera scout $((SECONDS - START))s)"
touch "$MARK_DIR/weekly_cycle_keepalive"
"${WEEKLY_PYTHON:-/usr/bin/python3}" "$REPO/scripts/periodic_opt/run_weekly.py" --tickers "$FROZEN_TICKERS" "${RESUME_ARGS[@]}"
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "fail: ciclo $WEEK terminó con código $RC (sin recibo ni sello)"
  exit "$RC"
fi
python3 "$STATE_HELPER" complete "${state_args[@]}" || {
  echo 'fail: Python salió 0 pero el ciclo no acredita resultados completos'; exit 1;
}
echo "done-python: ciclo $WEEK con recibo de identidad + resumen SHA256 verificados"
exit 0
