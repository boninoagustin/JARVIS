#!/bin/bash
# Optimización nocturna parcial (martes 08 → miércoles 09 sep-2026).
# 5 activos del roster, skip-refresh (CSVs frescos del dominical 07-sep), --force
# (el gate de frescura no aplica: la corrida vale por el bump weekly9 post walkTree-fix).
# nice -n 15: el bot vivo (JARVIS pm2) conserva prioridad de CPU.
# Corre vía systemd-run --on-calendar (ver cron del lanzamiento).
set -u
LOG=/opt/JARVIS/logs/nightly_opt_$(date +%F_%H%M).log
# Backup de los reports del dominical anterior (trazabilidad)
mkdir -p /opt/JARVIS/scripts/periodic_opt/reports/backup_prev
cp -f /opt/JARVIS/scripts/periodic_opt/reports/*.json /opt/JARVIS/scripts/periodic_opt/reports/backup_prev/ 2>/dev/null || true
cd /opt/JARVIS
exec > "$LOG" 2>&1
echo "═══ nightly_opt start $(date -u +%FT%TZ) ═══"
# 10 activos × 400 trials (decisión Bon 08-sep: cobertura total, miércoles = día de transición)
nice -n 15 python3 scripts/periodic_opt/run_weekly.py --skip-refresh --force
echo "═══ nightly_opt end $(date -u +%FT%TZ) exit=$? ═══"
