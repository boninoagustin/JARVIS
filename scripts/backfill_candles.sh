#!/usr/bin/env bash
# backfill_candles.sh — descarga TODA la historia cTrader y re-exporta los CSVs SMC (16-sep-2026).
# Backfill único: de ahora en más lo hace run_weekly paso 0a todos los domingos.
set -uo pipefail
cd /opt/JARVIS
LOG=/opt/JARVIS/logs/backfill_candles_$(date +%Y%m%d_%H%M%S).log
exec >> "$LOG" 2>&1
echo "[backfill] $(date -Is) inicio"
/root/.nvm/versions/node/v24.19.0/bin/npx tsx scripts/fetch_history.ts
echo "[backfill] fetch OK — exportando CSVs SMC (SMCEngine replay)..."
for T in EURUSD GBPUSD US500 XAUUSD USDCAD USDJPY AUDCAD NZDUSD USOIL BTCUSD AUDJPY GBPJPY GER40 JP225; do
  /root/.nvm/versions/node/v24.19.0/bin/npx tsx scripts/export_smc_csv.ts "$T" && echo "[backfill] export $T OK" || echo "[backfill] export $T FALLO"
done
echo "[backfill] $(date -Is) FIN"
