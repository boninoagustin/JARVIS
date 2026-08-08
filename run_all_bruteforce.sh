#!/bin/bash
for asset in AUDCAD EURUSD GBPUSD NZDUSD US500 USDCAD USDJPY USOIL XAUUSD; do
  echo "======================================"
  echo "Optimizing $asset..."
  echo "======================================"
  npx tsx scripts/smc_bruteforcer.ts $asset
done
echo "All optimizations finished."
