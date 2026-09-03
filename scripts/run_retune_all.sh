#!/bin/bash
# Re-optimización de los 10 activos con el motor SMC corregido (gates anti-whipsaw).
# 4 procesos en paralelo (--concurrency 1 = single-thread por proceso → 4 cores).
# budget 200 por gatillo (recomendado: ~4-5h/activo). Escribe a Firestore + backup JSON.
cd /opt/JARVIS
export PATH="/home/bon/.local/bin:$PATH"
TICKERS=(EURUSD GBPUSD AUDCAD US500 XAUUSD USDJPY NZDUSD GBPJPY AUDJPY GER40)

run_one() {
  local t="$1"
  echo "START $t $(date +%F_%T)" >> logs/retune_all.log
  npx tsx scripts/per_trigger_tune.ts "$t" --budget 200 --concurrency 1 \
    --save "backups/${t}_tuned_$(date +%Y%m%d).json" >> "logs/${t}_tune.log" 2>&1
  echo "DONE  $t $(date +%F_%T) (exit $?)" >> logs/retune_all.log
}
export -f run_one

printf '%s\n' "${TICKERS[@]}" | xargs -P4 -I{} bash -c 'run_one "$@"' _ {}
echo "ALL_DONE $(date +%F_%T)" >> logs/retune_all.log
