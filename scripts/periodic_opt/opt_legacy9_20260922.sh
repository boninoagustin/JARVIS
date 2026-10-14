#!/bin/bash
# Optimización parcial de los 9 legacy habilitados (22-sep-2026, pedido de Bon).
# Con fetch+refresh: velas frescas de cTrader + re-export con los presets actuales
# (XAUUSD/EURUSD ya incluyen los bloques TF nuevos aplicados hoy).
# --force: los reportes previos son del 13-sep; sin force el gate de frescura podría
# saltear el hyperopt. El auto-apply corre con sus gates normales (RECOMMEND+MC+enabled).
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS || exit 1
exec >> /opt/JARVIS/logs/opt_legacy9_2026-09-22.log 2>&1
echo "═══ INICIO $(date '+%F %T') ═══"
python3 scripts/periodic_opt/run_weekly.py \
  --tickers EURUSD,GBPUSD,AUDCAD,XAUUSD,USDJPY,NZDUSD,GBPJPY,AUDJPY,JP225 \
  --force || echo "⚠️ run_weekly exit=$?"
npx tsx scripts/periodic_opt/push_reports.js
npx tsx scripts/periodic_opt/detection_diagnostic.ts
npx tsx scripts/health_check.ts
echo "═══ FIN $(date '+%F %T') ═══"
