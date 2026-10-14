#!/bin/bash
# Re-corrida dominical 20-sep-2026: los 14 activos que fallaron esta madrugada
# porque run_hyperopt.py no aceptaba --current-sessions (fix: 20-sep-2026).
# --skip-fetch --skip-refresh: las velas ya se bajaron/regeneraron hoy a las 02:00-03:00.
# --force: los reportes de hoy quedaron con status ERROR (timestamp fresco) y sin
#          force el gate de frescura los saltearía por "sin datos nuevos".
cd /opt/JARVIS || exit 1
exec python3 scripts/periodic_opt/run_weekly.py \
  --tickers USOIL,NL25,USTECH100,CADJPY,US30,AUDNZD,FRA40,XPTUSD,EURGBP,XAGUSD,XBRUSD,ITALY40,GBPAUD,AUSTRALIA200 \
  --skip-fetch --skip-refresh --force >> /opt/JARVIS/logs/opt_rerun_2026-09-20_1835.log 2>&1
