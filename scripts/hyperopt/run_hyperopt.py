#!/usr/bin/env python3
"""
run_hyperopt.py — CLI amigable para ejecutar el hyperopt de JARVIS.

Uso:
    python scripts/hyperopt/run_hyperopt.py EURUSD --n-trials 200
    python scripts/hyperopt/run_hyperopt.py XAUUSD --smoke-test
    python scripts/hyperopt/run_hyperopt.py USOIL --study-name jarvis_usoil_oil_v3 --n-trials 500

Resuelve el log_dir automáticamente desde logs/<ticker>/history.
"""

from __future__ import annotations
import argparse
import sys
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VENV_PYTHON = REPO_ROOT / "scripts" / "hyperopt" / ".venv" / "bin" / "python"
SERVER = REPO_ROOT / "scripts" / "hyperopt" / "hyperopt_server.py"

# Defaults: mapea ticker → directorio de logs (sigue convención del repo)
DEFAULT_LOG_PATTERNS = [
    "logs/{ticker}/history_exported",  # Pine Script export format (preferido — runBacktest)
    "logs/{ticker}/history",           # OHLCV raw candles (smc_bruteforcer legacy)
]


def resolve_log_dir(ticker: str) -> Path:
    t = ticker.lower()
    for pattern in DEFAULT_LOG_PATTERNS:
        candidate = REPO_ROOT / pattern.format(ticker=t)
        if candidate.exists():
            # Si tiene CSVs directo, lo usamos
            csvs = list(candidate.glob("*.csv"))
            if csvs:
                return candidate
            # Si tiene subcarpeta history, descendemos
            sub = candidate / "history"
            if sub.exists() and list(sub.glob("*.csv")):
                return sub
    raise FileNotFoundError(
        f"No se encontraron CSVs para {ticker}. Esperado en: "
        + ", ".join(str(REPO_ROOT / p.format(ticker=t)) for p in DEFAULT_LOG_PATTERNS)
    )


def main() -> int:
    p = argparse.ArgumentParser(description="JARVIS Hyperopt CLI")
    p.add_argument("ticker", help="Ticker (ej. EURUSD, XAUUSD, USOIL)")
    p.add_argument("--n-trials", type=int, default=200)
    p.add_argument("--n-startup", type=int, default=20)
    p.add_argument("--study-name", default=None, help="Default: jarvis_<ticker>_<n_trials>")
    p.add_argument("--storage", default=None, help="Default: scripts/hyperopt/jarvis_hyperopt_study.db")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", default=None, help="Default: optimized_preset_<ticker>_hyperopt.json")
    p.add_argument("--smoke-test", action="store_true",
                   help="5 trials para validar pipeline end-to-end sin gastar compute")
    args = p.parse_args()

    if not VENV_PYTHON.exists():
        print(f"ERROR: no existe venv en {VENV_PYTHON}", file=sys.stderr)
        print("Ejecutá: python3 -m venv scripts/hyperopt/.venv && "
              "scripts/hyperopt/.venv/bin/pip install optuna numpy", file=sys.stderr)
        return 1

    try:
        log_dir = resolve_log_dir(args.ticker)
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    # 🔧 FIX: nombre versionado por motor — evita mezclar trials de motores distintos.
    # Bump eng2 → eng3 ante cualquier cambio en backtestEngine/hyperopt que invalide resultados previos.
    study_name = args.study_name or f"jarvis_{args.ticker.lower()}_eng2"
    storage = args.storage or str(REPO_ROOT / "scripts" / "hyperopt" / "jarvis_hyperopt_study.db")
    output = args.output or f"optimized_preset_{args.ticker}_hyperopt.json"

    cmd = [
        str(VENV_PYTHON), str(SERVER),
        "--ticker", args.ticker,
        "--log-dir", str(log_dir),
        "--n-trials", str(args.n_trials),
        "--n-startup", str(args.n_startup),
        "--study-name", study_name,
        "--storage", storage,
        "--seed", str(args.seed),
        "--output", str(REPO_ROOT / output),
    ]
    if args.smoke_test:
        cmd.append("--smoke-test")

    print(f"→ log_dir: {log_dir}", file=sys.stderr)
    print(f"→ study_name: {study_name}", file=sys.stderr)
    print(f"→ command: {' '.join(cmd)}\n", file=sys.stderr)

    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
