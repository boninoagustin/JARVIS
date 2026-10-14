#!/bin/bash
# OnFailure del ciclo semanal (21-sep-2026): avisa por Telegram cuando
# jarvis-periodic-opt.service falla, con el tail del journal para diagnóstico.
TOKEN=$(grep -oE 'TELEGRAM_BOT_TOKEN="[^"]+"' /opt/JARVIS/.env | head -1 | sed 's/TELEGRAM_BOT_TOKEN="//; s/"$//')
CHAT_ID=$(grep -oE 'TELEGRAM_ALLOWED_USER_IDS="[^"]+"' /opt/JARVIS/.env | head -1 | sed 's/TELEGRAM_ALLOWED_USER_IDS="//; s/"$//')
CHAT_ID="${CHAT_ID:-1348898450}"
if [ -z "$TOKEN" ]; then exit 0; fi
TAIL_LOG=$(journalctl -u jarvis-periodic-opt.service -n 20 --no-pager 2>/dev/null | tail -20 | tr '\n' ' ' | cut -c1-1600)
curl -s -m 20 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  --data-urlencode "text=🚨 JARVIS — el ciclo de Optimización Periódica FALLÓ (ver journal).
${TAIL_LOG}" >/dev/null 2>&1
exit 0
