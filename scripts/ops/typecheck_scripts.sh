#!/bin/bash
# Typecheck de los scripts del Lote 3 (el tsconfig del proyecto sólo incluye src/**).
# tsx/esbuild NO chequea tipos: un `ticker` indefinido compila y revienta recién en runtime
# (bug real de la revisión 3b). Este check es parte del cierre del lote.
set -u
cd "$(cd "$(dirname "$0")/../.." && pwd)"
FILES="
scripts/ops/preset_apply_core.ts
scripts/ops/risk_allocator.ts
scripts/ops/risk_allocator_core.ts
scripts/ops/roster_proposal.ts
scripts/ops/shutdown_proposal.ts
scripts/ops/shutdown_weeks_core.ts
scripts/ops/live_sample_core.ts
scripts/ops/health_freshness_core.ts
scripts/ops/mcl_proposal_core.ts
scripts/ops/mcl_sync.ts
scripts/ops/prospective_test.ts
scripts/ops/prospective_promote.ts
scripts/ops/weekly_digest.ts
scripts/ops/test_weekly_e2e_audit.ts
scripts/tests/test_live_vs_backtest_parity.ts
scripts/history_lock.ts
scripts/fetch_history.ts
scripts/asset_scout.ts
scripts/ops/test_detection_apply.ts
scripts/ops/test_risk_allocator.ts
scripts/ops/test_live_sample.ts
scripts/ops/test_shutdown_weeks.ts
scripts/ops/test_health_freshness.ts
scripts/ops/test_counters_failclosed.ts
scripts/ops/test_token_singleflight.ts
scripts/ops/test_mcl_proposal.ts
scripts/ops/test_risk_caps.ts
scripts/periodic_opt/smc_detection_search.ts
"
FAIL=0
for f in $FILES; do
  err=$(timeout 120 npx tsc --noEmit --skipLibCheck --strict --target es2022 --module nodenext --moduleResolution nodenext "$f" 2>&1 | grep -E "^${f//./\\.}\(")
  if [ -n "$err" ]; then echo "$err"; FAIL=1; fi
done
if [ "$FAIL" = "0" ]; then echo "SCRIPTS TYPECHECK OK"; else echo "SCRIPTS TYPECHECK FALLÓ"; exit 1; fi
