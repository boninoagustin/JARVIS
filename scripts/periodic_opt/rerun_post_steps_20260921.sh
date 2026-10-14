#!/bin/bash
# Re-corrida de los pasos POST del ciclo semanal (21-sep-2026).
# El domingo 20-sep run_weekly falló (exit 1) → systemd NO ejecutó ningún
# ExecStartPost: push (ya hecho aparte), contrafactuales, ML y health check.
# Corre los mismos pasos en el MISMO orden que jarvis-periodic-opt.service.
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS || exit 1
set -x
npx tsx scripts/corr_gate_eval.ts
python3 scripts/periodic_opt/train_ml_weekly.py
bash scripts/periodic_opt/run_sweep_if_retrained.sh
npx tsx scripts/timesfm_gate_eval.ts
npx tsx scripts/blocked_signals_eval.ts
npx tsx scripts/exits_gate_eval.ts
npx tsx scripts/rollover_eval.ts
npx tsx scripts/health_check.ts
echo "=== POST STEPS COMPLETOS: exit=$? ==="
