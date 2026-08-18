#!/usr/bin/env python3
"""run_weekly.py — Centro de Optimización Periódica (F3).

Ciclo semanal por activo (secuencial, de madrugada con mercado cerrado):
  0. REFRESH de datos: regenera los CSVs SMC (POST Kronos /api/backtest/export-csv).
     Los CSVs estaban congelados (ago-14) → re-tunear sin refrescar = overfit del MISMO OOS.
  1. Frescura: skip si no hay datos nuevos (CSVs viejos Y <20 trades nuevos de journal).
  2. Hyperopt Optuna (200 trials, split OOS 70/30 que ROLA con los datos refrescados —
     estudio persistente `jarvis_<T>_weekly` → Optuna continúa exploración semana a semana).
  3. Backtest de la config de PRODUCCIÓN actual (mismo worker/split → comparación 1:1).
  4. Killswitch sweep (`killswitch_tune.ts`) → propuesta ks (NO aplica).
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
AUDIT_LOG = REPO / "logs" / "timesfm_audit.jsonl"
REPORTS_DIR = HERE / "reports"
OPT_OUT_DIR = HERE / "opt_out"
KRONOS = "http://127.0.0.1:8000"
FIREBASE_PROJECT = "jarvis-67f66"

TICKERS_ALL = ["EURUSD", "GBPUSD", "AUDCAD", "US500", "XAUUSD", "USDJPY", "USDCAD", "NZDUSD", "USOIL", "BTCUSD"]

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


def run_hyperopt(ticker: str) -> dict:
    out = OPT_OUT_DIR / f"{ticker}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [str(VENV_PY), str(HYPEROPT), ticker,
           "--study-name", f"jarvis_{ticker}_weekly",
           "--output", str(out)]
    t0 = time.time()
    r = subprocess.run(cmd, cwd=str(REPO), capture_output=True, text=True, timeout=45 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"hyperopt exit {r.returncode}: {(r.stderr or r.stdout)[-400:]}")
    data = json.loads(out.read_text())
    mo = data.get("best_metrics_oos", {})
    print(f"    hyperopt OK ({time.time()-t0:.0f}s) | OOS PF={mo.get('profit_factor')} exp={mo.get('expectancy')}", flush=True)
    return data


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
    """Killswitch sweep → propuesta {maxDailyLossR, maxConsecutiveLosses, score}. NO aplica."""
    r = subprocess.run(["npx", "tsx", str(KS_TUNE), ticker],
                       cwd=str(REPO), capture_output=True, text=True, timeout=40 * 60)
    best_line = None
    for line in (r.stdout or "").splitlines():
        if "BEST maxDLR=" in line:
            best_line = line
    if not best_line:
        return None
    try:
        import re
        m = re.search(r"BEST maxDLR=([\d.]+) maxCL=(\d+).*score=([\d.]+)", best_line)
        return {"maxDailyLossR": float(m.group(1)), "maxConsecutiveLosses": int(m.group(2)),
                "score": float(m.group(3))}
    except Exception:
        return None


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
            decision = str(e.get("decision") or "").upper()
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
    """Del best_config.sessions (esquema backtest) → lo ÚNICO que el motor LIVE lee por gatillo:
    enabled + entryPercent (resolveOteGate/AlphaModel). El resto (tp2/slBuff/partialClosePct
    por gatillo) NO tiene equivalente live → queda fuera hasta el proyecto de paridad engine."""
    out: dict = {}
    for session, triggers in (best_config.get("sessions") or {}).items():
        s_out: dict = {}
        for trig, cfg in (triggers or {}).items():
            t_out: dict = {}
            if isinstance(cfg, dict):
                if "enabled" in cfg:
                    t_out["enabled"] = bool(cfg["enabled"])
                if "entryPercent" in cfg:
                    t_out["entryPercent"] = float(cfg["entryPercent"])
            if t_out:
                s_out[trig] = t_out
        if s_out:
            out[session] = s_out
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", default=",".join(TICKERS_ALL))
    ap.add_argument("--min-new-trades", type=int, default=MIN_NEW_TRADES)
    ap.add_argument("--skip-refresh", action="store_true")
    ap.add_argument("--skip-hyperopt", action="store_true")
    ap.add_argument("--force", action="store_true", help="ignora el chequeo de frescura")
    args = ap.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    api_key = get_api_key()
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    summary = []

    for ticker in tickers:
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

            # 1. Frescura
            new_trades = count_new_trades(api_key, ticker, last_ts)
            data_newer = (refresh.get("newest_mtime_ms") or 0) > last_ts
            print(f"    trades nuevos: {new_trades} | CSVs más nuevos que el último reporte: {data_newer}", flush=True)
            if not args.force and new_trades < args.min_new_trades and not data_newer:
                report["reason"] = (f"sin datos nuevos (journal +{new_trades} trades, CSVs viejos) "
                                    f"— no re-tunear sobre el MISMO OOS (anti-overfit walk-forward)")
                print(f"    → {report['reason']}", flush=True)

            # 2. Hyperopt (solo si hay datos nuevos o se fuerza)
            elif not args.skip_hyperopt:
                prop = run_hyperopt(ticker)
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
                print(f"    → {cmp['status']} | ΔexpOOS={cmp['d_exp_oos']:+0.3f}R | "
                      f"ΔDD={cmp['dd_improve_ratio']*100:+.1f}% | ΔPnL={cmp['pnl_drop_ratio']*100:+.1f}%", flush=True)

            # 3. Killswitch sweep (siempre, es barato relativo y no depende del OOS)
            try:
                ks = run_ks_sweep(ticker)
                if ks:
                    report["ks_proposal"] = ks
                    print(f"    KS propuesta: maxDLR={ks['maxDailyLossR']} maxCL={ks['maxConsecutiveLosses']} (score={ks['score']})", flush=True)
            except Exception as e:
                report["ks_error"] = str(e)[:200]
                print(f"    ⚠ KS sweep falló: {e}", flush=True)

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

    print("════ RESUMEN ════")
    print("\n".join(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
