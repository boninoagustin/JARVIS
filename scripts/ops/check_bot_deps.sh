#!/bin/bash
# check_bot_deps.sh — ¿quién usa qué y sigue existiendo?
#
# Detecta el patrón que rompió el bot dos veces (commit f71d6c2): borrar un archivo/ruta
# compartida sin revisar consumidores. Verifica:
#   1) que ningún import de los archivos que CORRE el bot (src/ runtime + los scripts del
#      ciclo semanal) apunte a un archivo inexistente;
#   2) que las rutas de Kronos que el ciclo invoca (KRONOS}/api/...) sigan en main.py.
#
# No bloquea: el ciclo lo corre con prefijo '-' y queda en el journal.
# A mano: bash scripts/ops/check_bot_deps.sh
set -u
cd /opt/JARVIS || exit 1
FAIL=0

python3 - <<'PY'
import re, pathlib, sys
ROOT = pathlib.Path('/opt/JARVIS')

# Scripts que ejecuta el ciclo semanal (systemd + run_weekly.py). Los mantenés acá para que
# un borrado futuro de cualquiera de ellos —o de algo que importan— quede señalado.
ENTRY = """
scripts/periodic_opt/update_adr_guarded.ts
scripts/periodic_opt/run_weekly.py
scripts/periodic_opt/eval_production.ts
scripts/periodic_opt/get_active_tickers.ts
scripts/periodic_opt/sizing_weekly_proposal.ts
scripts/periodic_opt/loser_triggers_proposal.ts
scripts/periodic_opt/apply_weekly.ts
scripts/periodic_opt/smc_detection_search.ts
scripts/periodic_opt/train_ml_weekly.py
scripts/periodic_opt/detection_diagnostic.ts
scripts/periodic_opt/tf_sweep_weekly.ts
scripts/periodic_opt/push_reports.js
scripts/periodic_opt/run_detection_tune.sh
scripts/periodic_opt/run_detection_health.sh
scripts/periodic_opt/tune_run_wrapper.sh
scripts/periodic_opt/chain_mark_and_tune.sh
scripts/periodic_opt/recover_tune_pending.sh
scripts/periodic_opt/run_scout_guard.sh
scripts/periodic_opt/snapshot_isolation.py
scripts/periodic_opt/weekly_cycle_state.py
scripts/history_lock.ts
scripts/blocked_signals_eval.ts
scripts/corr_gate_eval.ts
scripts/exits_gate_eval.ts
scripts/health_check.ts
scripts/rollover_eval.ts
scripts/timesfm_gate_eval.ts
scripts/ml_threshold_sweep.ts
scripts/train_ml_model.py
scripts/killswitch_tune.ts
scripts/bias_confluence_tune.ts
scripts/hyperopt/collect_triggers.ts
scripts/per_trigger_tune.ts
scripts/get_current_sessions.ts
scripts/fetch_history.ts
scripts/montecarlo_validation.ts
scripts/directional_mcl_tune.ts
scripts/ote_vs_directo.ts
scripts/trigger_parity_report.ts
scripts/ops/mcl_sync.ts
scripts/ops/model_health.ts
scripts/ops/prospective_promote.ts
scripts/ops/prospective_test.ts
scripts/ops/risk_allocator.ts
scripts/ops/roster_proposal.ts
scripts/ops/shutdown_proposal.ts
scripts/ops/weekly_digest.ts
scripts/asset_scout.ts
""".strip().splitlines()

files = [ROOT / e for e in ENTRY]
# runtime del bot (src/), excluyendo tests/debug
files += [f for f in ROOT.glob('src/**/*.ts')
          if not any(x in str(f) for x in ['.test.ts', '_debug.ts', '/tests/', '.bak'])]

def resolve(f: pathlib.Path, spec: str):
    if not spec.startswith('.'):
        return True
    base = f.parent / spec
    return any(c.exists() for c in [base, base.with_suffix('.ts'), base.with_suffix('.tsx'), base.with_suffix('.js'),
                                    base/'index.ts', base/'index.tsx', base/'index.js'])

missing_files = []
broken_imports = []
for f in files:
    if not f.exists():
        missing_files.append(f.relative_to(ROOT))
        continue
    txt = f.read_text(errors='ignore')
    specs = re.findall(r"from\s+['\"]([^'\"]+)['\"]", txt) + re.findall(r"import\s*\(\s*['\"]([^'\"]+)['\"]", txt)
    for spec in dict.fromkeys(specs):
        if spec.startswith('.') and not spec.endswith('.json') and not resolve(f, spec):
            broken_imports.append(f"{f.relative_to(ROOT)}  ->  {spec}")

rc = 0
if missing_files:
    print("ARCHIVOS DEL CICLO FALTANTES:")
    for m in missing_files:
        print("  " + str(m))
    rc = 1
if broken_imports:
    print("IMPORTS ROTOS EN ARCHIVOS DEL BOT:")
    for b in broken_imports:
        print("  " + b)
    rc = 1
if rc == 0:
    print("archivos e imports del bot OK")

# Rutas de Kronos que el ciclo invoca
main = (ROOT / 'kronos_api' / 'main.py').read_text(errors='ignore')
routes = set()
for src in list(ROOT.glob('scripts/**/*.py')) + list(ROOT.glob('scripts/**/*.ts')):
    s = str(src)
    if any(x in s for x in ['.bak', '/tests/', '/opt_out/', '.venv']):
        continue
    txt = src.read_text(errors='ignore')
    routes |= set(re.findall(r'KRONOS\}(/api/[a-z0-9/_-]+)', txt))
    routes |= set(re.findall(r':8000(/api/[a-z0-9/_-]+)', txt))
miss_routes = [r for r in sorted(routes) if r not in main]
if miss_routes:
    print("RUTAS KRONOS BORRADAS:")
    for m in miss_routes:
        print("  " + m)
    rc = 1
else:
    print(f"rutas Kronos OK ({len(routes)} verificadas)" if routes else "rutas Kronos OK (0 plantillas)")

sys.exit(rc)
PY
[ $? -ne 0 ] && FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "BOT_DEPS_CHECK FALLÓ"
  exit 1
fi
echo "BOT_DEPS_CHECK OK"
