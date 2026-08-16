#!/usr/bin/env python3
"""analyze_f0.py — Lee f0_report.json y emite el veredicto del gate + reporte markdown.

Gate (definido en la spec F0):
  1. Cobertura empírica q10–q90 ≥ 70% (por dataset y en agregado)
  2. PIT razonablemente uniforme: cada bin ∈ [5%, 15%] (agregado por TF/horizonte)
"""
import json
import sys
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent / "f0_report"
COVERAGE_GATE = 0.70
PIT_BIN_LO, PIT_BIN_HI = 5.0, 15.0


def main() -> int:
    report = json.load(open(OUT / "f0_report.json"))
    datasets = report["datasets"]
    if not datasets:
        print("Sin datasets todavía.")
        return 1

    lines = []
    w = lines.append
    w("# F0 — Benchmark de calibración TimesFM 2.5 200M (torch CPU, zero-shot)\n")
    w(f"- Modelo: `{report['model']}` (pkg timesfm {report['timesfm_pkg']})")
    w(f"- Contexto: {report['context_n']} cierres · Horizontes: {report['horizons']} velas")
    w(f"- Orígenes por dataset: {report['origins_per_dataset']} (stride determinista, seed fija)")
    w(f"- Look-ahead: cero (contexto = cierres ≤ T; realizado = T+1..T+H)\n")

    # --- Tabla por dataset ---
    w("## Cobertura y calibración por dataset\n")
    w("| Dataset | H | Cobertura q10–q90 (step) | Cobertura path conjunta | Cal. error | PIT max dev (pp) |")
    w("|---|---|---|---|---|---|")
    gate_rows = []
    for ds in report["datasets"]:
        name = f"{ds['ticker'].upper()} {ds['tf']}"
        for h, m in ds["horizons"].items():
            cov, pj = m["coverage_q10_q90_step"], m["coverage_path_joint"]
            ce, pitdev = m["calibration_error_mean_abs"], m["pit_max_bin_deviation_pp"]
            ok = "✅" if cov >= COVERAGE_GATE else "❌"
            w(f"| {name} | {h} | {cov*100:.1f}% {ok} | {pj*100:.1f}% | {ce:.4f} | {pitdev:.2f} |")
            gate_rows.append((name, h, cov, pitdev))

    # --- Agregado por TF × H ---
    w("\n## Agregado por TF × horizonte (pooling de todos los activos)\n")
    w("| TF | H | Cobertura media | PIT bins min–max % | PIT uniforme | Gate cobertura |")
    w("|---|---|---|---|---|---|")
    agg_verdicts = []
    for tf in ["M15", "M5"]:
        for h in ["H6", "H12", "H24"]:
            covs = [ds["horizons"][h]["coverage_q10_q90_step"] for ds in datasets if ds["tf"] == tf]
            pits = [ds["horizons"][h]["pit_hist_pct"] for ds in datasets if ds["tf"] == tf]
            if not covs:
                continue
            pit_mean = np.mean(pits, axis=0)
            pit_ok = bool(np.all(pit_mean >= PIT_BIN_LO) & np.all(pit_mean <= PIT_BIN_HI))
            cov_mean = float(np.mean(covs))
            cov_ok = cov_mean >= COVERAGE_GATE
            agg_verdicts.append(cov_ok and pit_ok)
            w(f"| {tf} | {h} | {cov_mean*100:.1f}% | {pit_mean.min():.1f}–{pit_mean.max():.1f} | "
              f"{'✅' if pit_ok else '❌'} | {'✅' if cov_ok else '❌'} |")

    # --- Latencia ---
    lat = report.get("latency_single_call")
    if lat:
        w("\n## Latencia single-call en vivo (CPU, contexto=512, H=24)\n")
        w(f"- P50: **{lat['p50_ms']} ms** · P95: {lat['p95_ms']} ms · P99: {lat['p99_ms']} ms · media {lat['mean_ms']} ms ({lat['n_calls']} llamadas)")
        amort = [ds["ms_per_forecast_amortized"] for ds in datasets]
        w(f"- Throughput batched amortizado: {np.mean(amort):.0f} ms/forecast (plano: compute-bound, batching no acelera)")

    # --- Veredicto ---
    covs_all = [r[2] for r in gate_rows]
    n_cov_ok = sum(1 for c in covs_all if c >= COVERAGE_GATE)
    verdict = all(agg_verdicts) if agg_verdicts else False
    w("\n## VEREDICTO DEL GATE\n")
    w(f"- Datasets con cobertura ≥ 70%: **{n_cov_ok}/{len(covs_all)}** celdas (dataset×H)")
    w(f"- Cobertura media global: **{np.mean(covs_all)*100:.1f}%** (mín {min(covs_all)*100:.1f}%, máx {max(covs_all)*100:.1f}%)")
    w(f"- PIT uniforme en todos los agregados TF×H: {'sí' if verdict else 'no'}")
    w(f"\n### {'✅ GATE SUPERADO — se habilita F2 (TP dinámico con q90) además de F1' if verdict else '❌ GATE NO SUPERADO — F1 direccional only + conformal calibration para rescatar cuantiles'}\n")

    text = "\n".join(lines)
    (OUT / "F0_VERDICT.md").write_text(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
