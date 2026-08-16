#!/bin/bash
# ab_extend.sh — paridad dry-run EURUSD + extensión A/B (XAUUSD, US500, USOIL)
# Cada ticker: corrida default (5.3) → mediana spread/ATR del audit → si desvía >10%, recalibrada.
cd /opt/JARVIS
PY=scripts/timesfm/.venv/bin/python
AB="python3 scripts/timesfm/run_ab.py"

echo "════════ 0/4 PARIDAD DRY-RUN EURUSD (filtrado debe == baseline) ════════"
$AB --ticker eurusd --tf 15 --horizon 12 --skip-precompute --dry-run --tag dry 2>&1 | grep -E "baseline|timesfm|Acciones|Δ"

for T in xauusd us500 usoil; do
  echo "════════ $T: corrida default (umbral 5.3) ════════"
  $AB --ticker $T --tf 15 --horizon 12 2>&1 | grep -E "baseline|timesfm|Acciones|Δ|triggers colectados|salteados"
  MED=$($PY -c "
import json, statistics
recs=[json.loads(l) for l in open('scripts/timesfm/ab_out/${T}_15/audit.jsonl')]
sa=sorted(r['spreadAtr'] for r in recs if not r.get('degraded'))
print(statistics.median(sa) if sa else 0)")
  echo "[$T] mediana spread/ATR = $MED"
  DESV=$(echo "$MED" | awk -v m="$MED" 'BEGIN{d=(m-5.3)/5.3; print (d<0?-d:d)}')
  if awk "BEGIN{exit !($DESV > 0.10)}"; then
    echo "════════ $T: recalibrada (umbral $MED) ════════"
    $AB --ticker $T --tf 15 --horizon 12 --skip-precompute --spread-hi $MED --tag cal 2>&1 | grep -E "baseline|timesfm|Acciones|Δ"
  else
    echo "[$T] mediana dentro del 10% de 5.3 → default ya calibrado, no recorro"
  fi
done
echo "════════ LISTO ════════"
