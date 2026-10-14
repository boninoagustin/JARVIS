#!/bin/bash
# ab_reject_only.sh — A/B TimesFM con REDUCE neutralizado (riskMult=1): solo el REJECT actúa.
# Reutiliza forecasts precomputados de la corrida default (ab_out/{T}_15/forecasts.jsonl).
set -u
cd /opt/JARVIS
AB="python3 scripts/timesfm/run_ab.py"
TICKERS="eurusd gbpusd audcad us500 xauusd usdjpy nzdusd gbpjpy audjpy ger40"

for T in $TICKERS; do
  TU=$(echo "$T" | tr '[:lower:]' '[:upper:]')
  PRESET_ARG=""
  if [ -f "scripts/timesfm/ab_presets/optimized_preset_${TU}_hyperopt.json" ]; then
    PRESET_ARG="--preset-path scripts/timesfm/ab_presets/optimized_preset_${TU}_hyperopt.json"
  fi
  echo "════════════════ $T : variante solo-REJECT (low-mult 1.0, counter-mult 1.0) ════════════════"
  $AB --ticker "$T" --tf 15 --horizon 12 --skip-precompute --low-mult 1.0 --counter-mult 1.0 --tag rej $PRESET_ARG 2>&1
done
echo "════════════════ LISTO: variante solo-REJECT de los 10 tickers ════════════════"
