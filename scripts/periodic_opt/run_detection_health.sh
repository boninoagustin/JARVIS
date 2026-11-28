#!/bin/bash
# Health de detección de TODO el pool (active_tickers ∪ logs/*/history): evalúa el baseline
# actual de cada uno y escribe Firestore detection_health/{ticker} (lo lee el panel).
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS || exit 1

exec 9>"/tmp/detection_health.lock"
flock 9

BOTPID=$(pm2 pid JARVIS 2>/dev/null)
if [ -n "$BOTPID" ]; then
  echo -1000 > "/proc/$BOTPID/oom_score_adj" 2>/dev/null
fi

DEFAULT_HEALTH_CMD="npx tsx scripts/periodic_opt/smc_detection_search.ts"
HEALTH_CMD="${HEALTH_CMD:-$DEFAULT_HEALTH_CMD}"

POOL="${HEALTH_POOL:-}"
if [ -z "$POOL" ]; then
  POOL_TMP=""
  for d in logs/*/history; do
    t=$(basename "$(dirname "$d")")
    case "$t" in test|tickerfake|_scout) continue ;; esac
    [ -f "$d/history_M15.csv" ] && POOL_TMP="$POOL_TMP ${t^^}"
  done
  ACTIVE_JSON=$(npx tsx scripts/periodic_opt/get_active_tickers.ts 2>/dev/null || echo "")
  ACTIVE_LIST=$(printf '%s\n' "$ACTIVE_JSON" | jq -r '.tickers[]? // empty' 2>/dev/null || echo "")
  POOL=$(printf '%s\n%s\n' $POOL_TMP $ACTIVE_LIST | awk 'NF && !seen[$0]++' | sort | tr '\n' ' ')
fi
echo "Pool de salud:$(echo "$POOL" | tr ' ' '\n' | awk 'NF' | sort | tr '\n' ' ')"

ERRLOG="${HEALTH_ERRLOG:-/tmp/detection_health_errors.log}"
FAILED=0
for t in $POOL; do
  echo "=== $(date +%H:%M:%S) HEALTH $t ==="
  if [ "$HEALTH_CMD" = "$DEFAULT_HEALTH_CMD" ]; then
    H_M15="logs/${t,,}/history/history_M15.csv"
    if [ ! -s "$H_M15" ] || [ "$(wc -l < "$H_M15" 2>/dev/null || echo 0)" -lt 2 ]; then
      echo "HEALTH_FAIL $t (sin $H_M15 válido; ver $ERRLOG)"
      echo "--- $t $(date +%H:%M:%S) missing_or_empty $H_M15 ---" >> "$ERRLOG"
      FAILED=$((FAILED+1))
      continue
    fi
  fi
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
