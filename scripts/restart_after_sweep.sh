#!/usr/bin/env bash
# restart_after_sweep.sh — espera a que termine el barrido de killswitch y reinicia JARVIS.
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
LOG=/opt/JARVIS/backups/restart_log.txt
while systemctl is-active --quiet jarvis-killswitch; do
  sleep 20
done
sleep 5
pm2 restart JARVIS --update-env >/dev/null 2>&1
echo "$(date '+%F %T') JARVIS reiniciado tras barrido killswitch (exit=$?)" >> "$LOG"
