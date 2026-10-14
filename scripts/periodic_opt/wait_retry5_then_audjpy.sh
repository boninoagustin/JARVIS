#!/bin/bash
# Espera a que termine jarvis-opt-retry5 y re-corre AUDJPY con estudio fresco
# (su reporte del legacy9 quedó contaminado por partialClosePct=50 en Firestore).
# Jobs pesados secuenciales (VPS 7.8GB RAM).
set -u
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS

echo "[$(date -Is)] esperando a que termine jarvis-opt-retry5..."
for i in $(seq 1 240); do
  if ! systemctl is-active --quiet jarvis-opt-retry5 2>/dev/null; then break; fi
  sleep 60
done
if systemctl is-active --quiet jarvis-opt-retry5 2>/dev/null; then
  echo "[$(date -Is)] retry5 sigue vivo tras 4h — aborto (revisar manualmente)"
  exit 1
fi
echo "[$(date -Is)] retry5 terminó — arranco AUDJPY (estudio weekly12_v2)"
python3 scripts/periodic_opt/run_weekly.py \
  --tickers AUDJPY --skip-fetch --skip-refresh --force --study-suffix _v2 \
  > logs/opt_audjpy_v2_$(date +%Y-%m-%d_%H%M).log 2>&1
rc=$?
echo "[$(date -Is)] AUDJPY v2 exit=$rc"
exit $rc
