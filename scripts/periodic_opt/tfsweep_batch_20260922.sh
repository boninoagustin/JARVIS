#!/bin/bash
# Sweeps TF secuenciales de los 4 flaggeados del diagnóstico (22-sep-2026).
# SOLO PROPONEN: smc_tf_sweep.ts no aplica nada (restaura preset + pine-logs al baseline).
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS || exit 1
for T in EURUSD NZDUSD AUDJPY GBPJPY; do
  echo "═══════ TF SWEEP $T $(date '+%F %T') ═══════"
  npx tsx scripts/periodic_opt/smc_tf_sweep.ts "$T" || echo "⚠️ $T falló (exit $?) — sigue con el próximo"
done
echo "═══════ BATCH COMPLETO $(date '+%F %T') ═══════"
