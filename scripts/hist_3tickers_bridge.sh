#!/bin/bash
# Historial GBPJPY/AUDJPY/GER40 → CSVs pine-logs → restart bridge TimesFM
set -u
cd /opt/JARVIS
for t in GBPJPY AUDJPY GER40; do
  echo "=== [$t] fetch_history ==="
  npx tsx scripts/fetch_history.ts "$t" || echo "!! FETCH FAIL $t"
  echo "=== [$t] export_smc_csv ==="
  npx tsx scripts/export_smc_csv.ts "$t" || echo "!! EXPORT FAIL $t"
done
echo "=== restart jarvis-timesfm-bridge ==="
systemctl restart jarvis-timesfm-bridge
echo "=== FIN ==="
