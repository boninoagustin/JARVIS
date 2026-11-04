#!/bin/bash
# Optimización de detección A DEMANDA para un activo (botón "Optimizar" del panel).
# 03-nov-2026: el endpoint inline no pasaba NODE_OPTIONS al tune (OOM con historias
# grandes) ni reiniciaba el bot cuando aplicaba (preset inerte). Tampoco guardaba stderr.
#
# Uso: optimize_ticker.sh TICKER
set -u
TICKER="${1:?ticker requerido}"
cd /opt/JARVIS || exit 1
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
LOG="/tmp/detection_opt_${TICKER}.log"
ERR="/tmp/detection_opt_${TICKER}_err.log"

# Anti-duplicados con el tune semanal / otras corridas
exec 9>/tmp/detection_tune.lock
flock 9

echo "=== $(date +%H:%M:%S) TUNE $TICKER (60 trials) ===" >>"$LOG"
OUT=$(NODE_OPTIONS="--max-old-space-size=2560" npx tsx scripts/periodic_opt/smc_detection_search.ts "$TICKER" tune 60 2>>"$ERR")
echo "$OUT" | grep -a -E "TUNE_RESULT|DECISIÓN|CANDIDATO|ACTUAL|Δ" >>"$LOG"

if echo "$OUT" | grep -qa "TUNE_RESULT: APPLIED"; then
  echo "$OUT" | grep -a "TUNE_RESULT: APPLIED" >>"$LOG"
  # El engine cachea el preset al crearse: sin reinicio, lo aplicado queda inerte.
  pm2 restart JARVIS --update-env >>"$LOG" 2>&1
  NEWPID=$(pm2 pid JARVIS 2>/dev/null)
  [ -n "$NEWPID" ] && echo -1000 > "/proc/$NEWPID/oom_score_adj" 2>/dev/null
  echo "RESTART_OK $(date +%H:%M:%S)" >>"$LOG"
else
  echo "TUNE_RESULT: NOT_APPLIED" >>"$LOG"
fi

# Refrescar la salud del activo para el panel
echo "=== $(date +%H:%M:%S) HEALTH $TICKER ===" >>"$LOG"
NODE_OPTIONS="--max-old-space-size=2560" npx tsx scripts/periodic_opt/smc_detection_search.ts "$TICKER" health 0 2>>"$ERR" \
  | grep -a "HEALTH_" >>"$LOG"
echo "=== $(date +%H:%M:%S) FIN $TICKER ===" >>"$LOG"
