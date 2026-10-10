#!/bin/bash
# Tune semanal de detección SMC por activo (dueño de los bloques TF del preset, ex-bruteforcer).
# Modo tune: búsqueda sobre train 70% + OOS del candidato vs actual + regla conservadora.
# Reinicia JARVIS solo si algún activo se aplicó (los engines cachean el preset al crearse).
export PATH="/home/bon/.nvm/versions/node/v24.18.0/bin:$PATH"
cd /opt/JARVIS

# 🛡️ Anti-duplicados: si ya hay una corrida de detección, no arrancar otra.
exec 9>"/tmp/detection_tune.lock"
if ! flock -n 9; then
  echo "$(date) Otra corrida de detección ya está activa — salgo." >&2
  exit 0
fi

# 🛡️ Proteger al bot del OOM killer antes de correr búsquedas pesadas (lección 10-oct-2026:
# un OOM mató a JARVIS; los picos de la búsqueda no deben poder tumbar el bot en vivo).
BOTPID=$(pm2 pid JARVIS 2>/dev/null)
if [ -n "$BOTPID" ]; then
  echo -1000 > "/proc/$BOTPID/oom_score_adj" 2>/dev/null \
    && echo "oom_score_adj de JARVIS ($BOTPID): -1000 (protegido del OOM killer)"
fi

ROSTER="${DETECTION_ROSTER:-AUDCAD AUDJPY EUROPE50 FRA40 JP225 NL25 USDJPY USOIL XAUUSD}"
TRIALS="${DETECTION_TRIALS:-80}"
APPLIED=0
SUMMARY="/tmp/detection_tune_$(date +%Y%m%d).log"

for t in $ROSTER; do
  echo "=== $(date +%H:%M:%S) TUNE $t ===" | tee -a "$SUMMARY"
  # Heap 2560: los trials no necesitan más (el pico real está en la generación del M5) y
  # evita el OOM que tumbó el sistema con heap 4096.
  if NODE_OPTIONS="--max-old-space-size=2560" npx tsx scripts/periodic_opt/smc_detection_search.ts "$t" tune "$TRIALS" 2>/dev/null | tee -a "$SUMMARY" | grep -q "TUNE_RESULT: APPLIED"; then
    APPLIED=$((APPLIED+1))
  fi
done

echo "=== $(date +%H:%M:%S) FIN tune semanal. Aplicados: $APPLIED ===" | tee -a "$SUMMARY"
if [ "$APPLIED" -gt 0 ]; then
  echo "Reiniciando JARVIS para cargar los presets nuevos..." | tee -a "$SUMMARY"
  pm2 restart JARVIS --update-env 2>&1 | tail -2 | tee -a "$SUMMARY"
  # Re-proteger tras el restart (pm2 no preserva oom_score_adj)
  NEWPID=$(pm2 pid JARVIS 2>/dev/null)
  [ -n "$NEWPID" ] && echo -1000 > "/proc/$NEWPID/oom_score_adj" 2>/dev/null
fi
