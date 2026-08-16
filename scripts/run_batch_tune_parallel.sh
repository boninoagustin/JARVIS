#!/usr/bin/env bash
# run_batch_tune_parallel.sh — tuneo per-gatillo de los 9 activos, 4 en paralelo (un core cada uno).
# Cada activo corre con --concurrency 1 (single-threaded) y el SO lo reparte en un core distinto.
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS
LOG=/opt/JARVIS/backups/batch_tune.log
exec >> "$LOG" 2>&1
echo "=== START (parallel x4) $(date) ==="

ASSETS=(AUDCAD BTCUSD EURUSD GBPUSD NZDUSD US500 USDCAD USDJPY USOIL)

run_asset() {
  local t="$1"
  echo "═══ START $t $(date) ═══"
  npx tsx scripts/per_trigger_tune.ts "$t" --budget 200 --concurrency 1 --save "backups/${t}_tuned.json" 2>&1
  echo "─── DONE $t exit=$? $(date) ───"
}

for t in "${ASSETS[@]}"; do
  run_asset "$t" &
  if [ "$(jobs -r | wc -l)" -ge 4 ]; then
    wait -n
  fi
done
wait
echo "=== ALL 9 DONE $(date) ==="
