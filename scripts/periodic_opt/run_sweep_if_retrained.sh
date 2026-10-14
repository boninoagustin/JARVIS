#!/usr/bin/env bash
# run_sweep_if_retrained.sh — corre el sweep de umbral ML SOLO si un modelo cambió desde el último sweep.
# Se cuelga del pipeline dominical (ExecStartPost, DESPUÉS de train_ml_weekly).
# El sweep tarda ~1h → corre DETACHED vía systemd-run (no bloquea el service ni el health_check).
# Resultado: publica ml_gate_evals/{TICKER} → visible en el panel GATE ML POR ACTIVO.
set -uo pipefail

REPO=/opt/JARVIS
MODELS_DIR=$REPO/scripts/hyperopt/models
STATE=$REPO/scripts/hyperopt/.ml_sweep_mtimes
LOG=$REPO/logs/sweep_ml_$(date +%Y%m%d_%H%M%S).log
NPX=/root/.nvm/versions/node/v24.19.0/bin/npx

echo "[sweep-hook] $(date -Is) chequeando modelos..." | tee -a "$LOG"

# mtimes actuales (los temporales del sweep viven en /tmp/ml_sweep → no contaminan)
current=$(for f in "$MODELS_DIR"/ml_model*.json; do
  [ -e "$f" ] || continue
  echo "$(basename "$f") $(stat -c %Y "$f")"
done | sort)

if [ ! -f "$STATE" ]; then
  echo "[sweep-hook] primer arranque: inicializo estado, NO corro sweep." | tee -a "$LOG"
  echo "$current" > "$STATE"
  exit 0
fi

if [ "$current" == "$(cat "$STATE")" ]; then
  echo "[sweep-hook] sin cambios en modelos → skip." | tee -a "$LOG"
  exit 0
fi

echo "[sweep-hook] 🔄 CAMBIOS detectados en modelos → lanzando sweep ML (detached)..." | tee -a "$LOG"
diff <(cat "$STATE") <(echo "$current") | tee -a "$LOG"

# systemd-run --collect --no-block: unidad transitoria que se auto-recolecta al terminar.
# Sobrevive al fin del service del dominical (los hijos de bash morirían por SIGTERM).
systemd-run --collect --no-block \
  --unit="jarvis-sweep-ml-$(date +%s)" \
  --property=WorkingDirectory="$REPO" \
  --property=MemoryHigh=4G \
  --property=MemoryMax=5G \
  --property=Nice=10 \
  /bin/bash -c "$NPX tsx $REPO/scripts/ml_threshold_sweep.ts >> \"$LOG\" 2>&1 && echo \"\$current\" > \"$STATE\" || echo '[sweep-hook] sweep FALLÓ — estado NO actualizado (reintenta el próximo domingo)' >> \"$LOG\""

echo "[sweep-hook] unidad transitoria lanzada. Log: $LOG" | tee -a "$LOG"
exit 0
