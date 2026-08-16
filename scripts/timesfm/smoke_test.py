#!/usr/bin/env python3
"""smoke_test.py — F0 paso 0: verificación del entorno TimesFM en el VPS.

Mide y reporta (todo medido, nada estimado):
  1. Versiones pineadas (torch/timesfm/numpy/safetensors/huggingface_hub)
  2. Latencia de arranque: from_pretrained (descarga/cache) + compile()
  3. RAM del proceso antes/después de cargar el modelo (RSS)
  4. Latencia de inferencia single-call (context=512, horizon=24)
  5. Determinismo: mismo context 2 veces → output idéntico (bitwise)
"""
import json
import os
import resource
import time

import numpy as np


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def main() -> None:
    import torch
    import timesfm
    import huggingface_hub
    import safetensors

    print("=== VERSIONES ===")
    print(f"torch            {torch.__version__}")
    print(f"timesfm          {timesfm.__version__ if hasattr(timesfm, '__version__') else '2.0.2 (pip)'}")
    print(f"numpy            {np.__version__}")
    print(f"huggingface_hub  {huggingface_hub.__version__}")
    print(f"safetensors      {safetensors.__version__}")

    torch.manual_seed(42)
    np.random.seed(42)
    torch.set_num_threads(3)  # dejar 1 core libre para el bot
    torch.set_float32_matmul_precision("high")

    print(f"\n=== CARGA (RSS antes: {rss_mb():.0f} MB) ===")
    t0 = time.time()
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
    t_load = time.time() - t0
    print(f"from_pretrained: {t_load:.1f}s (incluye descarga si no está en cache) | RSS: {rss_mb():.0f} MB")

    t0 = time.time()
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
    t_compile = time.time() - t0
    print(f"compile:         {t_compile:.1f}s | RSS: {rss_mb():.0f} MB")

    # Inferencia de prueba: random walk sintético de 512 puntos
    rng = np.random.default_rng(42)
    ctx = 100 * np.exp(np.cumsum(rng.normal(0, 0.001, 512)))

    print("\n=== LATENCIA single-call (context=512, horizon=24) ===")
    lat = []
    for i in range(12):
        t0 = time.time()
        pf, qf = model.forecast(horizon=24, inputs=[ctx])
        dt = (time.time() - t0) * 1000
        if i >= 2:  # descartar warmup
            lat.append(dt)
        print(f"  call {i:02d}: {dt:7.1f} ms{'  (warmup)' if i < 2 else ''}")
    lat = np.array(lat)
    print(f"P50={np.percentile(lat,50):.1f}ms  P95={np.percentile(lat,95):.1f}ms  P99={np.percentile(lat,99):.1f}ms")

    print("\n=== SHAPES ===")
    print(f"point_forecast:    {pf.shape}   (esperado (1, 24))")
    print(f"quantile_forecast: {qf.shape}   (esperado (1, 24, 10): mean + q10..q90)")

    print("\n=== DETERMINISMO ===")
    pf1, qf1 = model.forecast(horizon=24, inputs=[ctx])
    pf2, qf2 = model.forecast(horizon=24, inputs=[ctx])
    det_point = np.array_equal(pf1, pf2)
    det_quant = np.array_equal(qf1, qf2)
    max_diff = float(np.max(np.abs(qf1 - qf2)))
    print(f"point idéntico:    {det_point}")
    print(f"quantiles idénticos: {det_quant} (max abs diff: {max_diff:.3e})")

    print(f"\n=== RAM FINAL ===\nRSS pico: {rss_mb():.0f} MB")

    summary = {
        "torch": torch.__version__,
        "timesfm": "2.0.2",
        "numpy": np.__version__,
        "huggingface_hub": huggingface_hub.__version__,
        "safetensors": safetensors.__version__,
        "load_s": round(t_load, 2),
        "compile_s": round(t_compile, 2),
        "rss_peak_mb": round(rss_mb(), 1),
        "latency_ms": {"p50": float(np.percentile(lat, 50)), "p95": float(np.percentile(lat, 95)), "p99": float(np.percentile(lat, 99))},
        "deterministic": bool(det_point and det_quant),
    }
    with open("/opt/JARVIS/scripts/timesfm/smoke_result.json", "w") as f:
        json.dump(summary, f, indent=2)
    print("\n💾 smoke_result.json guardado")


if __name__ == "__main__":
    main()
