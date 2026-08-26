#!/usr/bin/env python3
"""train_ml_weekly.py — Re-entrenamiento ML periódico (post run_weekly).

Orquesta train_ml_model.py por activo con 3 guardrails:
  1. FRESCURA: solo re-entrena si hay >= MIN_NEW_TRADES trades cerrados nuevos
     (WIN/LOSS) en Firestore desde el trained_at del modelo actual.
  2. Entrena a un archivo TEMPORAL (nunca pisa el modelo vivo).
  3. GUARDRAIL DE CALIDAD: solo reemplaza el ml_model_<T>.json si el accuracy OOS
     del nuevo >= accuracy del actual. Si no, mantiene el actual (HOLD).

SECUENCIAL y ligero: se ejecuta DESPUÉS de run_weekly.py (ExecStartPost en systemd),
nunca en paralelo (el VPS tiene 7.8GB y run_weekly ya usa hasta 5GB).

Uso:
    python3 scripts/periodic_opt/train_ml_weekly.py [--tickers EURUSD,GBPUSD,...] \
        [--min-new-trades 30] [--force] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path("/opt/JARVIS")
MODELS_DIR = REPO / "scripts" / "hyperopt" / "models"
VENV_PY = REPO / "scripts" / "hyperopt" / ".venv" / "bin" / "python"
TRAINER = REPO / "scripts" / "train_ml_model.py"
FIREBASE_PROJECT = "jarvis-67f66"

TICKERS_ALL = ["EURUSD", "GBPUSD", "AUDCAD", "US500", "XAUUSD",
               "USDJPY", "USDCAD", "NZDUSD", "USOIL", "BTCUSD"]

MIN_NEW_TRADES = 30
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


def count_new_trades(api_key: str, ticker: str, since_ms: int) -> int:
    """Cuenta trades WIN/LOSS cerrados en Firestore con closedAt (o timestamp) > since_ms."""
    url = (f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}"
           f"/databases/(default)/documents/trade_journal?key={api_key}&pageSize=400")
    n = 0
    try:
        docs = rest_json(url).get("documents", [])
    except Exception as e:
        print(f"    ⚠ count_new_trades: error Firestore ({e})", flush=True)
        return -1
    for doc in docs:
        f = doc.get("fields", {})
        if f.get("ticker", {}).get("stringValue", "").upper() != ticker:
            continue
        result = f.get("result", {}).get("stringValue", "")
        if result not in ("WIN", "LOSS"):
            continue
        ts_str = (f.get("closedAt", {}).get("integerValue")
                  or f.get("timestamp", {}).get("integerValue") or "0")
        try:
            ts = int(ts_str)
        except (ValueError, TypeError):
            continue
        if ts > since_ms:
            n += 1
    return n


def load_current_model(ticker: str) -> dict | None:
    p = MODELS_DIR / f"ml_model_{ticker}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def current_accuracy(ticker: str) -> float:
    m = load_current_model(ticker)
    if not m:
        return -1.0  # no hay modelo → el nuevo siempre "mejora"
    return float(m.get("meta", {}).get("accuracy") or 0.0)


def current_trained_at_ms(ticker: str) -> int:
    m = load_current_model(ticker)
    if not m:
        return 0
    ts = m.get("meta", {}).get("trained_at") or ""
    if not ts:
        return 0
    try:
        import datetime
        dt = datetime.datetime.fromisoformat(ts)
        return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
    except Exception:
        return 0


def run_trainer(ticker: str, tmp_dir: Path) -> dict | None:
    """Ejecuta train_ml_model.py con output-dir temporal. Devuelve meta del nuevo modelo o None."""
    tmp_dir.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        [str(VENV_PY), str(TRAINER), ticker, "--output-dir", str(tmp_dir)],
        cwd=str(REPO), capture_output=True, text=True, timeout=60 * 60,
    )
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "")[-300:]
        print(f"    ❌ trainer exit {r.returncode}: {tail}", flush=True)
        return None
    out = tmp_dir / f"ml_model_{ticker}.json"
    if not out.exists():
        print("    ❌ trainer no produjo archivo", flush=True)
        return None
    return json.loads(out.read_text())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", default=",".join(TICKERS_ALL))
    ap.add_argument("--min-new-trades", type=int, default=MIN_NEW_TRADES)
    ap.add_argument("--force", action="store_true", help="ignora el guardrail de frescura")
    ap.add_argument("--dry-run", action="store_true", help="reporta sin reemplazar modelos")
    args = ap.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    api_key = get_api_key()
    tmp_root = REPO / "scripts" / "periodic_opt" / "ml_tmp"
    summary = []

    for ticker in tickers:
        print(f"═══ {ticker} ═══", flush=True)
        acc_cur = current_accuracy(ticker)
        trained_ms = current_trained_at_ms(ticker)

        # Guardrail 1: frescura
        new_trades = count_new_trades(api_key, ticker, trained_ms)
        if new_trades < 0:
            summary.append(f"{ticker}: FIREBASE_ERROR")
            continue
        print(f"    modelo actual acc={acc_cur:.3f} trained={trained_ms} | trades nuevos WIN/LOSS: {new_trades}", flush=True)
        if not args.force and new_trades < args.min_new_trades:
            print(f"    → SKIP (frescura: {new_trades} < {args.min_new_trades} trades nuevos)", flush=True)
            summary.append(f"{ticker}: SKIP_FRESCURA")
            continue

        # Entrenar a temporal
        tmp_dir = tmp_root / ticker
        new_model = run_trainer(ticker, tmp_dir)
        if not new_model:
            summary.append(f"{ticker}: TRAIN_ERROR")
            continue

        acc_new = float(new_model.get("meta", {}).get("accuracy") or 0.0)
        n_train = new_model.get("meta", {}).get("train_samples", 0)

        # Guardrail 3: solo reemplaza si mejora (o no había modelo)
        if acc_new >= acc_cur:
            status = "REPLACED"
            if not args.dry_run:
                src = tmp_dir / f"ml_model_{ticker}.json"
                dst = MODELS_DIR / f"ml_model_{ticker}.json"
                dst.write_text(src.read_text())
                # Backend (MLFilterNode) solo carga default + por-ticker; no copiamos default aquí.
                print(f"    ✅ REEMPLAZADO: acc {acc_cur:.3f} → {acc_new:.3f} (n_train={n_train})", flush=True)
            else:
                print(f"    ✅ (dry-run) habría reemplazado: acc {acc_cur:.3f} → {acc_new:.3f}", flush=True)
        else:
            status = "HOLD"
            print(f"    ⏸️ HOLD: nuevo acc {acc_new:.3f} < actual {acc_cur:.3f} — se mantiene el actual", flush=True)

        summary.append(f"{ticker}: {status} (acc {acc_cur:.3f}→{acc_new:.3f})")

    print("\n════ RESUMEN ════")
    print("\n".join(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
