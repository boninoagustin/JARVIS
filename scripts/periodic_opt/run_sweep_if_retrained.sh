#!/usr/bin/env bash
# run_sweep_if_retrained.sh — corre el sweep de umbral ML SOLO si un modelo cambió desde el último sweep.
# Se cuelga del pipeline dominical (ExecStartPost, DESPUÉS de train_ml_weekly).
# Espera el sweep: el aviso de cierre no debe adelantarse a su resultado.
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

echo "[sweep-hook] CAMBIOS detectados en modelos → sweep ML secuencial..." | tee -a "$LOG"
# Stay inside the parent unit memory/time limits. Never claim completion while detached.
cd "$REPO" || exit 1
if ! "$NPX" tsx "$REPO/scripts/ml_threshold_sweep.ts" >> "$LOG" 2>&1; then
  echo '[sweep-hook] sweep FALLÓ — checkpoint preservado; revisar antes de declarar cierre' | tee -a "$LOG"
  exit 1
fi
# Persist the actual parent-shell snapshot (the old detached shell wrote an empty variable).
printf '%s\n' "$current" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE" || exit 1
echo "[sweep-hook] sweep completado; checkpoint actualizado. Log: $LOG" | tee -a "$LOG"
exit 0
