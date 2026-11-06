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

# Pool = todos los directorios de logs/ con history (excluye test/tickerfake)
POOL=""
for d in logs/*/history; do
  t=$(basename "$(dirname "$d")")
  case "$t" in test|tickerfake) continue;; esac
  [ -f "$d/history_M15.csv" ] && POOL="$POOL ${t^^}"
done
echo "Pool de salud:$(echo "$POOL" | tr ' ' '\n' | sort | tr '\n' ' ')"

ERRLOG="/tmp/detection_health_errors.log"
for t in $POOL; do
  echo "=== $(date +%H:%M:%S) HEALTH $t ==="
  # 03-nov-2026: el stderr iba a /dev/null y un OOM por activo (AUDCAD) quedaba
  # invisible: el panel mostraba SIN_DATOS sin explicación. Ahora se guarda por activo
  # y, si no hubo HEALTH_, queda un HEALTH_FAIL en el resumen.
  OUT=$(NODE_OPTIONS="--max-old-space-size=2560" npx tsx scripts/periodic_opt/smc_detection_search.ts "$t" health 0 2>>"$ERRLOG")
  echo "$OUT" | grep -a "HEALTH_"
  if ! echo "$OUT" | grep -qa "HEALTH_"; then
    echo "HEALTH_FAIL $t (sin resultado; ver $ERRLOG)"
    echo "--- $t $(date +%H:%M:%S) ---" >> "$ERRLOG"
  fi
done
echo "=== $(date +%H:%M:%S) FIN health-all ==="
