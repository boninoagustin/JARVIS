#!/bin/bash
# Re-optimización de JP225 (Nikkei 225) — pipeline completo en un solo activo.
cd /opt/JARVIS
export PATH="/home/bon/.local/bin:$PATH"
LOG="logs/retune_jp225.log"

echo "JP225_RETUNE_START $(date +%F_%T)" >> "$LOG"

echo "JP225 STEP1_tune START $(date +%F_%T)" >> "$LOG"
npx tsx scripts/per_trigger_tune.ts JP225 --budget 200 --concurrency 1 \
  --save "backups/JP225_tuned_$(date +%Y%m%d).json" >> logs/JP225_tune.log 2>&1
echo "JP225 STEP1_tune DONE $(date +%F_%T) (exit $?)" >> "$LOG"

echo "JP225 STEP2_disable_losers START $(date +%F_%T)" >> "$LOG"
npx tsx scripts/disable_losers.ts JP225 >> logs/JP225_disable_losers.log 2>&1
echo "JP225 STEP2_disable_losers DONE $(date +%F_%T) (exit $?)" >> "$LOG"

echo "JP225 STEP3_killswitch START $(date +%F_%T)" >> "$LOG"
npx tsx scripts/killswitch_tune.ts JP225 >> logs/JP225_killswitch.log 2>&1
echo "JP225 STEP3_killswitch DONE $(date +%F_%T) (exit $?)" >> "$LOG"

echo "JP225_RETUNE_ALL_DONE $(date +%F_%T)" >> "$LOG"
