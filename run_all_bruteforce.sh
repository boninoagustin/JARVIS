#!/bin/bash
for asset in audcad eurusd nzdusd usdcad usdjpy xauusd; do
  echo "======================================"
  echo "Optimizing $asset..."
  echo "======================================"
  npx tsx scripts/smc_bruteforcer.ts $asset
done
echo "All optimizations finished."
