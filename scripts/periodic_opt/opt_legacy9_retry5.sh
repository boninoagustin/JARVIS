#!/bin/bash
# Re-corrida de los 5 que fallaron por KeyError vwapPts (22-sep-2026).
# Fix: .get() en build_backtest_config + bump weekly12. Velas ya frescas (fetch de hoy).
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS || exit 1
exec >> /opt/JARVIS/logs/opt_legacy9_retry5_2026-09-22.log 2>&1
echo "═══ INICIO $(date '+%F %T') ═══"
python3 scripts/periodic_opt/run_weekly.py \
  --tickers AUDCAD,USDJPY,NZDUSD,GBPJPY,JP225 \
  --force --skip-fetch --skip-refresh || echo "⚠️ run_weekly exit=$?"
npx tsx scripts/periodic_opt/push_reports.js
npx tsx scripts/health_check.ts
echo "═══ FIN $(date '+%F %T') ═══"
