#!/bin/bash
for asset in AUDCAD EURUSD GBPUSD NZDUSD US500 USDCAD USDJPY USOIL XAUUSD; do
  echo "======================================"
  echo "Optimizing $asset with Hyperopt..."
  echo "======================================"
  python3 scripts/hyperopt/run_hyperopt.py $asset --n-trials 200
done
echo "All hyperopt optimizations finished."
