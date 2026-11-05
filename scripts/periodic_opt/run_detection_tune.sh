#!/bin/bash
# Tune semanal de detección SMC por activo (dueño de los bloques TF del preset, ex-bruteforcer).
# Modo tune: búsqueda sobre train 70% + OOS del candidato vs actual + regla conservadora.
# Reinicia JARVIS solo si algún activo se aplicó (los engines cachean el preset al crearse).
export PATH="/root/.nvm/versions/node/v24.19.0/bin:$PATH"
cd /opt/JARVIS

# 🛡️ Anti-duplicados: si ya hay una corrida de detección, ESPERAR a que termine (flock bloqueante).
exec 9>"/tmp/detection_tune.lock"
flock 9
echo "$(date) Lock de detección adquirido." >&2

# 🛡️ Proteger al bot del OOM killer antes de correr búsquedas pesadas (lección 10-oct-2026:
# un OOM mató a JARVIS; los picos de la búsqueda no deben poder tumbar el bot en vivo).
BOTPID=$(pm2 pid JARVIS 2>/dev/null)
if [ -n "$BOTPID" ]; then
  echo -1000 > "/proc/$BOTPID/oom_score_adj" 2>/dev/null \
    && echo "oom_score_adj de JARVIS ($BOTPID): -1000 (protegido del OOM killer)"
fi

ROSTER="${DETECTION_ROSTER:-AUDCAD AUDJPY EUROPE50 FRA40 JP225 NL25 USDJPY USOIL XAUUSD EURUSD GBPUSD GBPJPY NZDUSD GBPAUD}"
TRIALS="${DETECTION_TRIALS:-80}"
APPLIED=0

# 📝 Log de la corrida (fix 02-nov-2026): SOLO se persisten las líneas con valor de auditoría.
# Antes se hacía `tee -a` de TODO el stdout y cada corrida dejaba ~2.7 GB, de los cuales el
# 99.9% era "[SMC-ENGINE] 🕯️ Nueva vela" del replay. Los trials crudos se siguen calculando
# igual: simplemente se descartan al vuelo con grep (nunca llegan al disco).
LOG_DIR="/opt/JARVIS/logs/periodic_opt"
mkdir -p "$LOG_DIR"
SUMMARY="$LOG_DIR/detection_tune_$(date +%Y%m%d).log"
MAX_LOG_BYTES=$((20 * 1024 * 1024))   # techo de seguridad: 20 MB por corrida
KEEP='^(=== |Cargadas:|TUNE [A-Z0-9]+:|CANDIDATO|ACTUAL|Δ|DECISI|TUNE_RESULT|HEALTH_|Pool de salud)'

# Retención: 30 días de resúmenes y limpieza de los logs gigantes heredados de /tmp.
find "$LOG_DIR" -maxdepth 1 -name 'detection_tune_*.log' -mtime +30 -delete 2>/dev/null
find /tmp -maxdepth 1 -name 'detection_tune_*.log' -mtime +1 -delete 2>/dev/null

for t in $ROSTER; do
  echo "=== $(date +%H:%M:%S) TUNE $t ===" >> "$SUMMARY"
  BEFORE=$(wc -l < "$SUMMARY")
  # Heap 2560: los trials no necesitan más (el pico real está en la generación del M5) y
  # evita el OOM que tumbó el sistema con heap 4096.
  NODE_OPTIONS="--max-old-space-size=2560" npx tsx scripts/periodic_opt/smc_detection_search.ts "$t" tune "$TRIALS" 2>/dev/null \
    | grep -aE "$KEEP" >> "$SUMMARY"
  if tail -n +$((BEFORE + 1)) "$SUMMARY" | grep -q "TUNE_RESULT: APPLIED"; then
    APPLIED=$((APPLIED + 1))
  fi
  # Techo de seguridad: si algo se descontrola, se conservan las últimas 2000 líneas.
  if [ "$(stat -c %s "$SUMMARY" 2>/dev/null || echo 0)" -gt "$MAX_LOG_BYTES" ]; then
    tail -n 2000 "$SUMMARY" > "$SUMMARY.tmp" && mv "$SUMMARY.tmp" "$SUMMARY"
    echo "=== $(date +%H:%M:%S) AVISO: log recortado a las últimas 2000 líneas (superó 20 MB) ===" >> "$SUMMARY"
  fi
done

echo "=== $(date +%H:%M:%S) FIN tune semanal. Aplicados: $APPLIED ===" >> "$SUMMARY"
if [ "$APPLIED" -gt 0 ]; then
  echo "Reiniciando JARVIS para cargar los presets nuevos..." >> "$SUMMARY"
  pm2 restart JARVIS --update-env 2>&1 | tail -2 >> "$SUMMARY"
  # Re-proteger tras el restart (pm2 no preserva oom_score_adj)
  NEWPID=$(pm2 pid JARVIS 2>/dev/null)
  [ -n "$NEWPID" ] && echo -1000 > "/proc/$NEWPID/oom_score_adj" 2>/dev/null
fi

# D1 (auditoría 2026-11-05): el health-all se movió a la cadena (OnSuccess del tune →
# jarvis-health-weekly, que además corre las propuestas). Antes se ejecutaba DOS veces.
