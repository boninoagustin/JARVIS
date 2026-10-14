#!/bin/bash
# A/B OTE SMART vs CHOCH — 10 tickers. Log: /opt/JARVIS/logs/ote_ab_out.txt
cd /opt/JARVIS || exit 1
exec > /opt/JARVIS/logs/ote_ab_out.txt 2>&1
echo "INICIO $(date)"
npx tsx /opt/JARVIS/scripts/ote_smart_ab.ts
echo "FIN $(date)"
