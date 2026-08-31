#!/bin/bash
# ab_10tickers.sh — A/B TimesFM de los 10 activos del roster con config actual (ago-2026)
# Por ticker: corrida default (umbral 5.3) → mediana spread/ATR del audit → recalibrada si desvía >10%.
# Salida completa al journal (systemd-run). Reportes en scripts/timesfm/ab_out/{T}_15/ab_report*.json
set -u
cd /opt/JARVIS
PY=scripts/timesfm/.venv/bin/python
AB="python3 scripts/timesfm/run_ab.py"
TICKERS="eurusd gbpusd audcad us500 xauusd usdjpy nzdusd gbpjpy audjpy ger40"

for T in $TICKERS; do
  TU=$(echo "$T" | tr '[:lower:]' '[:upper:]')
  PRESET_ARG=""
  if [ -f "scripts/timesfm/ab_presets/optimized_preset_${TU}_hyperopt.json" ]; then
    PRESET_ARG="--preset-path scripts/timesfm/ab_presets/optimized_preset_${TU}_hyperopt.json"
  fi
  echo "════════════════ $T : corrida default (umbral 5.3) ════════════════"
  $AB --ticker "$T" --tf 15 --horizon 12 $PRESET_ARG 2>&1
  MED=$($PY -c "
import json, statistics, sys
p = 'scripts/timesfm/ab_out/${T}_15/audit.jsonl'
try:
    recs = [json.loads(l) for l in open(p)]
except FileNotFoundError:
    print(0); sys.exit(0)
sa = sorted(r['spreadAtr'] for r in recs if not r.get('degraded') and r.get('spreadAtr'))
print(statistics.median(sa) if sa else 0)
")
  echo "[$T] mediana spread/ATR = $MED"
  DESV=$(awk -v m="$MED" 'BEGIN{ d=(m-5.3)/5.3; print (d<0?-d:d) }')
  if awk "BEGIN{exit !($DESV > 0.10)}"; then
    echo "════════════════ $T : recalibrada (umbral $MED) ════════════════"
    $AB --ticker "$T" --tf 15 --horizon 12 --skip-precompute --spread-hi "$MED" --tag cal $PRESET_ARG 2>&1
  else
    echo "[$T] mediana dentro del 10% de 5.3 → default ya calibrado"
  fi
done
echo "════════════════ LISTO: A/B de los 10 tickers ════════════════"
