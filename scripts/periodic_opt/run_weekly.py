#!/usr/bin/env python3
"""run_weekly.py — Centro de Optimización Periódica (F1).

Ciclo semanal por activo (secuencial, de madrugada con mercado cerrado):
  1. Frescura: cuenta trades nuevos en trade_journal desde el último reporte.
     Si hay < MIN_NEW_TRADES → HOLD (no re-tunear con datos viejos).
  2. Hyperopt Optuna (200 trials, split OOS 70/30) → mejores params + métricas OOS.
  3. Backtest de la config de PRODUCCIÓN actual (mismo split, mismo worker).
  4. Comparación OOS → status RECOMMEND | HOLD | ERROR.
  5. Escribe reports/{TICKER}.json (el push a Firestore lo hace push_reports.js).

Regla de oro: NUNCA toca asset_configs — solo propone.
Uso:  python3 run_weekly.py [--tickers EURUSD,XAUUSD] [--min-new-trades 20] [--force]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path("/opt/JARVIS")
HERE = Path(__file__).resolve().parent
VENV_PY = REPO / "scripts" / "hyperopt" / ".venv" / "bin" / "python"
HYPEROPT = REPO / "scripts" / "hyperopt" / "run_hyperopt.py"
EVAL_PROD = HERE / "eval_production.ts"
REPORTS_DIR = HERE / "reports"
OPT_OUT_DIR = HERE / "opt_out"
FIREBASE_PROJECT = "jarvis-67f66"

TICKERS_ALL = ["EURUSD", "GBPUSD", "AUDCAD", "US500", "XAUUSD", "USDJPY", "USDCAD", "NZDUSD", "USOIL", "BTCUSD"]

MIN_NEW_TRADES = 20
EXP_GAIN_R = 0.05      # Δ expectancy OOS ≥ esto → RECOMMEND
DD_IMPROVE = 0.15      # o DD mejora ≥15% sin caer PnL >15%
PNL_DROP_MAX = 0.15


def get_api_key() -> str:
    env = REPO / "jarvis-os" / ".env"
    for line in env.read_text().splitlines():
        if line.startswith("VITE_FIREBASE_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("no se encontró VITE_FIREBASE_API_KEY en jarvis-os/.env")


def rest_json(url: str):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read())


def count_new_trades(api_key: str, ticker: str, since_ts: int) -> int:
    """Cuenta trades del journal más nuevos que since_ts (REST, reglas abiertas)."""
    url = (f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}"
           f"/databases/(default)/documents/trade_journal?key={api_key}&pageSize=400")
    data = rest_json(url)
    n = 0
    for doc in data.get("documents", []):
        f = doc.get("fields", {})
        if f.get("ticker", {}).get("stringValue", "").upper() != ticker:
            continue
        ts = f.get("timestamp", {}).get("integerValue")
        if ts and int(ts) > since_ts:
            n += 1
    return n


def load_last_report_ts(ticker: str) -> int:
    p = REPORTS_DIR / f"{ticker}.json"
    if not p.exists():
        return 0
    try:
        return int(json.loads(p.read_text())["timestamp"])
    except Exception:
        return 0


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
    print(f"    hyperopt OK ({time.time()-t0:.0f}s) | best_metrics_oos: "
          f"PF={data.get('best_metrics_oos', {}).get('profit_factor')} "
          f"exp={data.get('best_metrics_oos', {}).get('expectancy')}", flush=True)
    return data


def eval_production(ticker: str) -> dict:
    cmd = ["npx", "tsx", str(EVAL_PROD), ticker]
    r = subprocess.run(cmd, cwd=str(REPO), capture_output=True, text=True, timeout=15 * 60)
    if r.returncode != 0:
        raise RuntimeError(f"eval_production exit {r.returncode}: {(r.stderr or r.stdout)[-400:]}")
    # La última línea del stdout es el JSON (los logs del worker van a stderr)
    for line in reversed(r.stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError("eval_production no devolvió JSON")


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
    return {
        "d_exp_oos": round(d_exp, 3),
        "dd_improve_ratio": round(dd_ratio, 3),
        "pnl_drop_ratio": round(pnl_drop, 3),
        "status": status,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", default=",".join(TICKERS_ALL))
    ap.add_argument("--min-new-trades", type=int, default=MIN_NEW_TRADES)
    ap.add_argument("--force", action="store_true", help="ignora el chequeo de frescura")
    args = ap.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    api_key = get_api_key()
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    summary = []

    for ticker in tickers:
        print(f"═══ {ticker} ═══", flush=True)
        report = {"ticker": ticker, "timestamp": int(time.time() * 1000), "status": "HOLD"}
        try:
            new_trades = count_new_trades(api_key, ticker, load_last_report_ts(ticker))
            print(f"    trades nuevos desde el último reporte: {new_trades}", flush=True)
            if not args.force and new_trades < args.min_new_trades:
                report["status"] = "HOLD"
                report["reason"] = f"solo {new_trades} trades nuevos (<{args.min_new_trades}) — no re-tunear con datos viejos"
                print(f"    → {report['reason']}", flush=True)
            else:
                prop = run_hyperopt(ticker)
                prod = eval_production(ticker)
                cmp = compare(prop.get("best_metrics_oos", {}), prod.get("metrics_oos", {}))
                report.update({
                    "status": cmp["status"],
                    "delta": cmp,
                    "proposal_oos": prop.get("best_metrics_oos"),
                    "production_oos": prod.get("metrics_oos"),
                    "best_config": prop.get("best_config"),
                    "new_trades": new_trades,
                })
                print(f"    → {cmp['status']} | ΔexpOOS={cmp['d_exp_oos']:+0.3f}R | "
                      f"ΔDD={cmp['dd_improve_ratio']*100:+.1f}% | ΔPnL={cmp['pnl_drop_ratio']*100:+.1f}%", flush=True)
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
