#!/bin/bash
for asset in AUDCAD EURUSD GBPUSD NZDUSD US500 USDCAD USDJPY USOIL XAUUSD; do
  echo "======================================"
  echo "Exporting SMC logs for $asset..."
  echo "======================================"
  npx tsx scripts/export_smc_csv.ts $asset
done
echo "All exports finished."
