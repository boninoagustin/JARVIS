#!/usr/bin/env python3
"""calibrate_f0.py — F0: benchmark de calibración de TimesFM sobre los CSVs de JARVIS.

Para cada activo y TF (M15, M5):
  - Parsea PING_PRICE de logs/{ticker}/history_exported/pine-logs-SMC Master_{TF}.csv
  - Muestrea orígenes T (stride determinista, semilla fija) con contexto = últimos N cierres ≤ T
    (LOOK-AHEAD CERO: el forecast solo ve cierres ≤ T; lo realizado es T+1..T+H)
  - Forecast batched con horizon=24 → corta H ∈ {6, 12, 24} del mismo llamado
  - Métricas por (ticker, TF, H):
      * cobertura empírica q10–q90 (por paso, y cobertura conjunta del path)
      * PIT (Probability Integral Transform) vía interpolación lineal de cuantiles
        (colas: extrapolación lineal de la pendiente q10–q20 / q80–q90, clamp [1e-4, 1-1e-4])
      * calibration error: media |P(realizado ≤ qτ) − τ| para τ ∈ {0.1..0.9}
  - Latencia: single-call P50/P95/P99 (submuestra dedicada) + throughput batched amortizado

Gate de aceptación: cobertura ≥ 70% y PIT razonablemente uniforme
(criterio explícito: cada bin del PIT ∈ [5%, 15%]).

Uso:
  .venv/bin/python calibrate_f0.py --pilot                 # 1 ticker, sweep de batch size
  .venv/bin/python calibrate_f0.py --origins 500           # corrida completa (default)
  .venv/bin/python calibrate_f0.py --ticker eurusd --tf M15 --origins 200
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).resolve().parent / "f0_report"

TICKERS = ["audcad", "btcusd", "eurusd", "gbpusd", "nzdusd", "us500", "usdcad", "usdjpy", "usoil"]
TFS = ["M15", "M5"]
HORIZONS = [6, 12, 24]
CONTEXT_N = 512
QUANTILE_LEVELS = np.arange(0.1, 0.91, 0.1)  # τ = 0.1..0.9 (índices 1..9 del output)

PING_RE = re.compile(
    r"PING_PRICE \| TF: (?P<tf>\S+) \| Precio: (?P<price>[0-9.]+) "
    r"\| High: (?P<high>[0-9.]+) \| Low: (?P<low>[0-9.]+).*?\| TS: (?P<ts>\d+)"
)


def parse_pings(csv_path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Devuelve (closes, timestamps_ms) de las filas PING_PRICE, en orden."""
    closes, tss = [], []
    with open(csv_path, newline="") as f:
        reader = csv.reader(f)
        next(reader, None)  # header Fecha,Mensaje
        for row in reader:
            if len(row) < 2:
                continue
            m = PING_RE.search(row[1])
            if m:
                closes.append(float(m.group("price")))
                tss.append(int(m.group("ts")))
    return np.array(closes, dtype=np.float64), np.array(tss, dtype=np.int64)


def sample_origins(n_candles: int, n_origins: int, context: int, horizon: int) -> np.ndarray:
    """Índices T tales que context≤T y T+horizon<n_candles. Stride determinista."""
    lo, hi = context, n_candles - horizon - 1
    if hi <= lo:
        return np.array([], dtype=int)
    if hi - lo + 1 <= n_origins:
        return np.arange(lo, hi + 1)
    return np.linspace(lo, hi, n_origins).round().astype(int)


def pit_values(q_levels: np.ndarray, q_vals: np.ndarray, realized: np.ndarray) -> np.ndarray:
    """PIT = F(x_realizado) interpolando la función de cuantiles. Vectorizado.

    q_vals: (M, 9) cuantiles q10..q90 · realized: (M,)
    Colas: extrapolación lineal con la pendiente del tramo adyacente, clamp (eps, 1-eps).
    """
    eps = 1e-4
    M = q_vals.shape[0]
    pits = np.empty(M)
    for i in range(M):
        q = q_vals[i]
        x = realized[i]
        if x <= q[0]:
            slope = 0.1 / max(q[1] - q[0], 1e-12)
            pits[i] = 0.1 - (q[0] - x) * slope
        elif x >= q[-1]:
            slope = 0.1 / max(q[-1] - q[-2], 1e-12)
            pits[i] = 0.9 + (x - q[-1]) * slope
        else:
            j = np.searchsorted(q, x) - 1
            j = min(max(j, 0), 7)
            frac = (x - q[j]) / max(q[j + 1] - q[j], 1e-12)
            pits[i] = q_levels[j] + frac * 0.1
    return np.clip(pits, eps, 1 - eps)


