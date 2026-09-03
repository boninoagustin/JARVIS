#!/bin/bash
# Post-tune: espera a que termine el batch de re-optimización (jarvis_retune)
# y encadena disable_losers (paso 2) + killswitch_tune (paso 3).
cd /opt/JARVIS
export PATH="/home/bon/.local/bin:$PATH"

# Esperar a que el batch principal termine (poll cada 60s)
while systemctl is-active --quiet jarvis_retune; do
  sleep 60
done

echo "POSTTUNE_START $(date +%F_%T)" >> logs/retune_all.log

# Paso 2: desactivar combos sesión×gatillo con PnL<0
echo "STEP2_disable_losers START $(date +%F_%T)" >> logs/retune_all.log
npx tsx scripts/disable_losers.ts all >> logs/posttune_disable_losers.log 2>&1
echo "STEP2_disable_losers DONE  $(date +%F_%T) (exit $?)" >> logs/retune_all.log

# Paso 3: optimizar maxDailyLossR / maxConsecutiveLosses
echo "STEP3_killswitch_tune START $(date +%F_%T)" >> logs/retune_all.log
npx tsx scripts/killswitch_tune.ts all >> logs/posttune_killswitch.log 2>&1
echo "STEP3_killswitch_tune DONE  $(date +%F_%T) (exit $?)" >> logs/retune_all.log

echo "POSTTUNE_ALL_DONE $(date +%F_%T)" >> logs/retune_all.log
