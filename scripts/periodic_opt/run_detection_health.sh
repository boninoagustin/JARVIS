#!/bin/bash
# Health de detección de TODO el pool (todos los tickers con history/): evalúa el baseline
# actual de cada uno y escribe Firestore detection_health/{ticker} (lo lee el panel).
# Sin búsqueda (rápido, ~30-60s/ticker) — la optimización va a demanda vía el panel/Kronos.
export PATH="/home/bon/.nvm/versions/node/v24.18.0/bin:$PATH"
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

for t in $POOL; do
  echo "=== $(date +%H:%M:%S) HEALTH $t ==="
  NODE_OPTIONS="--max-old-space-size=2560" npx tsx scripts/periodic_opt/smc_detection_search.ts "$t" health 0 2>/dev/null | grep -a "HEALTH_"
done
echo "=== $(date +%H:%M:%S) FIN health-all ==="
