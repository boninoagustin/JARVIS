#!/bin/bash
# Tests de la máquina de estados ciclo→tune (revisión 7 de auditoría).
# Uso: bash scripts/ops/test_weekly_continuation.sh
# No toca /var/lib/jarvis: todo el estado vive en un directorio temporal.
set -u
REPO=/opt/JARVIS
SCRIPTS="$REPO/scripts/periodic_opt"
CHAIN="$SCRIPTS/chain_mark_and_tune.sh"
WRAP="$SCRIPTS/tune_run_wrapper.sh"
REC="$SCRIPTS/recover_tune_pending.sh"
FAIL=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; FAIL=1; }
T=$(mktemp -d)
export CONT_DIR="$T" MARK_DIR="$T"
export TUNE_START_CMD=true TUNE_CMD=true
state() { jq -r '.state // empty' "$T/weekly_continuation.json" 2>/dev/null; }
runid() { jq -r '.runId // empty' "$T/weekly_continuation.json" 2>/dev/null; }

# 1) chain → pending + runId + tune_run_id
bash "$CHAIN" >/dev/null 2>&1
[ "$(state)" = "pending" ] && ok "chain deja state=pending" || bad "chain no dejó pending"
RID=$(runid); [ -n "$RID" ] && ok "chain persiste runId" || bad "sin runId"
[ "$(cat "$T/tune_run_id" 2>/dev/null)" = "$RID" ] && ok "tune_run_id == runId" || bad "tune_run_id distinto"

# 2) wrapper con tune OK → completed y limpia tune_run_id
TUNE_CMD=true bash "$WRAP" >/dev/null 2>&1
[ "$(state)" = "completed" ] && ok "wrapper registra completed" || bad "wrapper no registró completed ($(state))"
[ -f "$T/tune_run_id" ] && bad "tune_run_id no se limpió" || ok "tune_run_id limpio tras completar"

# 3) recovery sobre completed → limpia sin re-ejecutar
OUT=$(TUNE_START_CMD=false bash "$REC" 2>&1); RC=$?
[ "$RC" = "0" ] && echo "$OUT" | grep -q "ya consumida" && ok "completed no se re-ejecuta" || bad "recovery re-ejecutó completed: $OUT"
[ -f "$T/weekly_continuation.json" ] && bad "registro completed no se limpió" || ok "registro completed limpiado"

# 4) pending del sábado recuperado el lunes (semana vieja en el registro, reciente)
bash "$CHAIN" >/dev/null 2>&1
jq -c '.week="2026-W44"' "$T/weekly_continuation.json" > "$T/x" && mv "$T/x" "$T/weekly_continuation.json"
OUT=$(TUNE_START_CMD=true bash "$REC" 2>&1); RC=$?
[ "$RC" = "0" ] && echo "$OUT" | grep -q "requeued" && ok "pending de semana anterior se recupera" || bad "no recuperó pending viejo: $OUT"

# 5) started + unidad inactiva → se reencola (interrumpida)
jq -c '.state="started"' "$T/weekly_continuation.json" > "$T/x" && mv "$T/x" "$T/weekly_continuation.json"
OUT=$(TUNE_START_CMD=true bash "$REC" 2>&1)
echo "$OUT" | grep -q "interrupted" && ok "started inactivo → interrupted/requeue" || bad "no detectó interrupción: $OUT"

# 6) failed → reintento
jq -c '.state="failed"' "$T/weekly_continuation.json" > "$T/x" && mv "$T/x" "$T/weekly_continuation.json"
OUT=$(TUNE_START_CMD=true bash "$REC" 2>&1)
echo "$OUT" | grep -q "reintenta" && ok "failed → reintenta" || bad "no reintentó failed: $OUT"

# 7) vencimiento por antigüedad (>5 días) → expired
jq -c '.state="pending" | .createdAt="2026-10-01T00:00:00Z"' "$T/weekly_continuation.json" > "$T/x" && mv "$T/x" "$T/weekly_continuation.json"
OUT=$(TUNE_START_CMD=true bash "$REC" 2>&1); RC=$?
[ "$RC" = "1" ] && echo "$OUT" | grep -q "vencida" && [ "$(state)" = "expired" ] && ok "antigüedad → expired" || bad "no expiró por antigüedad: $OUT"

# 8) exceso de intentos → expired
rm -f "$T/weekly_continuation.json"
bash "$CHAIN" >/dev/null 2>&1
jq -c '.attempts=3' "$T/weekly_continuation.json" > "$T/x" && mv "$T/x" "$T/weekly_continuation.json"
OUT=$(TUNE_START_CMD=true bash "$REC" 2>&1); RC=$?
[ "$RC" = "1" ] && echo "$OUT" | grep -q "superó" && ok "intentos → expired" || bad "no expiró por intentos: $OUT"

# 9) tune manual (sin runId) no toca el registro
rm -f "$T/weekly_continuation.json" "$T/tune_run_id"
bash "$CHAIN" >/dev/null 2>&1
BEFORE=$(state)
rm -f "$T/tune_run_id"   # simula un tune manual: no hay identidad
TUNE_CMD=true bash "$WRAP" >/dev/null 2>&1
[ "$(state)" = "$BEFORE" ] && ok "tune manual no consume la obligación" || bad "tune manual alteró el registro"

rm -rf "$T"
echo
[ "$FAIL" = "0" ] && echo "AUTOTEST OK" || { echo "AUTOTEST FALLÓ"; exit 1; }
