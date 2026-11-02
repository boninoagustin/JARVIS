#!/usr/bin/env python3
"""Weekly optimization with one frozen production/evaluation contract.

After refresh/precompute: snapshot production once, select on Train only, assemble
all supported changes, evaluate_final, compare Validation and bootstrap the final
candidate. Historic Validation is selection_validation, never independent Test.
Authorized production runs deploy exact validated improvements and track them.
Fixture/research/verification runs never deploy. No model promotion/preset rewrite.
Use --verification --config-file ASSET.json --tickers EURUSD --output-dir /tmp/...
for isolated budgets; --skip-aux/--skip-ml can reduce an explicitly agreed smoke.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path("/opt/JARVIS")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / 'scripts' / 'hyperopt'))
from objective_adapter import canonicalize_result, canonical_metrics
VENV_PY = REPO / "scripts" / "hyperopt" / ".venv" / "bin" / "python"
HYPEROPT = REPO / "scripts" / "hyperopt" / "run_hyperopt.py"
EVAL_PROD = HERE / "eval_production.ts"
KS_TUNE = REPO / "scripts" / "killswitch_tune.ts"
BIAS_CF_TUNE = REPO / "scripts" / "bias_confluence_tune.ts"  # Paso 1b (sep-2026): confluencia de bias por activo — PROPONE, no aplica
AUDIT_LOG = REPO / "logs" / "timesfm_audit.jsonl"
REPORTS_DIR = HERE / "reports"
OPT_OUT_DIR = HERE / "opt_out"
# Checkpoint de ciclo (22-sep-2026): si el ciclo muere (timeout/kill), --resume salta
# los tickers ya completados en ESTE ciclo. Se borra al terminar exitosamente.
PROGRESS_FILE = OPT_OUT_DIR / "weekly_progress.json"
KRONOS = "http://127.0.0.1:8000"
FIREBASE_PROJECT = "jarvis-67f66"

# F4 (07-sep-2026): etapa de colecta + precompute de forecasts TimesFM.
# El umbral minScoreToOverrideReject ahora es un dim del hyperopt; para que las
# trials lo midan de verdad, el backtest corre CON filtro sobre un cache de
# forecasts precomputados con look-ahead cero (precompute_forecasts.py).
VENV_TIMESFM = REPO / "scripts" / "timesfm" / ".venv" / "bin" / "python"
PRECOMPUTE = REPO / "scripts" / "timesfm" / "precompute_forecasts.py"
COLLECT_TS = REPO / "scripts" / "hyperopt" / "collect_triggers.ts"
SIZING_PROPOSAL = HERE / "sizing_weekly_proposal.ts"
LOSER_TRIGGERS_PROPOSAL = HERE / "loser_triggers_proposal.ts"
# 🆕 sep-2026 (paso 2b, reorganización dueño-único): tune por sesión×gatillo.
# per_trigger_tune.ts es el DUEÑO de minScore/slBuff/tp2/gestión por gatillo.
# Corre en --dry-run (PROPONE) y su salida se mergea en report.session_apply
# → el panel "Revisar y aplicar" lo aplica junto al resto. NO escribe Firestore.
PER_TRIGGER_TUNE = REPO / "scripts" / "per_trigger_tune.ts"
GET_CURRENT_SESSIONS = REPO / "scripts" / "get_current_sessions.ts"
TRIGGER_TUNE_ENABLED = True
# 🆕 sep-2026 (paso 1.5a, Capa 2 del optimizador del motor): bruteforcer de presets SMC
# (pivot/wick/div/z por TF, gatillos 5m). PROPONE optimized_preset_{ticker}_proposal.json
# (NO toca el preset vivo). Aplicación manual vía load_best_params.py cuando Bon aprueba
# → el dominical siguiente re-exporta los CSVs con el preset nuevo.
SMC_BRUTEFORCER = REPO / "scripts" / "smc_bruteforcer.ts"
BRUTEFORCER_ENABLED = False  # 🆕 21-sep-2026: smc_bruteforcer.ts está DEPRECATED y genera
# propuestas degeneradas (0 trades) en activos nuevos. Los bloques TF del motor no se
# validan por backtest (eventos pre-horneados) → sin propuestas hasta reemplazarlo.
# 🆕 16-sep-2026: descargador de velas cTrader — el paso 0 re-procesaba velas congeladas
# (ago-14); ahora SIEMPRE se descargan velas frescas del broker ANTES del export.
# fetch_history.ts SOBRESCRIBE cada history_<TF>.csv con la ventana que sirve cTrader
# (M5 ≈ 7 semanas, M15 ≈ 7 meses, H1 ≈ 10 meses, H4/D1 ≈ años) → dataset 100% cTrader.
FETCH_HISTORY = REPO / "scripts" / "fetch_history.ts"
FETCH_ENABLED = True
# 🆕 sep-2026 (paso 9, auto-aplicación por decisión de Bon): aplica automático lo que
# pasa los gates estadísticos. El panel queda como auditor + revert (snapshots en
# reports/prev_*.json). Apagar = desactivar con este flag.
AUTO_APPLY_ENABLED = True  # autorización de Bon: mejoras evaluadas + MC, respaldo y seguimiento posterior

# 🛡️ Sizing fraccional (sep-2026): propuesta del dominical (factores por sesión, n>=8, gate MC).
# DESACTIVADO hasta OK de Bon — el módulo corre solo si este flag es True. PROPONE, NO aplica.
SIZING_PROPOSAL_ENABLED = True
# DSR is diagnostic on selection-Validation, NOT an independent Test or a final
# pipeline certificate. Missing trial dispersion => unavailable, never unit-scale
# calibration. Train dispersion must not be transplanted into Validation.
DSR_ENFORCE = False

# 🔴 Gatillos perdedores (09-sep-2026, idea de Bon): el dominical mide exp por gatillo con el
# motor real + config de producción y PROPONE apagar (minScore=99) los perdedores persistentes
# (n>=10, exp<=-0.15). Escribe reports/loser_triggers_proposal.json. NO aplica (regla de oro).
LOSER_TRIGGERS_ENABLED = True

TICKERS_ALL = ["EURUSD", "GBPUSD", "AUDCAD", "US500", "XAUUSD", "USDJPY", "NZDUSD", "GBPJPY", "AUDJPY", "GER40", "JP225"]

MIN_NEW_TRADES = 20
EXP_GAIN_R = 0.05
DD_IMPROVE = 0.15
PNL_DROP_MAX = 0.15
WEEK_MS = 7 * 24 * 3600 * 1000


def get_api_key() -> str:
    env = REPO / "jarvis-os" / ".env"
    for line in env.read_text().splitlines():
        if line.startswith("VITE_FIREBASE_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("no se encontró VITE_FIREBASE_API_KEY en jarvis-os/.env")


def rest_json(url: str):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read())


def last_candle_ms(ticker: str) -> int:
    """Fecha de la ÚLTIMA vela del archivo de velas crudas (verdad de frescura).
    16-sep-2026: antes la frescura se medía por mtime del CSV procesado — el re-export
    con presets nuevos tocaba el mtime y fingía datos frescos sobre velas congeladas."""
    p = REPO / "logs" / ticker.lower() / "history" / "history_M5.csv"
    if not p.exists():
        return 0
    try:
        last_line = p.read_text().strip().splitlines()[-1]
        return int(last_line.split(",")[0])
    except Exception:
        return 0


def refresh_csvs(ticker: str) -> dict:
    """Regenera los CSVs SMC del ticker vía Kronos. Devuelve {ok, tfs, newest_mtime_ms}."""
    url = (f"{KRONOS}/api/backtest/export-csv?"
           + urllib.parse.urlencode({"ticker": ticker, "tfs": "M5,M15,H1,H4,D1"}))
    t0 = time.time()
    req = urllib.request.Request(url, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60 * 40) as r:
            res = json.loads(r.read())
    except Exception as e:
        return {"ok": False, "error": f"refresh HTTP: {e}"}
    ok = all(v.get("ok") for v in (res.get("results") or {}).values()) if isinstance(res, dict) else False
    d = REPO / "logs" / ticker.lower() / "history_exported"
    newest = 0
    if d.exists():
        for f in d.iterdir():
            if f.is_file():
                newest = max(newest, int(f.stat().st_mtime * 1000))
    print(f"    refresh OK ({time.time()-t0:.0f}s) | newest CSV: {datetime.fromtimestamp(newest/1000, tz=timezone.utc):%Y-%m-%d %H:%M} UTC" if ok else f"    ❌ refresh: {res}", flush=True)
    return {"ok": ok, "newest_mtime_ms": newest, "detail": res if not ok else None}


def count_new_trades(api_key: str, ticker: str, since_ts: int) -> int:
    url = (f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}"
           f"/databases/(default)/documents/trade_journal?key={api_key}&pageSize=400")
    n = 0
    for doc in rest_json(url).get("documents", []):
        f = doc.get("fields", {})
        if f.get("ticker", {}).get("stringValue", "").upper() != ticker:
            continue
        ts = f.get("timestamp", {}).get("integerValue")
        if ts and int(ts) > since_ts:
            n += 1
    return n


def load_last_report(ticker: str) -> dict:
    p = REPORTS_DIR / f"{ticker}.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {}


def collect_and_precompute(ticker: str) -> dict:
    """F4: 1 pasada collectOnly del backtest (config laxa) + precompute de forecasts
    TimesFM en los orígenes colectados (look-ahead cero). Devuelve stats del cache."""
    t_lower = ticker.lower()
    triggers_p = REPO / "logs" / t_lower / "forecasts" / "triggers_m5.jsonl"
    forecasts_p = REPO / "logs" / t_lower / "forecasts" / "forecasts_m5.jsonl"
    forecasts_p.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    r = subprocess.run(["npx", "tsx", str(COLLECT_TS), ticker], cwd=str(REPO),
                       capture_output=True, text=True, timeout=30 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"colecta exit {r.returncode}: {(r.stderr or r.stdout)[-300:]}")
    origins = 0
    if triggers_p.exists():
        origins = sum(1 for _ in triggers_p.open() if _.strip())
    print(f"    colecta OK ({time.time()-t0:.0f}s) | {origins} orígenes de trigger", flush=True)
    if origins == 0:
        raise RuntimeError("colecta devolvió 0 orígenes — nada que forecastear")

    t0 = time.time()
    r = subprocess.run(
        [str(VENV_TIMESFM), str(PRECOMPUTE), "--ticker", t_lower, "--tf", "M5",
         "--triggers", str(triggers_p), "--out", str(forecasts_p),
         "--horizon", "12", "--context", "512"],
        cwd=str(REPO), capture_output=True, text=True, timeout=90 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"precompute exit {r.returncode}: {(r.stderr or r.stdout)[-300:]}")
    forecasts = 0
    if forecasts_p.exists():
        forecasts = sum(1 for _ in forecasts_p.open() if _.strip())
    skipped = origins - forecasts
    print(f"    precompute OK ({time.time()-t0:.0f}s) | {forecasts}/{origins} forecasts ({skipped} skipped)", flush=True)
    return {"origins": origins, "forecasts": forecasts, "skipped": skipped,
            "cache": str(forecasts_p)}


def run_montecarlo_gate(ticker: str, oos_r: list) -> dict | None:
    """MC gate (sep-2026): bootstrap de robustez sobre los r-multiples OOS de producción.
    Degrada RECOMMEND→HOLD_MC si el edge no sobrevive al resampling. NO aplica nada."""
    if not oos_r or len(oos_r) < 10:
        return {"note": "pocos trades OOS para MC", "skip": True}
    import tempfile
    tmp = Path(tempfile.gettempdir()) / f'jarvis-mc-{ticker}-{time.time_ns()}.json'
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps([{"rMultiple": float(r)} for r in oos_r]))
    try:
        r = subprocess.run(
            ["npx", "tsx", str(REPO / "scripts" / "montecarlo_validation.ts"), str(tmp), "--mode", "bootstrap"],
            cwd=str(REPO), capture_output=True, text=True, timeout=15 * 60,
        )
        if r.returncode:
            return {'error': f'MC exit {r.returncode}: {(r.stderr or r.stdout)[-300:]}'}
        out = r.stdout or ""
        surv_line = next((l for l in out.splitlines() if "Supervivencia" in l), "")
        verdict_line = next((l for l in out.splitlines() if "🧾" in l), "")
        import re as _re
        m = _re.search(r"\((\d+(?:\.\d+)?)%\)", surv_line)
        survival = float(m.group(1)) / 100 if m else None
        verdict = verdict_line.split("🧾", 1)[-1].strip() if verdict_line else ""
        return {"survival": survival, "verdict": verdict, "n": len(oos_r),
                "verdict_short": verdict.split("—", 1)[0].strip() if verdict else "?"}
    except Exception as e:
        return {"error": str(e)[:200]}
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def run_dsr_gate(ticker: str, oos_r: list, n_trials: int) -> dict:
    """Report calibration availability; an Optuna counter is not the full search."""
    sys.path.insert(0, str(HERE))
    try:
        from dsr import deflated_sharpe
    except ImportError:
        return {"skip": True, "note": "dsr.py no disponible"}
    if not oos_r or not n_trials:
        return {"skip": True, "note": "sin serie OOS o sin n_trials"}
    result = deflated_sharpe(oos_r, n_trials)
    return {**result, 'partition':'selection_validation',
            'final_pipeline_dsr_certified':False,
            'selection_coverage':'Optuna count only; GA/KS/bias/Validation not calibrated',
            'enforced':False}


def objective_diagnostics(production_result: dict, candidate_result: dict) -> dict:
    """Sidecar only: no status, certificate, application, or search mutation."""
    def entry(result):
        return {'available': result.get('objective_version') == canonical_metrics.OBJECTIVE_VERSION,
                'legacy_score':result.get('objective'),
                'shadow':result.get('objective_shadow'),
                'metrics':result.get('metrics_train')}
    return {'active_version':canonical_metrics.OBJECTIVE_VERSION,
            'shadow_version':canonical_metrics.SHADOW_VERSION,
            'partition':'train','changes_selection':False,'final_pipeline_dsr_certified':False,
            'production_train':entry(production_result),'candidate_train':entry(candidate_result),
            'note':'experimental uncalibrated weights; no Test ranking; not a prop-firm equity limit'}


def shadow_week(ticker: str) -> dict:
    """Resumen del shadow TimesFM de los últimos 7 días desde logs/timesfm_audit.jsonl."""
    if not AUDIT_LOG.exists():
        return {"n": 0, "note": "audit vacío"}
    now = time.time() * 1000
    agg = {"n": 0, "approve": 0, "downgrade": 0, "reject": 0}
    try:
        for line in AUDIT_LOG.read_text().splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if str(e.get("ticker", "")).upper() != ticker:
                continue
            if now - int(e.get("ts") or 0) > WEEK_MS:
                continue
            agg["n"] += 1
            # 🔧 FIX: el audit escribe `action` (APPROVE/REDUCE/REJECT), no `decision`.
            # Antes esto leía un campo inexistente → TODO caía en "downgrade".
            decision = str(e.get("action") or e.get("decision") or "").upper()
            if decision in ("APPROVE", "APROBAR", "HOLD", "MANTENER"):
                agg["approve"] += 1
            elif decision in ("REJECT", "RECHAZAR"):
                agg["reject"] += 1
            else:
                agg["downgrade"] += 1
    except Exception as e:
        agg["note"] = f"error leyendo audit: {e}"
    return agg


def compare(prop_oos: dict, prod_oos: dict) -> dict:
    exp_p = float(prop_oos.get("expectancy") or 0)
    exp_d = float(prod_oos.get("expectancy") or 0)
    dd_p = float(prop_oos.get("max_drawdown_r") or 0)
    dd_d = float(prod_oos.get("max_drawdown_r") or 0)
    pnl_p = float(prop_oos.get("net_pnl_r") or 0)
    pnl_d = float(prod_oos.get("net_pnl_r") or 0)
    d_exp = exp_p - exp_d
    dd_ratio = (dd_d - dd_p) / max(dd_d, 1.0)
    pnl_drop = (pnl_d - pnl_p) / max(pnl_d, 1.0) if pnl_d > 0 else 0.0
    status = "HOLD"
    if d_exp >= EXP_GAIN_R:
        status = "RECOMMEND"
    elif dd_ratio >= DD_IMPROVE and pnl_drop <= PNL_DROP_MAX:
        status = "RECOMMEND"
    return {"d_exp_oos": round(d_exp, 3), "dd_improve_ratio": round(dd_ratio, 3),
            "pnl_drop_ratio": round(pnl_drop, 3), "status": status}


def deep_merge(base: dict, changes: dict) -> dict:
    """Copy-on-merge: never mutate the production snapshot or a certified candidate."""
    import copy
    out = copy.deepcopy(base)
    for key, value in changes.items():
        if key != 'minimal_roi' and isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def assemble_candidate(production: dict, report: dict) -> dict:
    import copy
    changes = {k: v for k, v in (report.get("best_config") or {}).items() if k not in ('ticker', 'entryTrigger', 'entryStrategy', 'minRR', 'mlGate', 'spreadPips', 'commissionPerLot', 'sessionFilter', 'collectOnly')}
    candidate = deep_merge(production, changes)
    if report.get('session_apply_replace'):
        candidate['sessions'] = copy.deepcopy(report.get('session_apply') or {})
    else:
        candidate['sessions'] = deep_merge(candidate.get('sessions') or {}, report.get('session_apply') or {})
    tfm = {k: v for k, v in (report.get("timesfm_apply") or {}).items() if k != "source"}
    if tfm:
        candidate["timesfm"] = deep_merge(candidate.get("timesfm") or {}, tfm)
    for key in ("maxDailyLossR", "maxConsecutiveLosses", "maxTradesPerDay", "trailingDrawdownR"):
        if key in (report.get("ks_proposal") or {}):
            candidate[key] = report["ks_proposal"][key]
    for key, value in (report.get("directional_mcl") or {}).get("updates", {}).items():
        parts = key.split(".")
        if len(parts) != 3 or parts[0] != "sessions" or parts[2] not in ("maxBuyLosses", "maxSellLosses"):
            raise ValueError(f"unsupported directional MCL field: {key}")
        candidate["sessions"].setdefault(parts[1], {})[parts[2]] = value
    bias = report.get("bias_confluence") or {}
    if bias.get("status") == "RECOMMEND" and bias.get("recommended"):
        candidate["biasConfluence"] = bias["recommended"]["bc"]
    for change in (report.get("loser_triggers") or {}).get("disables", []):
        candidate["sessions"].setdefault(change["session"], {}).setdefault(change["trigger"], {})["minScore"] = 99
    for change in (report.get('loser_triggers') or {}).get('enables', []):
        candidate['sessions'].setdefault(change['session'], {}).setdefault(change['trigger'], {}).update(minScore=4, enabled=True)
    return candidate


def json_fingerprint(value: dict) -> str:
    """Use actual JS JSON number/string semantics, identical to worker/apply hashes."""
    source = "const fs=require('fs'),crypto=require('crypto'); const v=JSON.parse(fs.readFileSync(0,'utf8')); const c=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(c).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+c(x[k])).join(',')+'}'; process.stdout.write(crypto.createHash('sha256').update(c(v)).digest('hex'));"
    return subprocess.run(['node', '-e', source], input=json.dumps(value, allow_nan=False), capture_output=True, text=True, check=True).stdout


def selection_command(script, ticker, manifest_path, snapshot_path, logs_dir, *extra) -> list[str]:
    return ['npx', 'tsx', str(script), ticker, '--evaluation-manifest', str(manifest_path),
            '--config-file', str(snapshot_path), '--logs-dir', str(logs_dir), '--dry-run', *map(str, extra)]


def assemble_asset_snapshot(asset: dict, production_config: dict, candidate: dict) -> dict:
    import copy
    out = copy.deepcopy(asset)
    aliases = {'minBuyPoints': 'minPointsForBuy', 'minSellPoints': 'minPointsForSell'}
    engine_only = {'ticker', 'mlGate', 'spreadPips', 'commissionPerLot', 'sessionFilter', 'collectOnly', 'minRR', 'entryStrategy'}
    for key, value in candidate.items():
        if key in engine_only or (key in production_config and value == production_config[key]):
            continue
        if key == 'timesfm':
            value = copy.deepcopy(value)
            if 'cachePath' not in (asset.get('timesfm') or {}):
                value.pop('cachePath', None)
        out[aliases.get(key, key)] = copy.deepcopy(value)
    return out


def validate_certified_report(report: dict) -> bool:
    cert = report.get('evaluation_certificate') or {}
    checks = (
        cert == report.get('certificate'),
        cert.get('config_fingerprint') == json_fingerprint(report.get('final_config') or {}),
        cert.get('asset_fingerprint') == json_fingerprint(report.get('final_asset_config') or {}),
        cert.get('version') == 1,
        cert.get('evaluation_fingerprint') == report.get('evaluation_fingerprint') == json_fingerprint(report.get('evaluation_provenance') or {}),
        (report.get('evaluation_provenance') or {}).get('evaluation_manifest') == report.get('evaluation_manifest'),
        report.get('config_fingerprint') == cert.get('config_fingerprint') == (report.get('montecarlo') or {}).get('config_fingerprint'),
        report.get('evaluation_fingerprint') == (report.get('montecarlo') or {}).get('evaluation_fingerprint'),
        cert.get('montecarlo_config_fingerprint') == cert.get('config_fingerprint'),
        cert.get('validation_role') == 'selection_validation',
        report.get('production_asset_fingerprint') == json_fingerprint(report.get('production_asset_snapshot') or {}),
        report.get('final_asset_fingerprint') == cert.get('asset_fingerprint'),
        report.get('selection_payload_fingerprint') == json_fingerprint({k: report.get(k) for k in ('best_config', 'session_apply', 'session_apply_replace', 'timesfm_apply', 'ks_proposal', 'directional_mcl', 'bias_confluence', 'loser_triggers')}),
    )
    if not all(checks):
        report.update(status='HOLD_INTEGRITY', apply_eligible=False, reason='candidate/manifest changed after certification or worker fingerprint mismatch')
        return False
    return True


def certify_report(report: dict, production_config: dict, production_asset: dict, production_result: dict,
                   manifest: dict, evaluate, montecarlo=run_montecarlo_gate) -> dict:
    """Only gate after ALL applicable train-selected changes are assembled. Test is diagnostic."""
    import copy
    candidate = assemble_candidate(production_config, report)
    result = evaluate(copy.deepcopy(candidate))
    effective = result.get('config') or result.get('effective_config') or candidate
    # Frozen base is already worker-resolved. Other than gate/cache normalization,
    # a worker silently evaluating a different proposal must fail closed.
    candidate_inputs = {k: v for k, v in candidate.items() if k not in ('mlGate', 'timesfm')}
    effective_inputs = {k: v for k, v in effective.items() if k not in ('mlGate', 'timesfm')}
    candidate = copy.deepcopy(effective)
    asset = assemble_asset_snapshot(production_asset, production_config, candidate)
    expected = json_fingerprint(candidate)
    provenance = result.get('provenance') or {}
    evaluation_hash = json_fingerprint(provenance)
    production_hash = production_result.get('evaluation_fingerprint')
    report.update(final_config=candidate, final_asset_config=asset, final_asset_fingerprint=json_fingerprint(asset),
                  production_asset_snapshot=copy.deepcopy(production_asset), production_asset_fingerprint=json_fingerprint(production_asset),
                  evaluation_manifest=copy.deepcopy(manifest), evaluation_provenance=copy.deepcopy(provenance),
                  config_fingerprint=expected, final_config_fingerprint=expected, evaluation_fingerprint=evaluation_hash)
    if (candidate_inputs != effective_inputs or provenance.get('evaluation_manifest') != manifest
            or result.get('config_fingerprint') != expected or result.get('evaluation_fingerprint') != evaluation_hash
            or production_hash != evaluation_hash
            or json_fingerprint(production_result.get('provenance') or {}) != production_hash):
        report.update(status='HOLD_INTEGRITY', apply_eligible=False, reason='worker config/evaluation fingerprint mismatch')
        return report
    report['proposal_validation'] = result.get('metrics_validation')
    report['objective_diagnostics'] = objective_diagnostics(production_result, result)
    report['production_validation'] = production_result.get('metrics_validation')
    report['proposal_oos'] = result.get('metrics_validation')  # legacy alias: NOT independent OOS
    report['production_oos'] = production_result.get('metrics_validation')
    report['metrics_test'] = result.get('metrics_test')
    report['test_evidence'] = copy.deepcopy(result.get('test_evidence'))
    report['final_validation_r'] = result.get('validation_r') or []
    report['proposal_test'] = result.get('metrics_test')
    report['production_test'] = production_result.get('metrics_test')
    report['delta'] = compare(result.get('metrics_validation') or {}, production_result.get('metrics_validation') or {})
    report['status'] = report['delta']['status']
    mc = montecarlo(report.get('ticker') or candidate.get('ticker'), result.get('validation_r') or []) or {}
    report['montecarlo'] = {**mc, 'config_fingerprint': expected, 'evaluation_fingerprint': evaluation_hash, 'partition': 'validation'}
    survival = mc.get('survival')
    if report['status'] == 'RECOMMEND' and (type(survival) not in (int, float) or not 0.80 <= survival <= 1):
        report['status'] = 'HOLD_MC'
    report['evaluation_certificate'] = dict(version=1, config_fingerprint=expected, asset_fingerprint=report['final_asset_fingerprint'],
        evaluation_fingerprint=evaluation_hash, montecarlo_config_fingerprint=expected,
        validation_role='selection_validation', test_independence='unverified',
        manifest_claimed_test_independence=manifest['test_independence'],
        test_evaluated=manifest['test_end_ms'] > manifest['validation_end_ms'] and result.get('metrics_test') is not None,
        evaluated_at_ms=int(time.time()*1000), test_evidence=copy.deepcopy(result.get('test_evidence')))
    report['certificate'] = report['evaluation_certificate']
    # Prospectivity needs an external future registry; a manifest assertion alone is not authorization.
    report['apply_eligible'] = False
    report['apply_hold_reason'] = 'independent prospective Test not registered/certified; validation is selection_validation'
    report['selection_payload_fingerprint'] = json_fingerprint({k: report.get(k) for k in ('best_config', 'session_apply', 'session_apply_replace', 'timesfm_apply', 'ks_proposal', 'directional_mcl', 'bias_confluence', 'loser_triggers')})
    validate_certified_report(report)
    return report


def sessions_apply_map(best_config: dict) -> dict:
    """Del best_config.sessions (esquema backtest) → lo que el motor LIVE lee por gatillo.
    F3-etapa3: además de enabled/entryPercent, ahora también la gestión de salida
    (partialClosePct, slAfterTp1, tp15BeEnabled, atrTrailEnabled, structuralTrailEnabled)
    que el vivo congela en trade.mgmtOverrides al entrar. tp1StructuralMinRR viaja por
    trigger para el AlphaModel (fallback a nivel activo)."""
    # 🆕 sep-2026 (dueño-único): con el overlay current-sessions, el best_config.sessions
    # trae los valores per-gatillo vigentes (minScore/slBuff/tp2 de per_trigger_tune) —
    # se mapean para que el panel los conserve; sin overlay no existen y no se emiten.
    MGMT_KEYS = ["partialClosePct", "slAfterTp1", "tp15BeEnabled", "atrTrailEnabled", "structuralTrailEnabled", "tp1StructuralMinRR"]
    PASSTHROUGH_KEYS = ["minScore", "slBuff", "tp2"]
    out: dict = {}
    for session, triggers in (best_config.get("sessions") or {}).items():
        s_out: dict = {}
        for trig, cfg in (triggers or {}).items():
            # 🆕 11-sep-2026: política gatillo-por-gatillo (solo-5M derogada por Bon tras el
            # dato del paso 8: AUDJPY.oteChoch15m +0.576R/t y XAUUSD.oteChoch15m +0.167R/t
            # son 15m ganadores). Los 15m perdedores los apaga el paso 8 per-gatillo.
            t_out: dict = {}
            if isinstance(cfg, dict):
                if "enabled" in cfg:
                    t_out["enabled"] = bool(cfg["enabled"])
                if "entryPercent" in cfg:
                    t_out["entryPercent"] = float(cfg["entryPercent"])
                for k in MGMT_KEYS + PASSTHROUGH_KEYS:
                    if k in cfg:
                        t_out[k] = cfg[k]
            if t_out:
                s_out[trig] = t_out
        if s_out:
            out[session] = s_out
    return out


def load_active_tickers_from_firestore() -> list[str]:
    """🔥 sep-2026: la lista de activos oficiales vive en Firestore
    (optimization_config/active_tickers). El panel la edita (promover candidatos
    del Asset Scout). Fallback: TICKERS_ALL clásico."""
    try:
        r = subprocess.run(
            ["npx", "tsx", str(HERE / "get_active_tickers.ts")],
            cwd=str(REPO), capture_output=True, text=True, timeout=180,
        )
        lines = [l for l in r.stdout.strip().splitlines() if l.strip().startswith("{")]
        if lines:
            data = json.loads(lines[-1])
            tickers = [t.strip().upper() for t in (data.get("tickers") or []) if t.strip()]
            if tickers:
                print(f"    🔥 active_tickers (Firestore, {data.get('source')}): {len(tickers)} activos", flush=True)
                return tickers
    except Exception as e:
        print(f"    ⚠️ no se pudo leer active_tickers de Firestore ({e}) — uso TICKERS_ALL", flush=True)
    return list(TICKERS_ALL)


def command_json(cmd: list[str], *, timeout: int = 900) -> dict:
    save_path = Path(cmd[cmd.index('--save')+1]) if '--save' in cmd else None
    if save_path:
        save_path.unlink(missing_ok=True)  # never accept a stale proposal artifact
    r = subprocess.run(cmd, cwd=str(REPO), capture_output=True, text=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(f"{Path(cmd[2] if cmd[0] == 'npx' else cmd[1]).name} exit {r.returncode}: {(r.stderr or r.stdout)[-500:]}")
    if save_path and save_path.exists():
        return json.loads(save_path.read_text())
    for line in reversed((r.stdout or '').splitlines()):
        if line.strip().startswith('{'):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    raise RuntimeError(f"command returned no JSON: {cmd}")


def weekly_rollout_allowed(args) -> bool:
    return AUTO_APPLY_ENABLED and not any(getattr(args, key, False) for key in (
        'verification', 'config_file', 'output_dir', 'wfa_shadow', 'no_apply',
        'evaluation_manifest', 'logs_dir', 'trades_file'))


def weekly_rollout_command(ticker: str, reports_dir: Path, *, followup_only: bool) -> list[str]:
    return ['npx', 'tsx', str(HERE / 'apply_weekly.ts'), '--weekly-rollout',
            '--reports-dir', str(reports_dir), '--tickers', ticker,
            '--followup-only' if followup_only else '--skip-followup']


def main() -> int:
    import tempfile
    ap = argparse.ArgumentParser(description='Frozen selection + final Validation + authorized exact weekly rollout.')
    ap.add_argument('--no-apply', action='store_true', help='Generate proposals only; no deployment or followup writes')
    ap.add_argument('--tickers', default=None)
    ap.add_argument('--min-new-trades', type=int, default=MIN_NEW_TRADES)
    for flag in ('skip-fetch', 'skip-refresh', 'skip-hyperopt', 'skip-timesfm', 'skip-telemetry', 'skip-aux', 'skip-ml', 'force', 'resume', 'verification'):
        ap.add_argument('--' + flag, action='store_true')
    ap.add_argument('--study-suffix', default='')
    ap.add_argument('--config-file', help='Single ticker asset fixture; no Firebase/key/journal/network reads')
    ap.add_argument('--evaluation-manifest', help='Single ticker explicit manifest; otherwise resolved once from current CSVs')
    ap.add_argument('--logs-dir', help='Single ticker exported CSV directory')
    ap.add_argument('--trades-file', help='Optional journal snapshot for sizing')
    ap.add_argument('--output-dir', help='Isolated reports, snapshots and Optuna storage root')
    ap.add_argument('--n-trials', type=int, default=None)
    ap.add_argument('--trigger-budget', type=int, default=None)
    ap.add_argument('--wfa-shadow', action='store_true', help='Opt-in isolated rolling WFA research; never apply or open Vault')
    ap.add_argument('--wfa-policy-file', help='Optional experimental WFA policy JSON; only with --wfa-shadow')
    args = ap.parse_args()
    if args.verification:
        args.skip_fetch = args.skip_refresh = args.skip_timesfm = args.skip_telemetry = True
        if not args.output_dir:
            args.output_dir = tempfile.mkdtemp(prefix='jarvis-weekly-verification-')
    n_trials = args.n_trials if args.n_trials is not None else (2 if args.verification or args.wfa_shadow else 400)
    trigger_budget = args.trigger_budget if args.trigger_budget is not None else (2 if args.verification or args.wfa_shadow else 80)
    if n_trials < 1 or trigger_budget < 1:
        ap.error('trial/tuning budgets must be positive')
    tickers = [t.strip().upper() for t in (args.tickers or '').split(',') if t.strip()]
    if args.wfa_shadow:
        if not args.config_file or not args.output_dir or len(tickers)!=1:
            ap.error('--wfa-shadow requires one explicit ticker, --config-file and isolated --output-dir')
        if args.evaluation_manifest or args.trades_file or args.skip_hyperopt or args.resume or args.study_suffix:
            ap.error('WFA uses its own fold identities; do not mix v1 manifest/resume/study/trades flags')
        if Path(sys.prefix).resolve()!=VENV_PY.parent.parent.resolve():
            if not VENV_PY.is_file():
                ap.error('WFA requires the project hyperopt virtualenv')
            return subprocess.run([str(VENV_PY),str(Path(__file__).resolve()),*sys.argv[1:]],cwd=str(REPO)).returncode
        if str(REPO) not in sys.path:
            sys.path.insert(0,str(REPO))
        from scripts.periodic_opt.wfa_runner import run_wfa_shadow
        result=run_wfa_shadow(ticker=tickers[0],
            log_dir=Path(args.logs_dir).resolve() if args.logs_dir else REPO/'logs'/tickers[0].lower()/'history_exported',
            asset_config=json.loads(Path(args.config_file).read_text()),output_dir=Path(args.output_dir),
            n_trials=n_trials,trigger_budget=trigger_budget,skip_aux=args.skip_aux,skip_ml=args.skip_ml,
            policy=json.loads(Path(args.wfa_policy_file).read_text()) if args.wfa_policy_file else None)
        print(json.dumps({'status':result['status'],'apply_eligible':False,'wfa_report':result.get('report_path')},allow_nan=False))
        return 0
    if args.wfa_policy_file:
        ap.error('--wfa-policy-file requires --wfa-shadow')
    if any((args.config_file, args.evaluation_manifest, args.logs_dir, args.trades_file)) and len(tickers) != 1:
        ap.error('explicit fixture/manifest/log paths require exactly one --tickers ticker')
    if args.config_file:
        if not args.output_dir:
            args.output_dir = tempfile.mkdtemp(prefix='jarvis-weekly-fixture-')
        args.skip_fetch = args.skip_refresh = args.skip_timesfm = args.skip_telemetry = True
    if not tickers:
        tickers = load_active_tickers_from_firestore()
    reports_dir = Path(args.output_dir).resolve() / 'reports' if args.output_dir else REPORTS_DIR
    opt_dir = Path(args.output_dir).resolve() / 'opt_out' if args.output_dir else OPT_OUT_DIR
    progress_file = opt_dir / 'weekly_progress.json'
    for d in (reports_dir, opt_dir):
        d.mkdir(parents=True, exist_ok=True)
    started_at = int(time.time() * 1000)
    done = set()
    if args.resume and progress_file.exists():
        progress = json.loads(progress_file.read_text())
        done = set(progress.get('done') or [])
        started_at = progress.get('started_at') or started_at
    progress_file.write_text(json.dumps({'started_at': started_at, 'done': sorted(done)}))
    if not args.skip_hyperopt:
        r = subprocess.run([sys.executable, str(HYPEROPT), '--help'], capture_output=True, text=True, timeout=60)
        text = (r.stdout or '') + (r.stderr or '')
        required = ('--current-sessions', '--timesfm-cache', '--evaluation-manifest', '--base-config', '--log-dir')
        missing = [flag for flag in required if flag not in text]
        if r.returncode or missing:
            print(f'PREFLIGHT FAIL: hyperopt wrapper missing flags {missing}', flush=True)
            return 1
    api_key = None if args.config_file else get_api_key()
    if FETCH_ENABLED and not args.skip_fetch and not args.skip_refresh:
        r = subprocess.run(['npx', 'tsx', str(FETCH_HISTORY)], cwd=str(REPO), capture_output=True, text=True, timeout=9000)
        if r.returncode:
            print(f'fetch_history failed: {(r.stderr or r.stdout)[-300:]}', flush=True)
            return 1
    summary = []
    for ticker in tickers:
        if ticker in done:
            continue
        print(f'═══ {ticker} ═══', flush=True)
        report = {'ticker': ticker, 'timestamp': int(time.time()*1000), 'status': 'HOLD', 'apply_eligible': False}
        try:
            last_path = reports_dir / f'{ticker}.json'
            last = json.loads(last_path.read_text()) if last_path.exists() else {}
            last_ts = int(last.get('timestamp') or 0)
            refresh = {'ok': True}
            if not args.skip_refresh:
                refresh = refresh_csvs(ticker)
            report['data_refreshed_at'] = refresh.get('newest_mtime_ms')
            if not refresh.get('ok'):
                raise RuntimeError(f"refresh failed: {refresh.get('error') or refresh.get('detail')}")
            if weekly_rollout_allowed(args):
                review = subprocess.run(weekly_rollout_command(ticker, reports_dir, followup_only=True),
                                        cwd=str(REPO), capture_output=True, text=True, timeout=3600)
                print(f"{ticker} seguimiento: {(review.stdout or review.stderr)[-1500:]}", flush=True)
                if review.returncode:
                    raise RuntimeError(f'followup dispatch failed: {(review.stderr or review.stdout)[-500:]}')
            new_trades = 0 if args.config_file else count_new_trades(api_key, ticker, last_ts)
            if not args.force and not args.verification and new_trades < args.min_new_trades and last_candle_ms(ticker) <= last_ts:
                report['reason'] = 'no fresh candles/journal: selection skipped (anti-overfit)'
            else:
                cache_p = None
                if not args.skip_timesfm:
                    try:
                        info = collect_and_precompute(ticker)
                        report['timesfm_cache'] = info
                        cache_p = Path(info['cache'])
                    except Exception as e:
                        report['timesfm_cache_error'] = str(e)[:300]
                logs_dir = Path(args.logs_dir).resolve() if args.logs_dir else REPO / 'logs' / ticker.lower() / 'history_exported'
                asset_file = opt_dir / f'production_asset_{ticker}.json'
                manifest_file = opt_dir / f'evaluation_manifest_{ticker}.json'
                base_file = opt_dir / f'production_backtest_{ticker}.json'
                prod_file = opt_dir / f'production_result_{ticker}.json'
                # This is the sole Firestore asset read. Snapshot-only also resolves
                # the worker's effective config and production metrics exactly once.
                snapshot_cmd = ['npx', 'tsx', str(EVAL_PROD), ticker, '--snapshot-only', '--snapshot-out', str(asset_file), '--manifest-out', str(manifest_file), '--logs-dir', str(logs_dir), '--save', str(prod_file)]
                if args.config_file:
                    snapshot_cmd += ['--config-file', args.config_file]
                if args.evaluation_manifest:
                    snapshot_cmd += ['--evaluation-manifest', args.evaluation_manifest]
                if cache_p:
                    snapshot_cmd += ['--timesfm-cache', str(cache_p)]
                prod = canonicalize_result(command_json(snapshot_cmd))
                production_asset = json.loads(asset_file.read_text())
                manifest = json.loads(manifest_file.read_text())
                production_config = prod['config']
                report['production_backtest_config'] = production_config
                base_file.write_text(json.dumps(production_config, indent=2))
                cs_file = opt_dir / f'current_sessions_{ticker}.json'
                cs_file.write_text(json.dumps({**production_asset, 'ticker':ticker, 'sessions':production_asset.get('sessions') or {}, 'mlGateEnabled':production_asset.get('mlGateEnabled') is True}, indent=2))
                prop = {}
                if not args.skip_hyperopt:
                    hp_out = opt_dir / f'{ticker}.json'
                    hp_cmd = [str(VENV_PY), str(HYPEROPT), ticker, '--study-name', f'jarvis_{ticker}_weekly_protocol1{args.study_suffix}', '--n-trials', str(n_trials), '--n-startup', str(min(50, n_trials)), '--output', str(hp_out), '--evaluation-manifest', str(manifest_file), '--current-sessions', str(cs_file), '--base-config', str(base_file), '--log-dir', str(logs_dir)]
                    if args.output_dir:
                        hp_cmd += ['--storage', str(opt_dir / 'study.db')]
                    if cache_p:
                        hp_cmd += ['--timesfm-cache', str(cache_p)]
                    r = subprocess.run(hp_cmd, cwd=str(REPO), capture_output=True, text=True, timeout=9000)
                    if r.returncode:
                        raise RuntimeError(f'hyperopt exit {r.returncode}: {(r.stderr or r.stdout)[-500:]}')
                    prop = json.loads(hp_out.read_text())
                    report['best_config'] = prop.get('best_config') or {}
                    report['objective_comparison'] = prop.get('objective_comparison')
                    report['session_apply'] = sessions_apply_map(report['best_config'])
                    if cache_p and 'minScoreToOverrideReject' in (prop.get('best_params') or {}):
                        report['timesfm_apply'] = {'minScoreToOverrideReject': prop['best_params']['minScoreToOverrideReject']}
                if not args.skip_aux:
                    selectors = []
                    if TRIGGER_TUNE_ENABLED:
                        selectors.append(('trigger_tune', PER_TRIGGER_TUNE, ['--budget', str(trigger_budget), '--concurrency', '1' if args.verification else '2']))
                    selectors += [('ks_proposal', KS_TUNE, []), ('directional_mcl', REPO/'scripts/directional_mcl_tune.ts', []), ('bias_confluence', BIAS_CF_TUNE, [])]
                    if LOSER_TRIGGERS_ENABLED:
                        selectors.append(('loser_triggers', LOSER_TRIGGERS_PROPOSAL, []))
                    if SIZING_PROPOSAL_ENABLED:
                        selectors.append(('sizing_proposal', SIZING_PROPOSAL, []))
                    for key, script, extra in selectors:
                        save_file = opt_dir / f'{key}_{ticker}.json'
                        cmd = selection_command(script, ticker, manifest_file, asset_file, logs_dir, '--backtest-config-file', base_file, '--save', save_file, *extra)
                        if key == 'sizing_proposal':
                            if args.trades_file:
                                cmd += ['--trades-file', args.trades_file]
                            elif args.config_file:
                                # Fixture mode never reads journal; an empty explicit
                                # snapshot gives an honest insufficient-sample HOLD.
                                empty = opt_dir / f'journal_{ticker}.json'
                                empty.write_text('[]')
                                cmd += ['--trades-file', str(empty)]
                            else:
                                cmd += ['--allow-journal-read']
                        try:
                            selected = command_json(cmd, timeout=14400)
                            report[key] = selected
                            if key == 'trigger_tune':
                                report['session_apply'] = selected.get('sessions') or {}
                                report['session_apply_replace'] = True
                        except Exception as e:
                            report[key + '_error'] = str(e)[:500]
                candidate_file = opt_dir / f'final_backtest_{ticker}.json'
                def evaluate(candidate):
                    candidate_file.write_text(json.dumps(candidate, indent=2))
                    cmd = ['npx', 'tsx', str(EVAL_PROD), ticker, '--evaluation-manifest', str(manifest_file), '--config-file', str(asset_file), '--backtest-config-file', str(candidate_file), '--logs-dir', str(logs_dir), '--save', str(opt_dir/f'final_result_{ticker}.json')]
                    if cache_p:
                        cmd += ['--timesfm-cache', str(cache_p)]
                    return canonicalize_result(command_json(cmd))
                certify_report(report, production_config, production_asset, prod, manifest, evaluate, montecarlo=run_montecarlo_gate)
                selection_errors = [k for k in report if k.endswith('_error') and k != 'timesfm_cache_error']
                if selection_errors:
                    report.update(status='HOLD_SELECTION_ERROR', apply_eligible=False)
                report['dsr'] = run_dsr_gate(ticker, report.get('final_validation_r') or [], prop.get('n_trials') or 0)
                if DSR_ENFORCE and report['status'] == 'RECOMMEND' and report['dsr'].get('verdict') == 'BELOW':
                    report['status'] = 'HOLD_DSR'
                if not args.skip_ml:
                    ml_config = dict(production_config)
                    ml_config.pop('mlGate', None)  # trainer explicitly collects unfiltered paired labels
                    ml_config_file = opt_dir / f'ml_unfiltered_config_{ticker}.json'
                    ml_config_file.write_text(json.dumps(ml_config, indent=2))
                    ml_cmd = [str(VENV_PY), str(HERE/'train_ml_weekly.py'), '--tickers', ticker, '--dry-run', '--evaluation-manifest', str(manifest_file), '--config', str(ml_config_file), '--log-dir', str(logs_dir), '--output-dir', str(opt_dir/'ml_candidates')]
                    ml = subprocess.run(ml_cmd, cwd=str(REPO), capture_output=True, text=True, timeout=10800)
                    report['ml_training'] = {'dry_run': True, 'exit_code': ml.returncode, 'output': (ml.stdout or ml.stderr)[-2000:]}
                    if ml.returncode not in (0, 2):
                        report.update(status='HOLD_ML_ERROR', apply_eligible=False)
                if not args.skip_telemetry:
                    report['shadow_week'] = shadow_week(ticker)
        except Exception as e:
            report.update(status='ERROR', apply_eligible=False, reason=str(e)[:1000])
            print(f'ERROR {ticker}: {e}', flush=True)
        (reports_dir/f'{ticker}.json').write_text(json.dumps(report, indent=2, allow_nan=False, default=str))
        if weekly_rollout_allowed(args):
            deployment = subprocess.run(weekly_rollout_command(ticker, reports_dir, followup_only=False),
                                        cwd=str(REPO), capture_output=True, text=True, timeout=300)
            print(f"{ticker} aplicación: {(deployment.stdout or deployment.stderr)[-1500:]}", flush=True)
            if deployment.returncode:
                # A deployment error may occur after commit. Preserve the file/state
                # written by the applicator and mark the cycle failed, never claim no write.
                report = json.loads((reports_dir/f'{ticker}.json').read_text())
                report['deployment_error'] = (deployment.stderr or deployment.stdout)[-1000:]
                (reports_dir/f'{ticker}.json').write_text(json.dumps(report, indent=2, allow_nan=False, default=str))
                report['status'] = 'ERROR'
        summary.append((ticker, report['status']))
        if report['status'] not in ('ERROR', 'HOLD_SELECTION_ERROR', 'HOLD_INTEGRITY', 'HOLD_ML_ERROR'):
            done.add(ticker)
        progress_file.write_text(json.dumps({'started_at': started_at, 'done': sorted(done)}, indent=2))
        print(f"{ticker}: {report['status']} | prospective_certified=False | weekly_rollout={weekly_rollout_allowed(args)}", flush=True)
    if not args.skip_telemetry:
        for script in ('trigger_parity_report.ts', 'ote_vs_directo.ts'):
            r = subprocess.run(['npx', 'tsx', str(REPO/'scripts'/script), '--days=7'], cwd=str(REPO), capture_output=True, text=True, timeout=600)
            print(f'{script}: exit={r.returncode}', flush=True)
    # Prospective certification remains separate; never relabel historical evidence.
    errors = [t for t, status in summary if status in ('ERROR', 'HOLD_SELECTION_ERROR', 'HOLD_INTEGRITY', 'HOLD_ML_ERROR')]
    if errors:
        return 1
    progress_file.unlink(missing_ok=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