def load_model():
    import torch
    import timesfm

    torch.manual_seed(42)
    np.random.seed(42)
    torch.set_num_threads(3)
    torch.set_float32_matmul_precision("high")

    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
    model.compile(
        timesfm.ForecastConfig(
            max_context=1024,
            max_horizon=256,
            normalize_inputs=True,
            use_continuous_quantile_head=True,
            force_flip_invariance=True,
            infer_is_positive=True,
            fix_quantile_crossing=True,
        )
    )
    return model


def forecast_batched(model, contexts: list[np.ndarray], horizon: int, batch_size: int,
                     progress_label: str = "") -> tuple[np.ndarray, np.ndarray, float]:
    """Devuelve (point (M,H), quantiles (M,H,10), wall_seconds_total)."""
    pts, qts = [], []
    t_start = time.time()
    n_batches = (len(contexts) + batch_size - 1) // batch_size
    for b in range(n_batches):
        chunk = contexts[b * batch_size:(b + 1) * batch_size]
        pf, qf = model.forecast(horizon=horizon, inputs=chunk)
        pts.append(np.asarray(pf, dtype=np.float64))
        qts.append(np.asarray(qf, dtype=np.float64))
        done = min((b + 1) * batch_size, len(contexts))
        pct = 100.0 * done / len(contexts)
        elapsed = time.time() - t_start
        eta = elapsed / max(done, 1) * (len(contexts) - done)
        bar = "█" * int(pct // 5) + "░" * (20 - int(pct // 5))
        print(f"\r  {progress_label} [{bar}] {pct:5.1f}% ({done}/{len(contexts)}) "
              f"ETA {eta:5.0f}s   ", end="", flush=True)
    print()
    return np.vstack(pts), np.vstack(qts), time.time() - t_start


def evaluate_dataset(model, ticker: str, tf: str, closes: np.ndarray, tss: np.ndarray,
                     n_origins: int, batch_size: int) -> dict:
    origins = sample_origins(len(closes), n_origins, CONTEXT_N, max(HORIZONS))
    if len(origins) == 0:
        return {"ticker": ticker, "tf": tf, "error": "insufficient candles"}

    contexts = [closes[t - CONTEXT_N:t] for t in origins]  # solo cierres ≤ T
    pt, qt, wall_s = forecast_batched(
        model, contexts, max(HORIZONS), batch_size, f"{ticker}/{tf}"
    )

    result: dict = {
        "ticker": ticker, "tf": tf,
        "n_candles": int(len(closes)), "n_origins": int(len(origins)),
        "context_n": CONTEXT_N, "wall_s": round(wall_s, 1),
        "ms_per_forecast_amortized": round(1000 * wall_s / len(origins), 1),
        "horizons": {},
    }

    for H in HORIZONS:
        cov_steps, pit_all = [], []
        level_hits = {tau: [] for tau in QUANTILE_LEVELS}
        path_inside = 0

        for i, t in enumerate(origins):
            realized = closes[t + 1: t + H + 1]           # T+1..T+H (futuro, jamás en contexto)
            q_lo = qt[i, :H, 1]                            # q10 por paso
            q_hi = qt[i, :H, 9]                            # q90 por paso
            inside = (realized >= q_lo) & (realized <= q_hi)
            cov_steps.append(inside.astype(np.float64))
            if inside.all():
                path_inside += 1

            q_steps = qt[i, :H, 1:10]                      # (H, 9)
            pit_all.append(pit_values(QUANTILE_LEVELS, q_steps, realized))
            for k, tau in enumerate(QUANTILE_LEVELS):
                level_hits[tau].append((realized <= q_steps[:, k]).astype(np.float64))

        cov_steps_arr = np.concatenate(cov_steps)
        pit_arr = np.concatenate(pit_all)
        hist, _ = np.histogram(pit_arr, bins=10, range=(0.0, 1.0))
        hist_pct = (hist / hist.sum() * 100).round(2)

        cal_err = float(np.mean([
            abs(np.mean(np.concatenate(level_hits[tau])) - tau) for tau in QUANTILE_LEVELS
        ]))
        level_table = {
            f"q{int(tau*100)}": round(float(np.mean(np.concatenate(level_hits[tau]))), 4)
            for tau in QUANTILE_LEVELS
        }

        result["horizons"][f"H{H}"] = {
            "coverage_q10_q90_step": round(float(cov_steps_arr.mean()), 4),
            "coverage_path_joint": round(path_inside / len(origins), 4),
            "pit_hist_pct": hist_pct.tolist(),
            "pit_max_bin_deviation_pp": round(float(np.max(np.abs(hist_pct - 10.0))), 2),
            "calibration_error_mean_abs": round(cal_err, 4),
            "empirical_level_by_quantile": level_table,
        }

    return result


def latency_probe(model, closes: np.ndarray, n_calls: int = 100) -> dict:
    """Latencia single-call (la que importa para el presupuesto en vivo)."""
    origins = sample_origins(len(closes), n_calls, CONTEXT_N, max(HORIZONS))
    lat = []
    for i, t in enumerate(origins):
        ctx = closes[t - CONTEXT_N:t]
        t0 = time.time()
        model.forecast(horizon=max(HORIZONS), inputs=[ctx])
        lat.append((time.time() - t0) * 1000)
        if (i + 1) % 20 == 0:
            print(f"\r  latency probe: {i+1}/{len(origins)} calls", end="", flush=True)
    print()
    lat = np.array(lat[2:])  # descartar warmup
    return {
        "n_calls": int(len(lat)),
        "p50_ms": round(float(np.percentile(lat, 50)), 1),
        "p95_ms": round(float(np.percentile(lat, 95)), 1),
        "p99_ms": round(float(np.percentile(lat, 99)), 1),
        "mean_ms": round(float(lat.mean()), 1),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticker", default=None)
    ap.add_argument("--tf", default=None)
    ap.add_argument("--origins", type=int, default=500)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--pilot", action="store_true", help="1 ticker, sweep batch size + latency probe")
    ap.add_argument("--latency-calls", type=int, default=100)
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("[F0] Cargando TimesFM 2.5 200M (torch CPU)...", flush=True)
    t0 = time.time()
    model = load_model()
    print(f"[F0] Modelo listo en {time.time()-t0:.1f}s (cache caliente)\n", flush=True)

    if args.pilot:
        closes, _ = parse_pings(REPO_ROOT / "logs/eurusd/history_exported/pine-logs-SMC Master_M15.csv")
        print(f"[PILOT] eurusd M15: {len(closes)} velas PING")
        for bs in [8, 16, 32, 64]:
            origins = sample_origins(len(closes), 128, CONTEXT_N, 24)
            ctxs = [closes[t - CONTEXT_N:t] for t in origins]
            _, _, wall = forecast_batched(model, ctxs, 24, bs, f"batch={bs}")
            print(f"  → batch={bs:3d}: {wall:.1f}s total | {1000*wall/len(ctxs):.1f} ms/forecast amortizado")
        lat = latency_probe(model, closes, n_calls=30)
        print(f"  → single-call latency (30 calls): {lat}")
        return 0

    tickers = [args.ticker] if args.ticker else TICKERS
    tfs = [args.tf] if args.tf else TFS

    report: dict = {
        "model": "google/timesfm-2.5-200m-pytorch",
        "timesfm_pkg": "2.0.2",
        "context_n": CONTEXT_N,
        "horizons": HORIZONS,
        "origins_per_dataset": args.origins,
        "batch_size": args.batch,
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "datasets": [],
        "latency_single_call": None,
    }

    n_total = len(tickers) * len(tfs)
    i_ds = 0
    for ticker in tickers:
        for tf in tfs:
            i_ds += 1
            csv_path = REPO_ROOT / f"logs/{ticker}/history_exported/pine-logs-SMC Master_{tf}.csv"
            if not csv_path.exists():
                print(f"[{i_ds}/{n_total}] ⚠️ {csv_path} no existe, skip")
                continue
            closes, tss = parse_pings(csv_path)
            print(f"[{i_ds}/{n_total}] {ticker} {tf}: {len(closes)} velas PING parseadas")
            if len(closes) < CONTEXT_N + max(HORIZONS) + 10:
                print(f"  ⚠️ insuficientes velas ({len(closes)}), skip")
                continue
            res = evaluate_dataset(model, ticker, tf, closes, tss, args.origins, args.batch)
            report["datasets"].append(res)
            # Guardado incremental (resiliente a cortes)
            with open(OUT_DIR / "f0_report.json", "w") as f:
                json.dump(report, f, indent=2)

    # Latencia single-call sobre el primer dataset válido (medida real, no estimada)
    first = tickers[0]
    closes, _ = parse_pings(REPO_ROOT / f"logs/{first}/history_exported/pine-logs-SMC Master_M15.csv")
    print(f"\n[F0] Latency probe single-call ({args.latency_calls} llamadas, {first} M15)...")
    report["latency_single_call"] = latency_probe(model, closes, args.latency_calls)

    with open(OUT_DIR / "f0_report.json", "w") as f:
        json.dump(report, f, indent=2)
    print(f"\n[F0] ✅ Reporte en {OUT_DIR / 'f0_report.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
