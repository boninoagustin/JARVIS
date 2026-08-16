#!/usr/bin/env bash
# run_batch_tune.sh — tuneo per-gatillo de los 9 activos, secuencial, con logging a archivo.
# Se lanza detached (setsid) para que sobreviva a la sesión de terminal.
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS
LOG=/opt/JARVIS/backups/batch_tune.log
exec >> "$LOG" 2>&1
echo "=== START $(date) ==="
for t in AUDCAD BTCUSD EURUSD GBPUSD NZDUSD US500 USDCAD USDJPY USOIL; do
  echo "═════════════ $t $(date) ═════════════"
  npx tsx scripts/per_trigger_tune.ts "$t" --budget 200 --concurrency 4 --save "/opt/JARVIS/backups/${t}_tuned.json"
  echo "── $t exit=$? $(date) ──"
done
echo "=== ALL 9 DONE $(date) ==="
