#!/bin/bash
# A/B biasConfluence — 10 tickers. Log: /opt/JARVIS/logs/bias_ab_out.txt
cd /opt/JARVIS || exit 1
exec > /opt/JARVIS/logs/bias_ab_out.txt 2>&1
echo "INICIO $(date)"
npx tsx /opt/JARVIS/scripts/bias_confluence_ab.ts
echo "FIN $(date)"
