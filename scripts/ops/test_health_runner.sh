#!/bin/bash
# H07: el job de health debe FALLAR si algún activo no persiste su health.
# Se inyecta HEALTH_CMD para no usar Firestore ni velas.
# Uso: bash scripts/ops/test_health_runner.sh
set -u
R=/opt/JARVIS/scripts/periodic_opt/run_detection_health.sh
FAIL=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; FAIL=1; }

OUT=$(HEALTH_POOL=EURUSD HEALTH_CMD='echo HEALTH_FIRESTORE_SKIP' HEALTH_ERRLOG=/tmp/hf_test.log bash "$R" 2>&1); RC=$?
[ "$RC" = "1" ] && echo "$OUT" | grep -q "HEALTH_JOB_FAILED" && ok "sin persistir → rc=1 y job falla" || bad "skip no falló el job: rc=$RC"

OUT=$(HEALTH_POOL=EURUSD HEALTH_CMD='echo HEALTH_SAVED' HEALTH_ERRLOG=/tmp/hf_test.log bash "$R" 2>&1); RC=$?
[ "$RC" = "0" ] && echo "$OUT" | grep -q "FIN health-all (fallos: 0)" && ok "guardado → rc=0" || bad "camino OK falló: rc=$RC"

OUT=$(HEALTH_POOL=EURUSD HEALTH_CMD=false HEALTH_ERRLOG=/tmp/hf_test.log bash "$R" 2>&1); RC=$?
[ "$RC" = "1" ] && ok "falla dura (rc!=0) → job falla" || bad "falla dura no propagada: rc=$RC"

OUT=$(HEALTH_POOL='EURUSD GBPUSD' HEALTH_CMD='echo HEALTH_FIRESTORE_SKIP' HEALTH_ERRLOG=/tmp/hf_test.log bash "$R" 2>&1); RC=$?
echo "$OUT" | grep -q "fallos: 2" && ok "dos activos fallidos se cuentan" || bad "no contó dos fallos"

[ "$FAIL" = "0" ] && echo "AUTOTEST OK" || { echo "AUTOTEST FALLÓ"; exit 1; }
