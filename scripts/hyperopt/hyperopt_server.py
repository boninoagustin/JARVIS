"""
JARVIS Hyperopt Server — motor Optuna TPE sobre worker TS.

Inspirado en freqtrade/optimize/hyperopt.py:
- El espacio de búsqueda se define vía suggest_float / suggest_int / suggest_categorical.
- TPE sampler (default) construye un modelo probabilístico sobre las trials previas.
- Las trials se persisten en SQLite (storage) para reanudar estudios entre corridas.
- El objetivo se MINIMIZA por convención de Optuna, por eso negamos el score.

Uso:
    python scripts/hyperopt/hyperopt_server.py \
        --ticker EURUSD \
        --log-dir logs/eurusd/history \
        --n-trials 200 \
        --study-name jarvis_eurusd_v1
"""

from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

import optuna
from optuna.samplers import TPESampler

# -----------------------------------------------------------------------------
# Paths
# -----------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER_TS = REPO_ROOT / "scripts" / "hyperopt" / "jarvis_hyperopt_worker.ts"
DEFAULT_STORAGE = REPO_ROOT / "scripts" / "hyperopt" / "jarvis_hyperopt_study.db"


# -----------------------------------------------------------------------------
# Espacio de búsqueda (debe matchear exactamente con runBacktest config)
# -----------------------------------------------------------------------------
# Rangos alineados con los grids actuales del JARVIS:
#   smc_bruteforcer.ts: pivot_lens=[3,5,8,13,21], wick=[0.1,0.3,0.5,0.7],
#                        div=[2,3,5], z=[14,20,50,100]
#   meta-optimize.ts:   sl=[0,0.05,0.1,0.2], rr=[1.5,2,2.5,3,4], ote=[50,62,79],
#                        score=[5,8,12,15,20]
#   handleOptimizeTrigger: partialClose=[0,0.5,0.8], slAfterTp1={none,midpoint,breakeven},
#                        tp15Be={true,false}, atrTrail={true,false}

def suggest_params(trial: optuna.Trial) -> Dict[str, Any]:
    """Define el espacio de búsqueda. Con TPE el sampling es inteligente."""
    return {
        # SMC — parámetros del motor SMCEngine (4 dimensiones)
        "pivot_len": trial.suggest_int("pivot_len", 3, 21),
        "min_sweep_wick_pct": trial.suggest_float("min_sweep_wick_pct", 0.05, 0.8),
        "div_pivot_len": trial.suggest_int("div_pivot_len", 2, 7),
        "z_score_window": trial.suggest_categorical("z_score_window", [14, 20, 50, 100]),

        # Risk Management — parámetros de la gestión de salida
        "slBufferPercent": trial.suggest_float("slBufferPercent", 0.0, 0.25),
        "fixedRR": trial.suggest_float("fixedRR", 1.2, 5.0),
        "minRR": trial.suggest_float("minRR", 1.0, 3.0),
        "oteEntryPercent": trial.suggest_categorical("oteEntryPercent", [50, 62, 79]),

        # Scoring — umbrales del AlphaModel
        "minBuyPoints": trial.suggest_int("minBuyPoints", 3, 12),
        "minSellPoints": trial.suggest_int("minSellPoints", 3, 12),

        # Trade Management — parámetros de jarvis-os/BacktestingPanel
        "partialClosePct": trial.suggest_categorical("partialClosePct", [0.0, 0.5, 0.8]),
        "slAfterTp1": trial.suggest_categorical("slAfterTp1", ["none", "midpoint", "breakeven"]),
        "tp15BeEnabled": trial.suggest_categorical("tp15BeEnabled", [True, False]),
        "atrTrailEnabled": trial.suggest_categorical("atrTrailEnabled", [True, False]),
    }


