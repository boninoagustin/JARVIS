#!/bin/bash
ASSETS=("EURUSD" "GBPUSD" "US500" "XAUUSD" "USDCAD" "USDJPY" "AUDCAD" "NZDUSD" "USOIL")

echo "Starting Simulation of Backtests for all assets..." > simulation_results.txt
echo "=================================================" >> simulation_results.txt

for asset in "${ASSETS[@]}"; do
    echo "Processing $asset..."
    echo "[$asset] Exporting SMC CSV Logs..."
    npx tsx scripts/export_smc_csv.ts $asset > /dev/null 2>&1
    
    echo "[$asset] Running Backtest..."
    echo "" >> simulation_results.txt
    echo "=== $asset ===" >> simulation_results.txt
    npx tsx scripts/run_exported_backtest.ts $asset >> simulation_results.txt
    echo "Finished $asset."
done

echo "All simulations finished."
