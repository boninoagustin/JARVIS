#!/usr/bin/env python3
"""precompute_forecasts.py — cache de forecasts TimesFM para replay en backtest (F1)

Genera logs JSONL con forecasts en los orígenes exactos donde el backtest puede
necesitarlos. LOOK-AHEAD CERO: el forecast en el origen T usa solo cierres ≤ T
(inclusive el cierre de la vela que cierra en T — misma convención que F0).

Modos:
  --triggers triggers.jsonl   → forecast solo en esos ts (los que colectó el engine
                                 en modo collectOnly). Rápido: minutos.
  --full                      → forecast en TODA vela con contexto suficiente (horas).

Uso:
  .venv/bin/python precompute_forecasts.py --ticker eurusd --tf M15 \
      --triggers ab_out/eurusd_15/triggers.jsonl --out ab_out/eurusd_15/forecasts.jsonl
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
MODEL_ID = "google/timesfm-2.5-200m-pytorch"
MODEL_VERSION = "timesfm-2.5-200m-pytorch@f1"
BATCH = 32

PING_RE = re.compile(
    r"PING_PRICE \| TF: (?P<tf>\S+) \| Precio: (?P<price>[0-9.]+) "
    r"\| High: (?P<high>[0-9.]+) \| Low: (?P<low>[0-9.]+).*?\| TS: (?P<ts>\d+)"
)


def norm_tf(tf: str) -> int:
    d = re.sub(r"\D", "", str(tf))
    return int(d) if d else 15


def load_series(ticker: str, tf_min: int) -> tuple[np.ndarray, np.ndarray]:
    """Devuelve (ts_ms[], closes[]) ordenados por ts. Mismo parser que F0."""
    hist = REPO_ROOT / "logs" / ticker / "history_exported"
    fname = hist / f"pine-logs-SMC Master_M{tf_min}.csv"
    if not fname.exists():
        matches = sorted(hist.glob(f"*M{tf_min}*.csv"))
        if not matches:
            raise FileNotFoundError(f"sin pine-log para {ticker} M{tf_min} en {hist}")
        fname = matches[0]
    rows = []
    with open(fname, "r", errors="replace") as f:
        for line in f:
            m = PING_RE.search(line)
            if m and norm_tf(m.group("tf")) == tf_min:
                rows.append((int(m.group("ts")), float(m.group("price"))))
    rows.sort(key=lambda r: r[0])
    ts = np.array([r[0] for r in rows], dtype=np.int64)
    closes = np.array([r[1] for r in rows], dtype=np.float64)
    print(f"[PRE] {ticker} M{tf_min}: {len(ts)} velas desde {fname.name}", flush=True)
    return ts, closes


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticker", required=True)
    ap.add_argument("--tf", required=True, help="M15 | 15 | M5 | 5")
    ap.add_argument("--triggers", help="JSONL con {ts} por línea (orígenes)")
    ap.add_argument("--full", action="store_true", help="todas las velas con contexto")
    ap.add_argument("--out", required=True)
    ap.add_argument("--horizon", type=int, default=24)
    ap.add_argument("--context", type=int, default=512)
    args = ap.parse_args()

    ticker = args.ticker.lower()
    tf_min = norm_tf(args.tf)
    ts, closes = load_series(ticker, tf_min)
    idx_of = {int(t): i for i, t in enumerate(ts)}

    if args.full:
        origins = [int(t) for i, t in enumerate(ts) if i >= args.context - 1]
    else:
        if not args.triggers:
            sys.exit("falta --triggers o --full")
        origins = sorted({json.loads(l)["ts"] for l in open(args.triggers) if l.strip()})
    print(f"[PRE] {len(origins)} orígenes a forecastear (context={args.context}, H={args.horizon})", flush=True)

    # Resolver contextos (look-ahead cero: cierres ≤ T inclusive)
    jobs = []  # (origin_ts, contexto)
    skipped = 0
    for t in origins:
        i = idx_of.get(t)
        if i is None or i < args.context - 1:
            skipped += 1
            continue
        jobs.append((t, closes[i - args.context + 1: i + 1]))
    if skipped:
        print(f"[PRE] {skipped} orígenes salteados (sin contexto suficiente / ts ausente)", flush=True)

    import torch
    import timesfm
    torch.manual_seed(42)
    np.random.seed(42)
    torch.set_num_threads(3)
    torch.set_float32_matmul_precision("high")
    print(f"[PRE] Cargando {MODEL_ID}...", flush=True)
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL_ID)
    model.compile(
        timesfm.ForecastConfig(
            max_context=1024, max_horizon=256, normalize_inputs=True,
            use_continuous_quantile_head=True, force_flip_invariance=True,
            infer_is_positive=True, fix_quantile_crossing=True,
        )
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    done = 0
    with open(out_path, "w") as out:
        for b in range(0, len(jobs), BATCH):
            chunk = jobs[b: b + BATCH]
            pf, qf = model.forecast(horizon=args.horizon, inputs=[c for _, c in chunk])
            for j, (t, _) in enumerate(chunk):
                rec = {
                    "ts": t, "horizon": args.horizon,
                    "point": [round(float(x), 8) for x in pf[j]],
                    "q10": [round(float(x), 8) for x in qf[j, :, 1]],
                    "q50": [round(float(x), 8) for x in qf[j, :, 5]],
                    "q90": [round(float(x), 8) for x in qf[j, :, 9]],
                    "model_version": MODEL_VERSION,
                }
                out.write(json.dumps(rec) + "\n")
            done += len(chunk)
            dt = time.time() - t0
            eta = dt / done * (len(jobs) - done) if done else 0
            pct = 100.0 * done / max(len(jobs), 1)
            bar = "█" * int(pct / 5) + "░" * (20 - int(pct / 5))
            print(f"\r[PRE] {ticker}/M{tf_min} [{bar}] {pct:5.1f}% ({done}/{len(jobs)}) ETA {eta:0.0f}s   ", end="", flush=True)
    print(f"\n[PRE] ✓ {done} forecasts → {out_path} en {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
