#!/usr/bin/env python3
"""run_weekly.py — Centro de Optimización Periódica (F3).

Ciclo semanal por activo (secuencial, de madrugada con mercado cerrado):
  0. REFRESH de datos: regenera los CSVs SMC (POST Kronos /api/backtest/export-csv).
     Los CSVs estaban congelados (ago-14) → re-tunear sin refrescar = overfit del MISMO OOS.
  1. Frescura: skip si no hay datos nuevos (CSVs viejos Y <20 trades nuevos de journal).
  2. Hyperopt Optuna (200 trials, split OOS 70/30 que ROLA con los datos refrescados —
     estudio persistente `jarvis_<T>_weekly` → Optuna continúa exploración semana a semana).
  3. Backtest de la config de PRODUCCIÓN actual (mismo worker/split → comparación 1:1).
  4. Killswitch sweep v2 (`killswitch_tune.ts`) → maxDailyLossR/maxConsecutiveLosses
     (etapa 1) + maxTradesPerDay/trailingDrawdownR (etapa 2), con tope de cuenta prop
     (peor día ≤ 4R). APLICA a Firestore (source='killswitch_tune' — los killswitches
     son el único bloque auto-aplicado; los gatillos NO se tocan).
  4b. MCL direccional por sesión (`directional_mcl_tune.ts`, opción 2 sep-2026) →
      maxBuyLosses/maxSellLosses ∈ {0,1,2} por sesión con trades. APLICA con dot-paths
      (source='directional_mcl_tune').
  5. Shadow TimesFM semanal (logs/timesfm_audit.jsonl) → resumen por activo (NO aplica).
  6. Comparación OOS → RECOMMEND | HOLD | ERROR + sesiones aplicables (enabled/entryPercent).
  7. Escribe reports/{TICKER}.json (el push a Firestore lo hace push_reports.js).

Regla de oro: NUNCA toca asset_configs — solo propone.
Uso: python3 run_weekly.py [--tickers ...] [--skip-refresh] [--skip-hyperopt] [--force]
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
AUTO_APPLY_ENABLED = False  # congelado 05-oct-2026 (plan Paso 1): optimizador corre pero NO auto-aplica; volver a True para restaurar

# 🛡️ Sizing fraccional (sep-2026): propuesta del dominical (factores por sesión, n>=8, gate MC).
# DESACTIVADO hasta OK de Bon — el módulo corre solo si este flag es True. PROPONE, NO aplica.
SIZING_PROPOSAL_ENABLED = True
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


def run_hyperopt(ticker: str, timesfm_cache: Path | None = None,
                 current_sessions_file: Path | None = None,
                 study_suffix: str = "") -> dict:
    out = OPT_OUT_DIR / f"{ticker}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    # F3-etapa2: weekly3 (espacio por sesión, 28 dims) + 400 trials + timeout 75 min
    # (medido ~3.2s/trial × 400 ≈ 21 min por activo; 75 min da margen para tickers lentos)
    # n-startup 50: con 28 dims hacen falta más trials aleatorios iniciales para que TPE
    # construya un modelo decente (20 era para el espacio de 10-13 params).
    # F4 (07-sep-2026): weekly7→weekly8 — el espacio gana minScoreToOverrideReject
    # (+1 dim) y las trials corren CON filtro TimesFM si hay cache precomputado.
    # F5 (08-sep-2026): weekly8→weekly9 — walkTree de MLFilter corregido (antes prob=0.5
    # constante en el gate ML) + pico spread rollover 20:29-21:15 en FrictionModel.
    # Los trials de weekly8 están contaminados por el gate ciego → bump obligatorio.
    # F6 (09-sep-2026): weekly9→weekly10 — cap de TP2 por volatilidad del activo
    # (tp2Cap.ts: min(1.5R, 0.5×ADR)) — cambia el landscape de las trials.
    # F7 (10-sep-2026): weekly10→weekly11 — gate ML cableado en las trials del worker
    # (jarvis_hyperopt_worker.ts inyecta mlGate walk-forward; antes las trials corrían
    # SIN filtro → prop↔prod no 1:1 con eval_production que SÍ gatea). El estudio
    # weekly10 queda contaminado (trials sin gate) → bump obligatorio.
    cmd = [str(VENV_PY), str(HYPEROPT), ticker,
           # 🆕 sep-2026 weekly7: weekly6 arrancó sin el port del fireNow (re-validación tardía)
           # ni el climax por rango (2×ATR). weekly7 corre con el SMART completo: 4 ramas +
           # fireNow ported + climax-ATR + bias HTF reconstruido.
           # F8 (22-sep-2026): weekly11→weekly12 — los estudios weekly11 de los tickers legacy
           # mezclan trials pre-VWAP/pre-zoneWeights (space viejo) → best_trial sin vwapPts/zw_*
           # rompía build_backtest_config (KeyError en 5 activos). Bump obligatorio.
           "--study-name", f"jarvis_{ticker}_weekly12{study_suffix}",
           "--n-trials", "400",
           "--n-startup", "50",
           "--output", str(out)]
    if timesfm_cache and timesfm_cache.exists():
        cmd += ["--timesfm-cache", str(timesfm_cache)]
    # 🆕 sep-2026 (paridad de umbrales): overlay de sesiones vigentes del vivo
    if current_sessions_file and current_sessions_file.exists():
        cmd += ["--current-sessions", str(current_sessions_file)]
    t0 = time.time()
    # 🛡️ FIX 09-sep-2026: timeout 75→150 min — GBPUSD/AUDCAD/NZDUSD con cache TimesFM
    # excedían 75 min (128/127/115 orígenes) y murieron por timeout en la corrida del 09-sep.
    r = subprocess.run(cmd, cwd=str(REPO), capture_output=True, text=True, timeout=150 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"hyperopt exit {r.returncode}: {(r.stderr or r.stdout)[-400:]}")
    data = json.loads(out.read_text())
    mo = data.get("best_metrics_oos", {})
    print(f"    hyperopt OK ({time.time()-t0:.0f}s) | OOS PF={mo.get('profit_factor')} exp={mo.get('expectancy')}", flush=True)
    return data


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


def eval_production(ticker: str) -> dict:
    r = subprocess.run(["npx", "tsx", str(EVAL_PROD), ticker],
                       cwd=str(REPO), capture_output=True, text=True, timeout=15 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"eval_production exit {r.returncode}: {(r.stderr or r.stdout)[-400:]}")
    for line in reversed(r.stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError("eval_production no devolvió JSON")


def run_ks_sweep(ticker: str) -> dict | None:
    """Killswitch sweep (v2, sep-2026) → propuesta {maxDailyLossR, maxConsecutiveLosses,
    maxTradesPerDay, trailingDrawdownR, score}. El script APLICA a Firestore
    (source='killswitch_tune', igual que la v1 — los killswitches son el único bloque
    auto-aplicado del dominical); acá se parsea para el reporte."""
    ks_cmd = ["npx", "tsx", str(KS_TUNE), ticker]
    if not AUTO_APPLY_ENABLED:
        ks_cmd.append("--dry-run")
    r = subprocess.run(ks_cmd,
                       cwd=str(REPO), capture_output=True, text=True, timeout=40 * 60)
    best_line = None
    best2_line = None
    for line in (r.stdout or "").splitlines():
        if "BEST maxDLR=" in line:
            best_line = line
        if "BEST2 maxTPD=" in line:
            best2_line = line
    if not best_line:
        return None
    try:
        import re
        m = re.search(r"BEST maxDLR=([\d.]+) maxCL=(\d+).*score=([\d.]+)", best_line)
        out = {"maxDailyLossR": float(m.group(1)), "maxConsecutiveLosses": int(m.group(2)),
               "score": float(m.group(3))}
        if best2_line:
            m2 = re.search(r"BEST2 maxTPD=(\d+) maxTDD=([\d.]+).*score=([\d.]+)", best2_line)
            if m2:
                out["maxTradesPerDay"] = int(m2.group(1))
                out["trailingDrawdownR"] = float(m2.group(2))
        return out
    except Exception:
        return None


def run_directional_mcl_sweep(ticker: str) -> dict | None:
    """Sweep MCL direccional por sesión (sep-2026, opción 2 de Bon) — APLICA a Firestore
    con dot-paths (source='directional_mcl_tune') y devuelve el resumen para el reporte."""
    mcl_cmd = ["npx", "tsx", str(REPO / "scripts" / "directional_mcl_tune.ts"), ticker]
    if not AUTO_APPLY_ENABLED:
        mcl_cmd.append("--dry-run")
    r = subprocess.run(mcl_cmd,
                       cwd=str(REPO), capture_output=True, text=True, timeout=40 * 60)
    if r.returncode != 0:
        print(f"  ⚠️ directional_mcl_tune {ticker} exit {r.returncode}: {(r.stderr or r.stdout)[-300:]}")
        return None
    lines = [l for l in (r.stdout or "").splitlines() if "→" in l and ("BUY" in l or "SELL" in l)]
    return {"ticker": ticker, "changes": lines[-12:]} if lines else None


def run_montecarlo_gate(ticker: str, oos_r: list) -> dict | None:
    """MC gate (sep-2026): bootstrap de robustez sobre los r-multiples OOS de producción.
    Degrada RECOMMEND→HOLD_MC si el edge no sobrevive al resampling. NO aplica nada."""
    if not oos_r or len(oos_r) < 10:
        return {"note": "pocos trades OOS para MC", "skip": True}
    tmp = HERE / "opt_out" / f"mc_{ticker}.json"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps([{"rMultiple": float(r)} for r in oos_r]))
    try:
        r = subprocess.run(
            ["npx", "tsx", str(REPO / "scripts" / "montecarlo_validation.ts"), str(tmp), "--mode", "bootstrap"],
            cwd=str(REPO), capture_output=True, text=True, timeout=15 * 60,
        )
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


def run_sizing_proposal() -> dict:
    """Paso 7 (sep-2026): propuesta de sizing fraccional por sesión (ventana 12s, n>=8, banda muerta).
    El TS calcula factores + secuencias; acá se valida con MC (bootstrap base vs ponderado).
    RECOMMEND solo si el MC no degrada survival más de 2pp. PROPONE, NO aplica (regla de oro)."""
    r = subprocess.run(["npx", "tsx", str(SIZING_PROPOSAL)], cwd=str(REPO),
                       capture_output=True, text=True, timeout=15 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"sizing_weekly_proposal exit {r.returncode}: {(r.stderr or r.stdout)[-300:]}")
    data = None
    for line in (r.stdout or "").splitlines():
        s = line.strip()
        if s.startswith("{"):
            try:
                cand = json.loads(s)
            except json.JSONDecodeError:
                continue
            if cand:
                data = cand
                break
    if not data:
        raise RuntimeError(f"sizing_weekly_proposal sin JSON: {(r.stdout or '')[-200:]}")
    if data.get("status") != "PROPUESTA" or data.get("n", 0) < 10:
        return {**data, "mc": None}

    def _mc_survival(p: Path) -> float | None:
        r2 = subprocess.run(
            ["npx", "tsx", str(REPO / "scripts" / "montecarlo_validation.ts"), str(p), "--mode", "bootstrap"],
            cwd=str(REPO), capture_output=True, text=True, timeout=15 * 60)
        import re as _re
        surv_line = next((l for l in (r2.stdout or "").splitlines() if "Supervivencia" in l), "")
        m = _re.search(r"\((\d+(?:\.\d+)?)%\)", surv_line)
        return float(m.group(1)) / 100 if m else None

    surv_base = _mc_survival(OPT_OUT_DIR / "sizing_mc_base.json")
    surv_w = _mc_survival(OPT_OUT_DIR / "sizing_mc_weighted.json")
    mc = {"survival_base": surv_base, "survival_weighted": surv_w}
    status = "HOLD"
    if surv_base is not None and surv_w is not None:
        status = "RECOMMEND" if surv_w >= surv_base - 0.02 else "HOLD_MC"
    return {**data, "status": status, "mc": mc}


def run_loser_triggers_proposal() -> dict:
    """Paso 8 (09-sep-2026, idea de Bon): mide exp por gatillo (motor real + config de
    producción) y PROPONE apagar los perdedores persistentes (n>=10, exp<=-0.15) con
    minScore=99 (el enabled:false NO frena la OTE en SMART — el minScore sí).
    Escribe reports/loser_triggers_proposal.json. NO aplica (regla de oro)."""
    r = subprocess.run(["npx", "tsx", str(LOSER_TRIGGERS_PROPOSAL)], cwd=str(REPO),
                       capture_output=True, text=True, timeout=60 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"loser_triggers_proposal exit {r.returncode}: {(r.stderr or r.stdout)[-300:]}")
    out = (r.stdout or "") + (r.stderr or "")
    lines = [l for l in out.splitlines() if l.strip().startswith("🔴") or "Loser-triggers:" in l]
    print("\n".join(f"    {ln.strip()}" for ln in lines[-15:]), flush=True)
    p = REPORTS_DIR / "loser_triggers_proposal.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return {"status": "PARSE_ERROR"}
    return {"status": "SIN_REPORTE"}


def run_bias_confluence(ticker: str) -> dict | None:
    """Paso 1b (sep-2026): barrido de confluencia de bias (V1-V4) sobre el motor real.
    Devuelve la PROPUESTA {status, recommended:{bc, metrics, objective, margin_vs_baseline}}.
    NO aplica (regla de oro). V5 (binario viejo) excluida por datos vivos."""
    r = subprocess.run(["npx", "tsx", str(BIAS_CF_TUNE), ticker],
                       cwd=str(REPO), capture_output=True, text=True, timeout=30 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"bias_confluence_tune exit {r.returncode}: {(r.stderr or r.stdout)[-300:]}")
    for line in reversed((r.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError("bias_confluence_tune no devolvió JSON")


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", default=None, help="override manual; default: Firestore active_tickers (fallback TICKERS_ALL)")
    ap.add_argument("--min-new-trades", type=int, default=MIN_NEW_TRADES)
    ap.add_argument("--skip-fetch", action="store_true")
    ap.add_argument("--skip-refresh", action="store_true")
    ap.add_argument("--skip-hyperopt", action="store_true")
    ap.add_argument("--force", action="store_true", help="ignora el chequeo de frescura")
    ap.add_argument("--resume", action="store_true",
                    help="continúa el ciclo desde donde quedó (lee weekly_progress.json; los tickers ya hechos se saltean)")
    ap.add_argument("--study-suffix", default="",
                    help="sufijo para el nombre del estudio Optuna (forzar estudio fresco, p.ej. '_v2')")
    args = ap.parse_args()

    # ── checkpoint/resume (22-sep-2026) ──
    if args.resume and PROGRESS_FILE.exists():
        try:
            prog = json.loads(PROGRESS_FILE.read_text())
            done = set(prog.get("done") or [])
            started_at = prog.get("started_at") or int(time.time() * 1000)
            print(f"♻️ --resume: {len(done)} tickers ya completados en este ciclo: "
                  f"{', '.join(sorted(done)) or '(ninguno)'}", flush=True)
        except Exception as e:
            print(f"⚠️ progress.json ilegible ({e}) — arranque desde cero", flush=True)
            done = set()
            started_at = int(time.time() * 1000)
    else:
        done = set()
        started_at = int(time.time() * 1000)
        OPT_OUT_DIR.mkdir(parents=True, exist_ok=True)
        try:
            PROGRESS_FILE.write_text(json.dumps({"started_at": started_at, "done": []}))
        except Exception:
            pass

    tickers = [t.strip().upper() for t in (args.tickers or "").split(",") if t.strip()]
    if not tickers:
        tickers = load_active_tickers_from_firestore()
    api_key = get_api_key()
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    summary = []

    # 0-preflight (21-sep-2026): el ciclo cuesta ~15h de CPU; antes de gastarlo, verificar
    # que el wrapper del hyperopt acepta los flags que run_weekly le pasa. El 20-sep-2026
    # el wrapper no tenía --current-sessions → 14 tickers ERROR × 3h CPU desperdiciadas y
    # un día de demora hasta detectarlo. Si falla acá, exit 1 → OnFailure notifica.
    try:
        r = subprocess.run([sys.executable, str(HYPEROPT), "--help"],
                           capture_output=True, text=True, timeout=60)
        help_out = (r.stdout or "") + (r.stderr or "")
        missing = [f for f in ("--current-sessions", "--timesfm-cache") if f not in help_out]
        if missing:
            print(f"❌ PREFLIGHT FAIL: run_hyperopt.py no acepta: {', '.join(missing)} — "
                  f"cablear el flag en el wrapper antes de correr el ciclo.", flush=True)
            return 1
        print("✅ preflight OK: wrapper acepta current-sessions + timesfm-cache", flush=True)
    except Exception as e:
        print(f"❌ PREFLIGHT FAIL: no se pudo validar el wrapper ({e})", flush=True)
        return 1

    # 0a. DESCARGAR velas frescas de cTrader (16-sep-2026) — una sola corrida para todos
    # los tickers, SIEMPRE antes del export (salvo --skip-fetch/--skip-refresh).
    # OJO: usa el cliente cTrader → patea el stream del bot UNA vez (el bot se reconecta solo).
    if FETCH_ENABLED and not args.skip_fetch and not args.skip_refresh:
        print("═══ 0a. DESCARGANDO velas frescas de cTrader (fetch_history) ═══", flush=True)
        try:
            r = subprocess.run(
                ["npx", "tsx", str(FETCH_HISTORY)],
                cwd=str(REPO), capture_output=True, text=True, timeout=150 * 60,
            )
            if r.returncode != 0:
                print(f"    ⚠️ fetch_history exit {r.returncode}: {(r.stderr or r.stdout)[-300:]}", flush=True)
            else:
                print("    fetch_history OK", flush=True)
        except Exception as e:
            print(f"    ⚠️ fetch_history error: {e}", flush=True)

    for ticker in tickers:
        if ticker in done:
            print(f"═══ {ticker} (ya completado en este ciclo — skip por --resume) ═══", flush=True)
            continue
        print(f"═══ {ticker} ═══", flush=True)
        last = load_last_report(ticker)
        last_ts = int(last.get("timestamp") or 0)
        report = {"ticker": ticker, "timestamp": int(time.time() * 1000), "status": "HOLD"}

        try:
            # 0. REFRESH de datos (walk-forward: sin datos nuevos, el OOS no rola)
            refresh = {"ok": True, "newest_mtime_ms": None}
            if not args.skip_refresh:
                refresh = refresh_csvs(ticker)
            report["data_refreshed_at"] = refresh.get("newest_mtime_ms")
            if not refresh.get("ok"):
                report["status"] = "REFRESH_ERROR"
                report["reason"] = f"no se pudieron regenerar los CSVs: {refresh.get('detail') or refresh.get('error')}"
                print(f"    ❌ {report['reason']}", flush=True)
                (REPORTS_DIR / f"{ticker}.json").write_text(json.dumps(report, indent=2, default=str))
                summary.append(f"{ticker}: {report['status']}")
                continue

            # 1. Frescura (16-sep-2026): se mira la ÚLTIMA VELA del archivo crudo, no el mtime.
            new_trades = count_new_trades(api_key, ticker, last_ts)
            last_candle = last_candle_ms(ticker)
            data_newer = last_candle > last_ts
            lc_str = datetime.fromtimestamp(last_candle / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if last_candle else "sin datos"
            print(f"    trades nuevos: {new_trades} | última vela: {lc_str} | más nueva que el último reporte: {data_newer}", flush=True)
            if not args.force and new_trades < args.min_new_trades and not data_newer:
                report["reason"] = (f"sin datos nuevos (journal +{new_trades} trades, CSVs viejos) "
                                    f"— no re-tunear sobre el MISMO OOS (anti-overfit walk-forward)")
                print(f"    → {report['reason']}", flush=True)

            # 2. Hyperopt (solo si hay datos nuevos o se fuerza)
            elif not args.skip_hyperopt:
                # 1.5a. Bruteforcer de presets del motor (sep-2026, Capa 2) — PROPONE.
                # No bloqueante: si falla o tarda, el ciclo sigue. El preset vivo NO se
                # toca (archivo _proposal); la migración es manual con OK de Bon.
                if BRUTEFORCER_ENABLED:
                    try:
                        r = subprocess.run(
                            ["npx", "tsx", str(SMC_BRUTEFORCER), ticker],
                            cwd=str(REPO), capture_output=True, text=True, timeout=90 * 60,
                        )
                        prop_path = REPO / f"optimized_preset_{ticker}_proposal.json"
                        if r.returncode == 0 and prop_path.exists():
                            prop = json.loads(prop_path.read_text())
                            trades = int((prop.get("Metrics") or {}).get("Trades") or 0)
                            if trades <= 0:
                                # 🆕 21-sep-2026: propuestas degeneradas (0 trades) se descartan —
                                # no se proponen ni se auto-aplican (los bloques TF del motor no
                                # se pueden validar por backtest y un preset vacío degrada el vivo).
                                report["preset_proposal_note"] = (
                                    "sin datos: propuesta con 0 trades — descartada (no se propone)"
                                )
                                print(f"    Bruteforcer: propuesta SIN DATOS (0 trades) — descartada", flush=True)
                            else:
                                report["preset_proposal"] = prop
                                print(f"    Bruteforcer: propuesta de preset OK ({prop_path.name}, {trades} trades)", flush=True)
                        else:
                            report["preset_proposal_error"] = (r.stderr or r.stdout or "exit!=0")[-200:]
                            print(f"    ⚠ Bruteforcer exit={r.returncode}", flush=True)
                    except Exception as e:
                        report["preset_proposal_error"] = str(e)[:200]
                        print(f"    ⚠ Bruteforcer falló: {e}", flush=True)
                # F4 (07-sep-2026): colecta de orígenes + precompute de forecasts TimesFM.
                # Si falla, el hyperopt sigue SIN filtro (robustez: el ciclo no se corta)
                # y queda la nota en el reporte. Con cache, las trials miden el efecto
                # real del umbral minScoreToOverrideReject.
                tfm_cache_info: dict | None = None
                try:
                    tfm_cache_info = collect_and_precompute(ticker)
                except Exception as e:
                    print(f"    ⚠ TimesFM collect/precompute falló ({str(e)[:150]}) — hyperopt SIN filtro.", flush=True)
                    report["timesfm_cache_error"] = str(e)[:200]
                report["timesfm_cache"] = tfm_cache_info
                cache_p = Path(tfm_cache_info["cache"]) if tfm_cache_info else None

                # 🆕 sep-2026 (paridad de umbrales): volcar sesiones vigentes del vivo
                # para que las trials del hyperopt midan SOBRE los minScore/slBuff/tp2/
                # gestión per-gatillo que el vivo aplica (dueño: per_trigger_tune).
                cs_file: Path | None = None
                try:
                    cs_file = REPORTS_DIR / f"current_sessions_{ticker}.json"
                    subprocess.run(
                        ["npx", "tsx", str(GET_CURRENT_SESSIONS), ticker, "--out", str(cs_file)],
                        cwd=str(REPO), capture_output=True, text=True, timeout=120, check=True,
                    )
                except Exception as e:
                    cs_file = None
                    print(f"    ⚠ current-sessions dump falló ({str(e)[:120]}) — hyperopt sin overlay", flush=True)

                prop = run_hyperopt(ticker, timesfm_cache=cache_p, current_sessions_file=cs_file,
                                    study_suffix=args.study_suffix)
                prod = eval_production(ticker)
                cmp = compare(prop.get("best_metrics_oos", {}), prod.get("metrics_oos", {}))
                report.update({
                    "status": cmp["status"],
                    "delta": cmp,
                    "proposal_oos": prop.get("best_metrics_oos"),
                    "production_oos": prod.get("metrics_oos"),
                    "best_config": prop.get("best_config"),
                    "oos_split": prod.get("oos_split"),
                    "session_apply": sessions_apply_map(prop.get("best_config") or {}),
                })
                # 🛡️ MC gate (sep-2026): bootstrap de robustez sobre los r OOS de producción.
                # Si el edge de la base actual no sobrevive al resampling, ningún RECOMMEND se promueve.
                try:
                    mc = run_montecarlo_gate(ticker, prod.get("oos_r") or [])
                    report["montecarlo"] = mc
                    if mc.get("survival") is not None:
                        print(f"    MC gate: supervivencia={mc['survival']*100:.0f}% | {mc.get('verdict_short')}", flush=True)
                        if cmp["status"] == "RECOMMEND" and mc["survival"] < 0.80:
                            report["status"] = "HOLD_MC"
                            print(f"    🛡️ MC gate: RECOMMEND degradado a HOLD_MC (edge de la base no robusto al bootstrap)", flush=True)
                except Exception as e:
                    report["montecarlo_error"] = str(e)[:200]
                    print(f"    ⚠ MC gate falló: {e}", flush=True)
                # F4: propuesta del umbral TimesFM (solo propone — la aplicación sigue
                # siendo manual, igual que el resto de session_apply).
                bp = prop.get("best_params") or {}
                if cache_p and "minScoreToOverrideReject" in bp:
                    report["timesfm_apply"] = {
                        "minScoreToOverrideReject": bp["minScoreToOverrideReject"],
                        "source": "hyperopt_weekly8",
                    }
                else:
                    report["timesfm_apply"] = None
                print(f"    → {cmp['status']} | ΔexpOOS={cmp['d_exp_oos']:+0.3f}R | "
                      f"ΔDD={cmp['dd_improve_ratio']*100:+.1f}% | ΔPnL={cmp['pnl_drop_ratio']*100:+.1f}%", flush=True)

            # 2b. Tune por sesión×gatillo (sep-2026, dueño-único) — PROPONE en --dry-run.
            # minScore/slBuff/tp2/gestión por gatillo → merge en session_apply → panel.
            if TRIGGER_TUNE_ENABLED:
                try:
                    tt_out = REPORTS_DIR / f"trigger_tune_{ticker}.json"
                    r = subprocess.run(
                        ["npx", "tsx", str(PER_TRIGGER_TUNE), ticker,
                         "--budget", "80", "--concurrency", "2",
                         "--dry-run", "--save", str(tt_out)],
                        cwd=str(REPO), capture_output=True, text=True, timeout=4 * 60 * 60,
                    )
                    if r.returncode == 0 and tt_out.exists():
                        tt = json.loads(tt_out.read_text())
                        report["trigger_tune"] = tt.get("final")
                        sa = report.get("session_apply") or {}
                        for sess, trigs in (tt.get("sessions") or {}).items():
                            sa.setdefault(sess, {})
                            for trig, cfg in trigs.items():
                                if isinstance(cfg, dict):
                                    sa[sess][trig] = {**(sa[sess].get(trig) or {}), **cfg}
                        report["session_apply"] = sa
                        print(f"    Trigger-tune: {len(tt.get('sessions') or {})} sesiones propuestas "
                              f"(final={tt.get('final')})", flush=True)
                    else:
                        report["trigger_tune_error"] = (r.stderr or r.stdout or "exit!=0")[-200:]
                        print(f"    ⚠ Trigger-tune exit={r.returncode}", flush=True)
                except Exception as e:
                    report["trigger_tune_error"] = str(e)[:200]
                    print(f"    ⚠ Trigger-tune falló: {e}", flush=True)

            # 3. Killswitch sweep (siempre, es barato relativo y no depende del OOS)
            try:
                ks = run_ks_sweep(ticker)
                if ks:
                    report["ks_proposal"] = ks
                    print(f"    KS propuesta: maxDLR={ks['maxDailyLossR']} maxCL={ks['maxConsecutiveLosses']} "
                          f"maxTPD={ks.get('maxTradesPerDay', '-')} maxTDD={ks.get('trailingDrawdownR', '-')} "
                          f"(score={ks['score']})", flush=True)
            except Exception as e:
                report["ks_error"] = str(e)[:200]
                print(f"    ⚠ KS sweep falló: {e}", flush=True)

            # 3.1 MCL direccional por sesión (sep-2026, opción 2 de Bon) — APLICA igual
            # que el KS sweep (dot-paths, source='directional_mcl_tune').
            try:
                dm = run_directional_mcl_sweep(ticker)
                if dm:
                    report["directional_mcl"] = dm
                    print(f"    MCL direccional: {len(dm['changes'])} cambios evaluados", flush=True)
            except Exception as e:
                report["directional_mcl_error"] = str(e)[:200]
                print(f"    ⚠ MCL direccional falló: {e}", flush=True)

            # 3b. Confluencia de bias (Paso 1b sep-2026): barrido V1-V4 por activo.
            # PROPONE el bloque biasConfluence (RECOMMEND/HOLD) — NO aplica.
            try:
                bc = run_bias_confluence(ticker)
                if bc:
                    report["bias_confluence"] = bc
                    if bc.get("status") == "RECOMMEND" and bc.get("recommended"):
                        rec = bc["recommended"]
                        print(f"    biasConfluence: RECOMMEND {rec['bc']} (obj {rec['objective']}, Δ{rec.get('margin_vs_baseline')})", flush=True)
                    else:
                        print(f"    biasConfluence: {bc.get('status')}", flush=True)
            except Exception as e:
                report["bias_confluence_error"] = str(e)[:200]
                print(f"    ⚠ biasConfluence barrido falló: {e}", flush=True)

            # 4. Shadow TimesFM semanal
            report["shadow_week"] = shadow_week(ticker)
            sw = report["shadow_week"]
            print(f"    Shadow 7d: {sw.get('n', 0)} decisiones ({sw.get('approve', 0)}✓ / {sw.get('downgrade', 0)}↓ / {sw.get('reject', 0)}✗)", flush=True)

        except Exception as e:
            report["status"] = "ERROR"
            report["reason"] = str(e)[:300]
            print(f"    ❌ ERROR: {e}", flush=True)

        (REPORTS_DIR / f"{ticker}.json").write_text(json.dumps(report, indent=2, default=str))
        summary.append(f"{ticker}: {report['status']}")
        # checkpoint: marcar como hecho (el resume salta este ticker si el ciclo muere después)
        done.add(ticker)
        try:
            PROGRESS_FILE.write_text(json.dumps({"started_at": started_at, "done": sorted(done)}, indent=2))
        except Exception:
            pass

    # 5. Paridad VIVO vs BACKTEST (telemetría de gatillos, Plan B ago-2026)
    # Compara lo que pasó en vivo (trigger_telemetry) con lo que el optimizador espera.
    try:
        pr = subprocess.run(
            ["npx", "tsx", str(REPO / "scripts" / "trigger_parity_report.ts"), "--days=7"],
            cwd=str(REPO), capture_output=True, text=True, timeout=10 * 60,
        )
        parity_out = (pr.stdout or "") + (pr.stderr or "")
        print("    Parity vivo-vs-backtest:")
        print("\n".join(f"      {ln}" for ln in parity_out.splitlines()[-25:]), flush=True)
        if pr.returncode != 0:
            print(f"    ⚠ Parity report exit={pr.returncode}", flush=True)
    except Exception as e:
        print(f"    ⚠ Parity report falló: {e}", flush=True)

    # 5b. OTE vs DIRECTO (1-oct-2026, pedido Bon): cruza trade_journal (entryType) contra
    # la telemetría del embudo — resultados reales por tipo de entrada + sanity check de
    # ejecuciones. Read-only, escribe scripts/periodic_opt/reports/ote_vs_directo.json.
    # Ventana semanal como el parity (la cobertura real la acota el journal solo).
    try:
        od = subprocess.run(
            ["npx", "tsx", str(REPO / "scripts" / "ote_vs_directo.ts"), "--days=7", "--telegram"],
            cwd=str(REPO), capture_output=True, text=True, timeout=10 * 60,
        )
        od_out = (od.stdout or "") + (od.stderr or "")
        print("    OTE vs DIRECTO:")
        print("\n".join(f"      {ln}" for ln in od_out.splitlines()[-30:]), flush=True)
        if od.returncode != 0:
            print(f"    ⚠ OTE vs DIRECTO exit={od.returncode}", flush=True)
    except Exception as e:
        print(f"    ⚠ OTE vs DIRECTO falló: {e}", flush=True)

    # 6. Re-entrenamiento ML semanal (ML F3, sep-2026) — AL FINAL del ciclo.
    # El modelo entrenado HOY (con datos hasta hoy) evalúa la semana QUE VIENE: walk-forward.
    # Si se entrenara ANTES del hyperopt, trainedAt=ahora → el gate quedaría inerte esta corrida.
    # train_ml_weekly.py tiene sus propios guardrails (≥30 trades nuevos WIN/LOSS, solo
    # reemplaza si la accuracy mejora). Un fallo NO corta el ciclo (el gate usa el modelo previo).
    try:
        r = subprocess.run(
            ["python3", str(HERE / "train_ml_weekly.py"), "--tickers", ",".join(tickers)],
            cwd=str(REPO), capture_output=True, text=True, timeout=3 * 60 * 60,
        )
        ml_out = (r.stdout or "") + (r.stderr or "")
        print("    Re-entrenamiento ML semanal:")
        print("\n".join(f"      {ln}" for ln in ml_out.splitlines()[-12:]), flush=True)
        if r.returncode != 0:
            print(f"    ⚠ train_ml_weekly exit={r.returncode}", flush=True)
    except Exception as e:
        print(f"    ⚠ Re-entrenamiento ML falló: {e}", flush=True)

    # 7. Sizing fraccional (sep-2026) — PROPONE, NO aplica. Flag SIZING_PROPOSAL_ENABLED.
    if SIZING_PROPOSAL_ENABLED:
        try:
            sp = run_sizing_proposal()
            (REPORTS_DIR / "sizing_proposal.json").write_text(json.dumps(sp, indent=2, default=str))
            print(f"    Sizing: {sp['status']} | factores={sp.get('factors')} | MC={sp.get('mc')}", flush=True)
        except Exception as e:
            print(f"    ⚠ Sizing proposal falló: {e}", flush=True)
    else:
        print("    Sizing: DESACTIVADO (SIZING_PROPOSAL_ENABLED=False) — módulo listo, pendiente OK de Bon", flush=True)

    # 8. Gatillos perdedores (09-sep-2026, idea de Bon) — PROPONE, NO aplica.
    if LOSER_TRIGGERS_ENABLED:
        try:
            lt = run_loser_triggers_proposal()
            print(f"    Trigger-state: {lt.get('status')} ({len(lt.get('disables', []))} apagar, {len(lt.get('enables', []))} activar)", flush=True)
        except Exception as e:
            print(f"    ⚠ Loser-triggers falló: {e}", flush=True)

    # 9. AUTO-APLICADOR (sep-2026, decisión de Bon): aplica automático SOLO lo que pasa
    # los gates (RECOMMEND + MC survival >= 80% + frescura + activo enabled). Snapshot
    # previo por activo para rollback. Disables de gatillos perdedores auto; enables
    # manuales. El preset del motor (bruteforcer) NO se auto-aplica (migración manual).
    if AUTO_APPLY_ENABLED:
        try:
            r = subprocess.run(
                ["npx", "tsx", str(HERE / "apply_weekly.ts")],
                cwd=str(REPO), capture_output=True, text=True, timeout=15 * 60,
            )
            print("    Auto-apply:")
            print("\n".join(f"      {ln}" for ln in (r.stdout or "").splitlines()[-20:]), flush=True)
            if r.returncode != 0:
                print(f"    ⚠ Auto-apply exit={r.returncode}: {(r.stderr or '')[-200:]}", flush=True)
        except Exception as e:
            print(f"    ⚠ Auto-apply falló: {e}", flush=True)

    print("════ RESUMEN ════")
    print("\n".join(summary))
    # 🆕 10-sep-2026: exit code real — si algún activo salió ERROR, el proceso devuelve 1
    # para que systemd/health check lo vean (antes la re-corrida "fallida" salía exit=0).
    errors = [s for s in summary if s.endswith(": ERROR")]
    if errors:
        print(f"⚠ {len(errors)} activo(s) en ERROR — exit code 1", flush=True)
        # El checkpoint se CONSERVA: un --resume posterior no re-corre lo ya hecho,
        # y el ERROR queda en el panel para diagnóstico.
        return 1
    # Ciclo completo sin errores → borrar el checkpoint (el próximo arranque es un ciclo nuevo).
    try:
        PROGRESS_FILE.unlink(missing_ok=True)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
