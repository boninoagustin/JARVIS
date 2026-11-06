#!/bin/bash
# Tests de la máquina de estados ciclo→tune (revisiones 7-8 de auditoría).
# Uso: bash scripts/ops/test_weekly_continuation.sh
# No toca /var/lib/jarvis: estado en un directorio temporal y systemd simulado.
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
# systemd simulado por defecto: unidad inactiva y Result fallido (interrumpida)
export TUNE_START_CMD=true TUNE_CMD=true
export TUNE_STATE_CMD='echo inactive' TUNE_RESULT_CMD='echo failed'
state() { jq -r '.state // empty' "$T/weekly_continuation.json" 2>/dev/null; }
runid() { jq -r '.runId // empty' "$T/weekly_continuation.json" 2>/dev/null; }
new_record() { # $1=state $2=runId $3=attempts
  local st="$1" rid="${2:-run-$(date +%s%N)}" att="${3:-0}"
  printf '{"runId":"%s","week":"2026-W45","state":"%s","createdAt":"%s","startedAt":null,"completedAt":null,"attempts":%s}\n' \
    "$rid" "$st" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$att" > "$T/weekly_continuation.json"
  printf '%s\n' "$rid" > "$T/tune_run_id"
}

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

# 4) pending de semana anterior, unidad inactiva → se recupera (no por semana ISO)
new_record pending
OUT=$(TUNE_START_CMD=true bash "$REC" 2>&1); RC=$?
[ "$RC" = "0" ] && echo "$OUT" | grep -q "requeued" && ok "pending se recupera" || bad "no recuperó pending: $OUT"

# 5) pending + unidad ACTIVA → running, sin incrementar intentos
new_record pending "run-activo" 0
OUT=$(TUNE_STATE_CMD='echo active' bash "$REC" 2>&1); RC=$?
[ "$RC" = "0" ] && echo "$OUT" | grep -q "running" && [ "$(jq -r '.attempts' "$T/weekly_continuation.json")" = "0" ] \
  && ok "pending+active no incrementa intentos" || bad "pending+active mal manejado: $OUT"

# 6) started + inactiva + Result=failed → interrumpida → reencola
new_record started "run-interr" 0
OUT=$(TUNE_STATE_CMD='echo inactive' TUNE_RESULT_CMD='echo failed' TUNE_START_CMD=true bash "$REC" 2>&1)
echo "$OUT" | grep -q "interrupted" && ok "started inactivo+failed → interrupted/requeue" || bad "no detectó interrupción: $OUT"

# 7) started + inactiva + Result=success → REPARA sin re-ejecutar
new_record started "run-ok-sin-completed" 0
OUT=$(TUNE_STATE_CMD='echo inactive' TUNE_RESULT_CMD='echo success' TUNE_START_CMD=false bash "$REC" 2>&1); RC=$?
[ "$RC" = "0" ] && echo "$OUT" | grep -q "repaired" && [ ! -f "$T/weekly_continuation.json" ] \
  && ok "Result=success → reparado sin re-ejecutar" || bad "no reparó un completado sin registro: $OUT"

# 8) stale + Result=success → repara; stale + failed → reintenta
new_record stale "run-stale-ok" 0
OUT=$(TUNE_STATE_CMD='echo inactive' TUNE_RESULT_CMD='echo success' bash "$REC" 2>&1)
echo "$OUT" | grep -q "repaired" && ok "stale+success → reparado" || bad "stale+success no reparó: $OUT"
new_record stale "run-stale-bad" 0
OUT=$(TUNE_STATE_CMD='echo inactive' TUNE_RESULT_CMD='echo failed' TUNE_START_CMD=true bash "$REC" 2>&1)
echo "$OUT" | grep -q "reintenta" && ok "stale+failed → reintenta" || bad "stale+failed no reintentó: $OUT"

# 9) failed → reintento
new_record failed
OUT=$(TUNE_STATE_CMD='echo inactive' bash "$REC" 2>&1)
echo "$OUT" | grep -q "reintenta" && ok "failed → reintenta" || bad "no reintentó failed: $OUT"

# 10) vencimiento por antigüedad (>5 días) → expired y exit 1
new_record pending "run-vieja" 0
jq -c '.createdAt="2026-10-01T00:00:00Z"' "$T/weekly_continuation.json" > "$T/x" && mv "$T/x" "$T/weekly_continuation.json"
OUT=$(TUNE_START_CMD=true bash "$REC" 2>&1); RC=$?
[ "$RC" = "1" ] && echo "$OUT" | grep -q "vencida" && [ "$(state)" = "expired" ] && ok "antigüedad → expired (rc=1)" || bad "no expiró por antigüedad: $OUT"

# 11) expirado explícito → rc=1 (semántica de "requiere atención")
OUT=$(bash "$REC" 2>&1); RC=$?
[ "$RC" = "1" ] && echo "$OUT" | grep -q "expired" && ok "expired → rc=1" || bad "expired con rc incorrecto: $OUT"

# 12) exceso de intentos → expired
new_record pending "run-muchos" 3
OUT=$(TUNE_START_CMD=true bash "$REC" 2>&1); RC=$?
[ "$RC" = "1" ] && echo "$OUT" | grep -q "superó" && ok "intentos → expired" || bad "no expiró por intentos: $OUT"

# 13) tune manual SIN identidad → no consume la obligación
new_record pending "run-semanal" 0
rm -f "$T/tune_run_id"
BEFORE=$(state)
TUNE_CMD=true bash "$WRAP" >/dev/null 2>&1
[ "$(state)" = "$BEFORE" ] && ok "tune manual sin runId no consume" || bad "tune manual sin runId alteró el registro"

# 14) tune manual CON identidad pendiente → la consume (documentado)
new_record pending "run-consumo" 0
TUNE_CMD=true bash "$WRAP" >/dev/null 2>&1
[ "$(state)" = "completed" ] && ok "tune con runId pendiente consume (documentado)" || bad "no consumió la obligación: $(state)"

rm -rf "$T"
echo
[ "$FAIL" = "0" ] && echo "AUTOTEST OK" || { echo "AUTOTEST FALLÓ"; exit 1; }
