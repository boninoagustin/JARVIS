#!/bin/bash
# Health de detección de TODO el pool (todos los tickers con history/): evalúa el baseline
# actual de cada uno y escribe Firestore detection_health/{ticker} (lo lee el panel).
# Sin búsqueda (rápido, ~30-60s/ticker) — la optimización va a demanda vía el panel/Kronos.
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS

exec 9>"/tmp/detection_health.lock"
flock 9

BOTPID=$(pm2 pid JARVIS 2>/dev/null)
if [ -n "$BOTPID" ]; then
  echo -1000 > "/proc/$BOTPID/oom_score_adj" 2>/dev/null
fi

# Pool = todos los directorios de logs/ con history (excluye test/tickerfake).
# HEALTH_POOL permite acotarlo en tests.
POOL="${HEALTH_POOL:-}"
if [ -z "$POOL" ]; then
  for d in logs/*/history; do
    t=$(basename "$(dirname "$d")")
    case "$t" in test|tickerfake) continue;; esac
    [ -f "$d/history_M15.csv" ] && POOL="$POOL ${t^^}"
  done
fi
echo "Pool de salud:$(echo "$POOL" | tr ' ' '\n' | sort | tr '\n' ' ')"

ERRLOG="${HEALTH_ERRLOG:-/tmp/detection_health_errors.log}"
# HEALTH_CMD permite inyectar un comando falso en tests (sin Firestore ni velas).
HEALTH_CMD="${HEALTH_CMD:-npx tsx scripts/periodic_opt/smc_detection_search.ts}"
# H07: si algún activo no deja HEALTH_SAVED (Firestore caído, OOM, sin resultado), el job
# termina != 0 para que systemd NO dispare las propuestas (risk/shutdown/roster --write).
FAILED=0
for t in $POOL; do
  echo "=== $(date +%H:%M:%S) HEALTH $t ==="
  # 03-nov-2026: el stderr iba a /dev/null y un OOM por activo (AUDCAD) quedaba
  # invisible: el panel mostraba SIN_DATOS sin explicación. Ahora se guarda por activo
  # y, si no hubo HEALTH_, queda un HEALTH_FAIL en el resumen.
  OUT=$(NODE_OPTIONS="--max-old-space-size=2560" $HEALTH_CMD "$t" health 0 2>>"$ERRLOG")
  RC=$?
  echo "$OUT" | grep -a "HEALTH_"
  if [ "$RC" -ne 0 ] || ! echo "$OUT" | grep -qa "HEALTH_SAVED"; then
    echo "HEALTH_FAIL $t (rc=$RC; ver $ERRLOG)"
    echo "--- $t $(date +%H:%M:%S) rc=$RC ---" >> "$ERRLOG"
    FAILED=$((FAILED+1))
  fi
done
echo "=== $(date +%H:%M:%S) FIN health-all (fallos: $FAILED) ==="
if [ "$FAILED" -gt 0 ]; then
  echo "HEALTH_JOB_FAILED: $FAILED activo(s) sin health persistido — no se ejecutan propuestas"
  exit 1
fi
exit 0
