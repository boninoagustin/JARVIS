#!/bin/bash
# Re-corrida nocturna AUDCAD + NZDUSD (fix: collect_triggers require→import, 10-sep-2026)
# Con el cache TimesFM arreglado, 400 trials entran en el timeout de 150 min.
set -e
cd /opt/JARVIS
LOG="logs/nightly_opt_retry2_$(date +%F_%H%M).log"
mkdir -p logs
echo "═══ nightly_opt_retry2 start $(date -Iseconds) ═══" >> "$LOG"
nice -n 15 /opt/JARVIS/scripts/hyperopt/.venv/bin/python scripts/periodic_opt/run_weekly.py --tickers AUDCAD,NZDUSD >> "$LOG" 2>&1
RC=$?
# Health check post-corrida: el panel muestra opt_status (activos en ERROR/report viejo)
cd /opt/JARVIS && npx tsx scripts/health_check.ts --json >> "$LOG" 2>&1 || true
echo "═══ nightly_opt_retry2 end $(date -Iseconds) exit=$RC ═══" >> "$LOG"
