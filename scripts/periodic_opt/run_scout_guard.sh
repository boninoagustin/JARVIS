#!/bin/bash
# Guarda del Asset Scout semanal — evita solapamiento destructivo con el ciclo semanal.
#
# Causa raíz corregida (W48 / EURCHF):
#   jarvis-periodic-opt esperaba al scout, pero jarvis-asset-scout NO verificaba si
#   periodic-opt, detection-tune o health-weekly estaban corriendo ni si había un ciclo
#   semanal inconcluso en /var/lib/jarvis/weekly_cycle_context.json. Además, usar
#   OnSuccess=jarvis-periodic-opt.service en systemd disparaba periodic-opt incluso
#   cuando una unidad se omitía por ExecCondition.
#
# Modos:
#   --condition            : ExecCondition=. Sale 0 sólo si ningún job del ciclo corre,
#                            el lock semanal está libre y no hay ciclo inconcluso.
#   --run [--chain-opt]    : ExecStart=. Toma lock propio, revalida exclusión, ejecuta
#                            asset_scout.ts y (sólo si --chain-opt y rc==0) dispara
#                            jarvis-periodic-opt.service sin usar OnSuccess=.
#   --check                : Diagnóstico sin efectos secundarios.
set -u

REPO="${REPO:-/opt/JARVIS}"
MARK_DIR="${MARK_DIR:-/var/lib/jarvis}"
WEEKLY_LOCK="${WEEKLY_LOCK:-/tmp/jarvis_weekly_cycle.lock}"
SCOUT_LOCK="${SCOUT_LOCK:-/tmp/jarvis_asset_scout.lock}"
STATE_HELPER="$REPO/scripts/periodic_opt/weekly_cycle_state.py"
SUMMARY="${WEEKLY_SUMMARY:-$REPO/scripts/periodic_opt/opt_out/weekly_selection_summary.json}"
PROGRESS="${WEEKLY_PROGRESS:-$REPO/scripts/periodic_opt/opt_out/weekly_progress.json}"
SCOUT_CMD="${SCOUT_CMD:-/root/.nvm/versions/node/v24.19.0/bin/npx tsx $REPO/scripts/asset_scout.ts}"
CHAIN_OPT_CMD="${CHAIN_OPT_CMD:-systemctl start --no-block jarvis-periodic-opt.service}"

MODE=--run
CHAIN_OPT=0
EXTRA_ARGS=()
for a in "$@"; do
  case "$a" in
    --condition|--check|--run) MODE="$a" ;;
    --chain-opt) CHAIN_OPT=1 ;;
    *) EXTRA_ARGS+=("$a") ;;
  esac
done

unit_state() {
  local unit="$1"
  local var_name
  var_name="UNIT_STATE_OVERRIDE_$(echo "$unit" | tr 'a-z.-' 'A-Z__')"
  if [ -n "${!var_name:-}" ]; then
    echo "${!var_name}"
    return 0
  fi
  if [ -n "${CYCLE_UNITS_STATE_OVERRIDE:-}" ]; then
    echo "$CYCLE_UNITS_STATE_OVERRIDE"
    return 0
  fi
  local st
  if ! st=$(systemctl show -p ActiveState --value "$unit" 2>/dev/null); then
    echo "unknown"
    return 0
  fi
  [ -z "$st" ] && st="unknown"
  echo "$st"
}

any_cycle_unit_busy() {
  local u st
  for u in jarvis-periodic-opt.service jarvis-detection-tune.service jarvis-health-weekly.service; do
    st=$(unit_state "$u")
    case "$st" in
      active|activating|reloading|deactivating|unknown)
        BUSY_REASON="unidad $u en estado $st"
        return 0
        ;;
    esac
  done
  return 1
}

weekly_lock_busy() {
  exec 7>"$WEEKLY_LOCK"
  if ! flock -n 7; then
    exec 7>&-
    return 0
  fi
  exec 7>&-
  return 1
}

cycle_state_blocks_scout() {
  local week plan action
  week=$(date -u +%G-W%V)
  mkdir -p "$MARK_DIR"
  if ! plan=$(python3 "$STATE_HELPER" plan --state-dir "$MARK_DIR" --summary "$SUMMARY" --progress "$PROGRESS" --week "$week" 2>/dev/null); then
    STATE_BLOCK_REASON="evidencia de ciclo semanal inválida (requiere inspección)"
    return 0
  fi
  action=$(printf '%s' "$plan" | jq -r '.action')
  case "$action" in
    new|skip) return 1 ;;
    *)
      STATE_BLOCK_REASON="ciclo semanal inconcluso (plan=$action)"
      return 0
      ;;
  esac
}

BUSY_REASON=""
STATE_BLOCK_REASON=""

case "$MODE" in
  --condition)
    if any_cycle_unit_busy; then echo "skip: $BUSY_REASON"; exit 1; fi
    if weekly_lock_busy; then echo "skip: lock del ciclo semanal ocupado"; exit 1; fi
    if cycle_state_blocks_scout; then echo "skip: $STATE_BLOCK_REASON"; exit 1; fi
    exec 8>"$SCOUT_LOCK"
    if ! flock -n 8; then echo "skip: asset-scout ya está corriendo"; exit 1; fi
    echo "run-ok: asset-scout habilitado (sin ciclo activo ni recuperación pendiente)"
    exit 0
    ;;
  --check)
    echo "periodic-opt: $(unit_state jarvis-periodic-opt.service)"
    echo "detection-tune: $(unit_state jarvis-detection-tune.service)"
    echo "health-weekly: $(unit_state jarvis-health-weekly.service)"
    if any_cycle_unit_busy; then echo "decisión: skip ($BUSY_REASON)"; exit 0; fi
    if weekly_lock_busy; then echo "decisión: skip (lock semanal ocupado)"; exit 0; fi
    if cycle_state_blocks_scout; then echo "decisión: skip ($STATE_BLOCK_REASON)"; exit 0; fi
    echo "decisión: correría"
    exit 0
    ;;
esac

# --run
exec 9>"$SCOUT_LOCK"
if ! flock -n 9; then
  echo "skip: otro asset-scout tiene el lock"
  exit 1
fi

if any_cycle_unit_busy; then
  echo "abort: $BUSY_REASON"
  exit 1
fi
if weekly_lock_busy; then
  echo "abort: lock del ciclo semanal ocupado"
  exit 1
fi
if cycle_state_blocks_scout; then
  echo "abort: $STATE_BLOCK_REASON"
  exit 1
fi

cd "$REPO" || exit 1
$SCOUT_CMD "${EXTRA_ARGS[@]}"
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "fail: asset_scout terminó con código $RC"
  exit "$RC"
fi

if [ "$CHAIN_OPT" = "1" ]; then
  if ! $CHAIN_OPT_CMD; then
    echo "fail: asset_scout completó pero no pudo iniciar jarvis-periodic-opt.service"
    exit 1
  fi
  echo "ok: asset_scout completado y jarvis-periodic-opt.service disparado"
fi
exit 0
