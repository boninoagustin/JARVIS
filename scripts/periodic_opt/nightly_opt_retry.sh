#!/bin/bash
# Re-corrida nocturna (mié 09 → jue 10 sep-2026): los 3 tickers que hicieron timeout anoche.
# Con el timeout del hyperopt ya subido a 150 min (fix run_weekly.py).
# nice -n 15: el bot vivo conserva prioridad de CPU. Vía systemd-run --on-calendar.
set -u
LOG=/opt/JARVIS/logs/nightly_opt_retry_$(date +%F_%H%M).log
mkdir -p /opt/JARVIS/scripts/periodic_opt/reports/backup_prev
cp -f /opt/JARVIS/scripts/periodic_opt/reports/*.json /opt/JARVIS/scripts/periodic_opt/reports/backup_prev/ 2>/dev/null || true
cd /opt/JARVIS
exec > "$LOG" 2>&1
echo "═══ nightly_opt_retry start $(date -u +%FT%TZ) ═══"
nice -n 15 python3 scripts/periodic_opt/run_weekly.py \
  --tickers GBPUSD,AUDCAD,NZDUSD \
  --skip-refresh --force
echo "═══ nightly_opt_retry end $(date -u +%FT%TZ) exit=$? ═══"
