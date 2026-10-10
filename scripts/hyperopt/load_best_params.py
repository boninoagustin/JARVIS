#!/usr/bin/env python3
"""
load_best_params.py — toma el JSON de salida de hyperopt_server.py y lo
graba en el formato optimized_preset_<TICKER>.json que smc_config.ts ya sabe
leer (loadOptimizedPreset en src/engine/smc/smc_config.ts:50).

Uso:
    python scripts/hyperopt/load_best_params.py optimized_preset_eurusd_hyperopt.json
    python scripts/hyperopt/load_best_params.py optimized_preset_eurusd_hyperopt.json --ticker EURUSD

🔧 IMPORTANTE (ago-2026): los parámetros SMC (pivot_len/wick_pct/div_len/z_window)
NO son optimizados por el backtest (el motor consume eventos pre-horneados). Los
bloques TF del preset los define el BRUTEFORCER. Este script preserva los bloques
M15/H1/H4/D1 existentes y solo actualiza Risk/Scoring/Meta.
"""

from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("hyperopt_output", help="JSON producido por hyperopt_server.py")
    p.add_argument("--ticker", default=None,
                   help="Default: inferido del JSON. Si se pasa, sobreescribe.")
    p.add_argument("--out", default=None,
                   help="Default: optimized_preset_<TICKER>.json en la raíz")
    args = p.parse_args()

    src = Path(args.hyperopt_output)
    if not src.is_absolute():
        src = REPO_ROOT / src
    if not src.exists():
        print(f"ERROR: {src} no existe", file=sys.stderr)
        return 1

    data = json.loads(src.read_text())
    ticker = (args.ticker or data["ticker"]).upper()
    params = data["best_params"]

    out_path = Path(args.out) if args.out else REPO_ROOT / f"optimized_preset_{ticker}.json"

    # 🔧 FIX: preservar los bloques TF existentes (bruteforcer), no pisarlos con params SMC
    existing_tf: dict = {}
    # 🆕 oct-2026: preservar también Detection/DetectionMeta (tune semanal de detección,
    # dueño ex-bruteforcer) — el hyperopt es dueño SOLO de Risk/Scoring/Meta.
    existing_detection: dict = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text())
            for k in ("M15", "H1", "H4", "D1"):
                if k in existing:
                    existing_tf[k] = existing[k]
            if "Detection" in existing:
                existing_detection["Detection"] = existing["Detection"]
            if "DetectionMeta" in existing:
                existing_detection["DetectionMeta"] = existing["DetectionMeta"]
        except Exception:
            pass

    # 🆕 21-sep-2026: tolerante a espacios nuevos — weekly11+ mueve la gestión de salida
    # (partialClosePct/slAfterTp1/tp15BeEnabled/atrTrailEnabled) a per-gatillo (sessions).
    # Solo se incluyen las claves presentes en best_params.
    risk: dict = {}
    for _k in ("slBufferPercent", "fixedRR", "minRR", "oteEntryPercent",
               "partialClosePct", "slAfterTp1", "tp15BeEnabled", "atrTrailEnabled"):
        if params.get(_k) is not None:
            risk[_k] = params[_k]
    scoring: dict = {}
    for _k in ("minBuyPoints", "minSellPoints"):
        if params.get(_k) is not None:
            scoring[_k] = params[_k]
    preset = {
        **existing_tf,
        **existing_detection,
        "Risk": risk,
        "Scoring": scoring,
        "Meta": {
            "objective_value": data["best_value"],
            "trade_count": data["best_metrics"]["trade_count"] if data.get("best_metrics") else None,
            "profit_factor": data["best_metrics"]["profit_factor"] if data.get("best_metrics") else None,
            "max_drawdown_r": data["best_metrics"]["max_drawdown_r"] if data.get("best_metrics") else None,
            "win_rate": data["best_metrics"]["win_rate"] if data.get("best_metrics") else None,
            "oos_profit_factor": data["best_metrics_oos"]["profit_factor"] if data.get("best_metrics_oos") else None,
            "n_trials": data.get("n_trials"),
            "study_name": data.get("study_name"),
            "source": "hyperopt",
        },
    }

    out_path.write_text(json.dumps(preset, indent=4))
    print(f"✅ {ticker}: preset → {out_path}", file=sys.stderr)
    print(f"   objetivo={data['best_value']:+.4f} | trades={preset['Meta']['trade_count']} | "
          f"PF={preset['Meta']['profit_factor']} | DD={preset['Meta']['max_drawdown_r']}R", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