def build_backtest_config(ticker: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convierte los hiperparámetros en un BacktestConfig completo.
    Los triggers activos se mantienen en un subset conservador (los 4 que
    smc_bruteforcer.ts considera activos por default).
    """
    active_triggers = ["choch15m", "bos15m", "oteChoch15m", "oteBos15m"]
    sessions: Dict[str, Any] = {}
    for sess in ["LONDON", "NY", "ASIA", "OFF"]:
        sess_cfg: Dict[str, Any] = {}
        # desactivar todos los triggers por default
        for t in [
            "choch5m", "choch15m", "bos5m", "bos15m",
            "oteChoch5m", "oteChoch15m", "oteBos5m", "oteBos15m",
        ]:
            sess_cfg[t] = {"enabled": False}
        for t in active_triggers:
            sess_cfg[t] = {
                "enabled": True,
                "minScore": 4,
                "entryPercent": 50,
            }
        sess_cfg["slBufferPercent"] = params["slBufferPercent"]
        sess_cfg["fixedRR"] = params["fixedRR"]
        sessions[sess] = sess_cfg

    return {
        "ticker": ticker,
        "minBuyPoints": params["minBuyPoints"],
        "minSellPoints": params["minSellPoints"],
        "minRR": params["minRR"],
        "slBufferPercent": params["slBufferPercent"],
        "fixedRR": params["fixedRR"],
        "oteEntryPercent": params["oteEntryPercent"],
        "entryTrigger": "SMART",
        "sessions": sessions,
        "directManagement": {
            "partialClosePct": params["partialClosePct"],
            "slAfterTp1": params["slAfterTp1"],
            "tp15BeEnabled": params["tp15BeEnabled"],
            "atrTrailEnabled": params["atrTrailEnabled"],
        },
        # 🆕 ROI time-decay — si no se especifica en el trial, usar default conservador
        "minimal_roi": params.get("minimal_roi", {"0": 0.015, "30": 0.005, "60": 0}),
        # SMC engine se aplica indirectamente via el engine al procesar los logs;
        # el worker también expone pivot/wick/div/z en el payload para usos futuros.
        "smc_overrides": {
            "pivot_len": params["pivot_len"],
            "min_sweep_wick_pct": params["min_sweep_wick_pct"],
            "div_pivot_len": params["div_pivot_len"],
            "z_score_window": params["z_score_window"],
        },
    }


# -----------------------------------------------------------------------------
# Worker process management (NDJSON RPC sobre stdin/stdout)
# -----------------------------------------------------------------------------
class HyperoptWorker:
    """Wrapper sobre el worker TS. Mantiene el proceso vivo entre trials."""

    def __init__(self, tsx_bin: str, npx_bin: str, cwd: Path):
        self.proc = subprocess.Popen(
            [npx_bin, "tsx", str(WORKER_TS)],
            cwd=str(cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered
            env={**os.environ, "PATH": os.environ.get("PATH", "")},
        )
        self._next_id = 1
        self._ts_errors: list[str] = []

    def _send(self, method: str, params: Optional[dict] = None) -> dict:
        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("worker stdin/stdout cerrados")
        msg_id = self._next_id
        self._next_id += 1
        payload = {"id": msg_id, "method": method, "params": params or {}}
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

        # Leer respuesta (línea por línea hasta matchear id)
        while True:
            line = self.proc.stdout.readline()
            if not line:
                # stderr útil para diagnóstico
                tail = "\n".join(self._ts_errors[-20:])
                raise RuntimeError(f"worker cerró stdout. stderr tail:\n{tail}")
            line = line.strip()
            if not line:
                continue
            try:
                resp = json.loads(line)
            except json.JSONDecodeError as e:
                self._ts_errors.append(line)
                continue
            if resp.get("id") == msg_id:
                if "error" in resp:
                    raise RuntimeError(f"worker error: {resp['error']}")
                return resp["result"]

    def init(self, ticker: str, log_dir: str) -> dict:
        return self._send("init", {"ticker": ticker, "log_dir": log_dir})

    def evaluate(self, config: dict) -> dict:
        return self._send("evaluate", {"config": config})

    def ping(self) -> dict:
        return self._send("ping")

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self._send("shutdown")
            except Exception:
                pass
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
def run_optimization(args: argparse.Namespace) -> int:
    # Storage SQLite para persistir el estudio entre corridas
    storage_url = f"sqlite:///{args.storage}"
    sampler = TPESampler(
        n_startup_trials=args.n_startup,
        n_ei_candidates=24,
        multivariate=True,   # capturar correlaciones entre parámetros
        seed=args.seed,
    )

    study = optuna.create_study(
        study_name=args.study_name,
        storage=storage_url,
        sampler=sampler,
        direction="maximize",   # ya manejamos el signo en la función objetivo
        load_if_exists=True,
    )

    # Iniciar worker TS
    tsx_bin = "tsx"
    npx_bin = "npx"
    print(f"[hyperopt] iniciando worker TS...", file=sys.stderr)
    worker = HyperoptWorker(tsx_bin=tsx_bin, npx_bin=npx_bin, cwd=REPO_ROOT)
    try:
        init_info = worker.init(args.ticker, args.log_dir)
        print(f"[hyperopt] worker init OK: {init_info}", file=sys.stderr)
    except Exception as e:
        worker.close()
        print(f"[hyperopt] FATAL: {e}", file=sys.stderr)
        return 1

    completed_before = len(study.trials)
    print(f"[hyperopt] estudio '{args.study_name}' | trials previas: {completed_before}", file=sys.stderr)
    print(f"[hyperopt] objetivo: {args.n_trials} trials nuevos (smoke={args.smoke_test})", file=sys.stderr)

    target_n = 5 if args.smoke_test else args.n_trials
    t_start = time.time()

    def objective(trial: optuna.Trial) -> float:
        params = suggest_params(trial)
        config = build_backtest_config(args.ticker, params)
        t0 = time.time()
        try:
            res = worker.evaluate(config)
        except Exception as e:
            print(f"[hyperopt] trial {trial.number} ERROR: {e}", file=sys.stderr)
            # Devolvemos un valor pésimo pero finito (Optuna no maneja inf bien en TPE)
            return -100.0
        dt_ms = (time.time() - t0) * 1000

        metrics = res["metrics"]
        obj = res["objective"]

        # Reportar atributos del trial para inspección posterior
        trial.set_user_attr("metrics", metrics)
        trial.set_user_attr("trade_count", metrics["trade_count"])
        trial.set_user_attr("profit_factor", metrics["profit_factor"])
        trial.set_user_attr("max_drawdown_r", metrics["max_drawdown_r"])
        trial.set_user_attr("win_rate", metrics["win_rate"])
        trial.set_user_attr("eval_ms", dt_ms)

        # Optuna MAXIMIZA → devolvemos obj tal cual
        # (en Freqtrade loss_objective se MINIMIZA y devuelve el negativo)
        print(
            f"[trial {trial.number:>4}] obj={obj:+.4f} | "
            f"PF={metrics['profit_factor']:.2f} | DD={metrics['max_drawdown_r']:.2f}R | "
            f"WR={metrics['win_rate']*100:5.1f}% | n={metrics['trade_count']:>3} | "
            f"{dt_ms:>6.0f}ms",
            file=sys.stderr,
        )
        return obj

    try:
        study.optimize(objective, n_trials=target_n, show_progress_bar=False)
    except KeyboardInterrupt:
        print("\n[hyperopt] interrumpido por usuario, guardando estudio...", file=sys.stderr)
    finally:
        worker.close()

    elapsed = time.time() - t_start
    n_completed = len(study.trials) - completed_before

    print(f"\n[hyperopt] ══════════════════════════════════════════", file=sys.stderr)
    print(f"[hyperopt] ✅ {n_completed} trials en {elapsed:.1f}s ({elapsed/max(1,n_completed):.2f}s/trial)", file=sys.stderr)
    print(f"[hyperopt] 📊 mejor valor: {study.best_value:+.4f}", file=sys.stderr)
    print(f"[hyperopt] 🎯 mejores parámetros:", file=sys.stderr)
    for k, v in study.best_params.items():
        print(f"             {k:>22} = {v}", file=sys.stderr)
    if study.best_trial:
        m = study.best_trial.user_attrs.get("metrics")
        print(f"[hyperopt] 📈 métricas del mejor trial:", file=sys.stderr)
        print(f"             trades={m['trade_count']}  WR={m['win_rate']*100:.1f}%  "
              f"PF={m['profit_factor']:.2f}  MaxDD={m['max_drawdown_r']:.2f}R  "
              f"Sharpe={m['sharpe_simple']:.2f}  Exp={m['expectancy']:+.3f}", file=sys.stderr)

    # Output JSON estructurado para que load_best_params.py lo consuma
    output = {
        "study_name": args.study_name,
        "ticker": args.ticker,
        "n_trials": len(study.trials),
        "new_trials": n_completed,
        "elapsed_seconds": elapsed,
        "best_value": study.best_value,
        "best_params": study.best_params,
        "best_metrics": study.best_trial.user_attrs.get("metrics") if study.best_trial else None,
        "best_config": build_backtest_config(args.ticker, study.best_params) if study.best_trial else None,
    }
    out_path = Path(args.output)
    out_path.write_text(json.dumps(output, indent=2))
    print(f"[hyperopt] 💾 resultados en {out_path}", file=sys.stderr)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="JARVIS Hyperopt — Bayesian optimization via Optuna")
    p.add_argument("--ticker", required=True, help="Ticker a optimizar (ej. EURUSD)")
    p.add_argument("--log-dir", required=True, help="Directorio con CSVs Pine exportados")
    p.add_argument("--n-trials", type=int, default=200, help="Número de trials (default 200)")
    p.add_argument("--n-startup", type=int, default=20, help="Trials iniciales random antes de TPE (default 20)")
    p.add_argument("--study-name", default="jarvis_default", help="Nombre del estudio (para reanudar)")
    p.add_argument("--storage", default=str(DEFAULT_STORAGE), help="SQLite path")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--output", default="optimized_preset_hyperopt.json")
    p.add_argument("--smoke-test", action="store_true", help="Solo 5 trials para validar end-to-end")
    args = p.parse_args()

    if not WORKER_TS.exists():
        print(f"FATAL: no se encontró el worker {WORKER_TS}", file=sys.stderr)
        return 1

    return run_optimization(args)


if __name__ == "__main__":
    sys.exit(main())
