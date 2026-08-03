#!/usr/bin/env python3
"""
load_best_params.py — toma el JSON de salida de hyperopt_server.py y lo
graba en el formato optimized_preset_<TICKER>.json que smc_config.ts ya sabe
leer (loadOptimizedPreset en src/engine/smc/smc_config.ts:50).

Uso:
    python scripts/hyperopt/load_best_params.py optimized_preset_eurusd_hyperopt.json
    python scripts/hyperopt/load_best_params.py optimized_preset_eurusd_hyperopt.json --ticker EURUSD
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

    # Formato compatible con smc_config.ts:loadOptimizedPreset
    # Cada TF tiene sus propios SMC params; acá los escribimos iguales en los 4.
    # En el futuro, el hyperopt podría discriminarlos por timeframe.
    def tf_block(tf_key: str) -> dict:
        return {
            "pivot_len": params["pivot_len"],
            "wick_pct": params["min_sweep_wick_pct"],
            "div_len": params["div_pivot_len"],
            "z_window": params["z_score_window"],
        }

    preset = {
        "M15": tf_block("M15"),
        "H1": tf_block("H1"),
        "H4": tf_block("H4"),
        "D1": tf_block("D1"),
        "Risk": {
            "slBufferPercent": params["slBufferPercent"],
            "fixedRR": params["fixedRR"],
            "minRR": params["minRR"],
            "oteEntryPercent": params["oteEntryPercent"],
            "partialClosePct": params["partialClosePct"],
            "slAfterTp1": params["slAfterTp1"],
            "tp15BeEnabled": params["tp15BeEnabled"],
            "atrTrailEnabled": params["atrTrailEnabled"],
        },
        "Scoring": {
            "minBuyPoints": params["minBuyPoints"],
            "minSellPoints": params["minSellPoints"],
        },
        "Meta": {
            "objective_value": data["best_value"],
            "trade_count": data["best_metrics"]["trade_count"] if data.get("best_metrics") else None,
            "profit_factor": data["best_metrics"]["profit_factor"] if data.get("best_metrics") else None,
            "max_drawdown_r": data["best_metrics"]["max_drawdown_r"] if data.get("best_metrics") else None,
            "win_rate": data["best_metrics"]["win_rate"] if data.get("best_metrics") else None,
            "n_trials": data.get("n_trials"),
            "study_name": data.get("study_name"),
            "source": "hyperopt",
        },
    }

    out_path = Path(args.out) if args.out else REPO_ROOT / f"optimized_preset_{ticker}.json"
    out_path.write_text(json.dumps(preset, indent=4))
    print(f"✅ {ticker}: preset → {out_path}", file=sys.stderr)
    print(f"   objetivo={data['best_value']:+.4f} | trades={preset['Meta']['trade_count']} | "
          f"PF={preset['Meta']['profit_factor']} | DD={preset['Meta']['max_drawdown_r']}R", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
