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
import select
import subprocess
import sys
import threading
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

# F3-etapa1: presets de ROI time-decay que el optimizador puede elegir.
# "roi_off" = tabla vacía → getEffectiveROI devuelve [0, null] → sin acción ROI.
ROI_PRESETS: Dict[str, Dict[str, float]] = {
    "roi_std":       {"0": 0.015, "30": 0.005, "60": 0},
    "roi_off":       {},
    "roi_aggressive": {"0": 0.025, "30": 0.008, "60": 0.003},
    "roi_mild":      {"0": 0.008, "30": 0.003, "60": 0},
}

# F3-etapa2: sesiones del backtest y parámetros de gestión de salida que se
# muestrean POR SESIÓN (el backtest los lee por gatillo dentro de config.sessions).
# El resto queda global por activo (se leen a nivel raíz del config).
SESSIONS = ["LONDON", "NY", "ASIA", "OFF"]
# 🆕 sep-2026 (Capa 1): familias de zona con peso por sesión (config.zoneWeights).
# OB = zones base; GOD/SB/BREAKER = medallas; SWEEP/DIV = eventos de liquidez/divergencia.
ZONE_FAMILIES = ["OB", "GOD", "SB", "BREAKER", "SWEEP", "DIV"]
ZONE_WEIGHT_CHOICES = [0.0, 0.5, 1.0, 1.5, 2.0]
SESSION_MGMT_CATEGORICALS: Dict[str, list] = {
    "partialClosePct":      [0.0, 0.5, 0.8],
    "slAfterTp1":           ["none", "midpoint", "breakeven"],
    "tp15BeEnabled":        [True, False],
    "atrTrailEnabled":      [True, False],
    "structuralTrailEnabled": [True, False],
}

def suggest_params(trial: optuna.Trial) -> Dict[str, Any]:
    """Define el espacio de búsqueda. Con TPE el sampling es inteligente."""
    # 🔧 FIX: NO muestrear params SMC (pivot/wick/div/z). El backtest no los evalúa
    # (el motor consume eventos pre-horneados de los CSVs); los tunnea el bruteforcer.
    params: Dict[str, Any] = {
        # Risk Management — globales por activo
        "slBufferPercent": trial.suggest_float("slBufferPercent", 0.0, 0.25),
        "fixedRR": trial.suggest_float("fixedRR", 1.2, 5.0),
        "minRR": trial.suggest_float("minRR", 1.0, 3.0),
        "oteEntryPercent": trial.suggest_categorical("oteEntryPercent", [50, 62, 79]),

        # Scoring — umbrales del AlphaModel
        "minBuyPoints": trial.suggest_int("minBuyPoints", 3, 12),
        "minSellPoints": trial.suggest_int("minSellPoints", 3, 12),
        # 🆕 sep-2026 (A/B VWAP de Bon): peso del evento VWAP en el scoring, por activo.
        # Evidencia A/B: global 6 ayuda XAUUSD (+16R OOS) pero daña leve a 5 activos → por activo.
        "vwapPts": trial.suggest_int("vwapPts", 2, 6),

        # F3-etapa1: los 3 que antes estaban fijos
        # TP1 estructural: el extremo del impulso se usa como TP1 solo si queda
        # a >= minRR × riesgo; si no, fallback al 1R fijo (AlphaModel.ts:391-394).
        # Se lee a nivel RAÍZ del config (no por gatillo) → global.
        "tp1StructuralMinRR": trial.suggest_float("tp1StructuralMinRR", 1.0, 2.0),
        # ROI time-decay: elegir entre presets (backtestEngine.ts:485 lo lee a nivel config)
        "minimal_roi": trial.suggest_categorical("minimal_roi", list(ROI_PRESETS.keys())),

        # F4 (07-sep-2026): umbral de override del filtro TimesFM — ahora parte del
        # espacio. Solo tiene efecto si el backtest corre CON filtro (timesfm.enabled
        # + cache de forecasts precomputados; ver build_backtest_config).
        # Rango cubre desde permisivo (6, scores reales vistos 4.25-13.5) hasta
        # más estricto que el default actual (20/25).
        "minScoreToOverrideReject": trial.suggest_categorical(
            "minScoreToOverrideReject", [6, 8, 10, 12, 15, 20, 25]),
    }

    # 🛡️ sep-2026 (reorganización dueño-único): la gestión de salida POR SESIÓN salió
    # del hyperopt — su dueño es per_trigger_tune.ts (minScore/slBuff/tp2/partialClose/
    # slAfterTp1/trails POR GATILLO, cableado al dominical como paso 2b). El hyperopt
    # conserva los fallbacks globales (raíz) que el vivo lee cuando el gatillo no tiene
    # valor propio. Antes estas 20 dims eran trabajo muerto (per_trigger_tune las pisaba).
    # 🆕 sep-2026 (Capa 1 del optimizador del motor): pesos de zona × sesión (6 familias ×
    # 4 sesiones). 0 = desactivar la familia en esa sesión. El backtest y el vivo los
    # aplican vía config.zoneWeights (paridad exacta).
    for fam in ZONE_FAMILIES:
        for sess in SESSIONS:
            params[f"zw_{fam}_{sess}"] = trial.suggest_categorical(
                f"zw_{fam}_{sess}", ZONE_WEIGHT_CHOICES)
    return params


def _ml_gate_block(ticker: str) -> Optional[Dict[str, Any]]:
    """ML F3 (sep-2026): bloque mlGate para el backtest — walk-forward por mtime del modelo."""
    models_dir = Path(__file__).resolve().parent / "models"
    ml_model_p = models_dir / f"ml_model_{ticker}.json"
    if not ml_model_p.exists():
        return None
    try:
        return {
            "enabled": True,
            "modelPath": str(ml_model_p),
            "trainedAt": int(ml_model_p.stat().st_mtime * 1000),
        }
    except OSError:
        return None


def build_backtest_config(ticker: str, params: Dict[str, Any],
                          timesfm_cache: Optional[Path] = None,
                          current_sessions: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Convierte los hiperparámetros en un BacktestConfig completo.
    Los triggers activos se mantienen en un subset conservador (los 4 que
    smc_bruteforcer.ts considera activos por default).

    F4 (07-sep-2026): si `timesfm_cache` apunta a un JSONL de forecasts
    precomputados existente, el backtest corre CON el filtro TimesFM activo y
    minScoreToOverrideReject (sorteado) tiene efecto real en las métricas.
    Sin cache → filtro OFF (comportamiento histórico, con warning): un cache
    ausente haría que TODAS las decisiones fueran DEGRADADO→APPROVE y el umbral
    se optimizaría sobre ruido.
    """
    # 🛡️ solo-5M (sep-2026): el hyperopt DEBE evaluar sobre gatillos 5m.
    # Antes usaba 15m → las propuestas semanales prendían 15m en producción
    # (evidencia A/B 8 meses: solo-5M +490R vs solo-15M −193R).
    active_triggers = ["choch5m", "bos5m", "oteChoch5m", "oteBos5m"]
    sessions: Dict[str, Any] = {}
    if current_sessions:
        # 🛡️ sep-2026 (paridad de umbrales): partir de las sesiones VIGENTES del vivo
        # (per-gatillo minScore/slBuff/tp2/mgmt/entryPercent que escribe per_trigger_tune)
        # y solo forzar enabled en los 4 gatillos 5m. Los fallbacks globales del hyperopt
        # actúan encima (raíz). Así las trials miden SOBRE lo que el vivo aplica.
        for sess in SESSIONS:
            src = current_sessions.get(sess) or {}
            sess_cfg: Dict[str, Any] = {}
            for t, cfg in src.items():
                if isinstance(cfg, dict):
                    sess_cfg[t] = dict(cfg)
            for t in active_triggers:
                base = sess_cfg.get(t) if isinstance(sess_cfg.get(t), dict) else {}
                sess_cfg[t] = {**base, "enabled": True}
            sessions[sess] = sess_cfg
    else:
        for sess in SESSIONS:
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
                    "tp2": params["fixedRR"],
                    "slBuff": params["slBufferPercent"],
                    "entryPercent": params["oteEntryPercent"] if t.startswith("ote") else 50,
                    "tp1StructuralMinRR": params["tp1StructuralMinRR"],
                }
            sessions[sess] = sess_cfg

    # F4 (07-sep-2026): bloque TimesFM en el config del backtest.
    # Réplica del bloque de producción (asset_configs.timesfm: counterMult=1,
    # lowConvictionMult=1 → filtro en modo "rechazo puro") + el umbral sorteado.
    # maxForecastAgeMs/bridgeUrl no aplican en backtest (usa cachePath).
    timesfm_block: Optional[Dict[str, Any]] = None
    if timesfm_cache and Path(timesfm_cache).exists():
        timesfm_block = {
            "enabled": True,
            "horizon": 12,
            "alignedMult": 1.0,
            "counterMult": 1.0,
            "lowConvictionMult": 1.0,
            "flatMult": 0.6,
            "spreadAtrHighConv": 5.3,
            "dirEpsAtr": 0.05,
            "rejectEnabled": True,
            "minScoreToOverrideReject": params["minScoreToOverrideReject"],
            "cachePath": str(timesfm_cache),
        }
    else:
        print(f"[hyperopt] ⚠ {ticker}: sin cache de forecasts TimesFM en {timesfm_cache} → "
              f"filtro OFF en las trials (minScoreToOverrideReject sorteado pero sin efecto).",
              file=sys.stderr, flush=True)

    config: Dict[str, Any] = {
        "ticker": ticker,
        "minBuyPoints": params["minBuyPoints"],
        "minSellPoints": params["minSellPoints"],
        "minRR": params["minRR"],
        "slBufferPercent": params["slBufferPercent"],
        "fixedRR": params["fixedRR"],
        "oteEntryPercent": params["oteEntryPercent"],
        "entryTrigger": "SMART",
        # 🆕 sep-2026 (A/B VWAP): peso VWAP por activo (backtestEngine lo lee a nivel raíz)
        # 🛡️ 22-sep: .get() — estudios reanudados con trials viejos (pre-VWAP) no traen la clave.
        "vwapPts": params.get("vwapPts", 3),
        # 🆕 sep-2026 (Capa 1): pesos de zona × sesión (familias → sesión → multiplicador)
        # 🛡️ 22-sep: default 1.0 (neutro) para trials viejos sin zw_*.
        "zoneWeights": {
            fam: {sess: float(params.get(f"zw_{fam}_{sess}", 1.0)) for sess in SESSIONS}
            for fam in ZONE_FAMILIES
        },
        # F3-etapa1: tp1StructuralMinRR a nivel raíz — es la clave que lee el AlphaModel
        # compartido en el path OTE del backtest (AlphaModel.ts:393 `config.tp1StructuralMinRR ?? 1.2`).
        # Antes no estaba a nivel raíz → el backtest siempre usaba el default 1.2 sin importar el trigger.
        "tp1StructuralMinRR": params["tp1StructuralMinRR"],
        "sessions": sessions,
        # 🔧 FIX: directManagement eliminado — la gestión ahora viaja dentro de cada trigger de sesión
        # 🔧 FIX: smc_overrides eliminado — el backtest no lo leía (params SMC los tunnea el bruteforcer)
        # F3-etapa1: minimal_roi ahora viene del espacio (preset elegido), antes fijo
        "minimal_roi": ROI_PRESETS[params["minimal_roi"]],
        # 🛡️ ML F3 (sep-2026): gate ML idéntico al vivo dentro de las trials (walk-forward).
        # trainedAt = mtime del modelo → el modelo de la semana pasada evalúa la semana nueva.
        # Sin modelo para el ticker → None (gate OFF, comportamiento legacy).
        "mlGate": _ml_gate_block(ticker),
    }
    if timesfm_block:
        config["timesfm"] = timesfm_block
    return config


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
        # 🔧 FIX: drenar stderr en un hilo para evitar deadlock de pipe (>64KB) y preservar el tail de errores
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        if self.proc.stderr is None:
            return
        for line in self.proc.stderr:
            self._ts_errors.append(line.strip())
            if len(self._ts_errors) > 200:
                self._ts_errors = self._ts_errors[-200:]

    def _send(self, method: str, params: Optional[dict] = None, timeout: float = 180.0) -> dict:
        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("worker stdin/stdout cerrados")
        msg_id = self._next_id
        self._next_id += 1
        payload = {"id": msg_id, "method": method, "params": params or {}}
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

        # Leer respuesta (línea por línea hasta matchear id) con timeout por trial
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise RuntimeError(f"timeout esperando respuesta del worker ({timeout}s)")
            ready, _, _ = select.select([self.proc.stdout], [], [], remaining)
            if not ready:
                continue  # timeout parcial → re-evaluar deadline
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
            except json.JSONDecodeError:
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
        config = build_backtest_config(args.ticker, params, timesfm_cache=args.timesfm_cache,
                                       current_sessions=args.current_sessions)
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
        if res.get("metrics_oos"):
            trial.set_user_attr("metrics_oos", res["metrics_oos"])

        # Optuna MAXIMIZA → devolvemos obj tal cual
        # (en Freqtrade loss_objective se MINIMIZA y devuelve el negativo)
        oos = res.get("metrics_oos")
        oos_str = f" | OOS_PF={oos['profit_factor']:.2f}" if oos else ""
        print(
            f"[trial {trial.number:>4}] obj={obj:+.4f} | "
            f"PF={metrics['profit_factor']:.2f} | DD={metrics['max_drawdown_r']:.2f}R | "
            f"WR={metrics['win_rate']*100:5.1f}% | n={metrics['trade_count']:>3} | "
            f"{dt_ms:>6.0f}ms{oos_str}",
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
        "best_metrics_oos": study.best_trial.user_attrs.get("metrics_oos") if study.best_trial else None,
        "best_config": build_backtest_config(args.ticker, study.best_params,
                                             timesfm_cache=args.timesfm_cache,
                                             current_sessions=args.current_sessions) if study.best_trial else None,
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
    p.add_argument("--timesfm-cache", default=None,
                   help="JSONL de forecasts TimesFM precomputados (activa el filtro en las trials). "
                        "Default: logs/<ticker>/forecasts/forecasts_m5.jsonl si existe.")
    p.add_argument("--current-sessions", default=None,
                   help="JSON con {ticker, sessions} vigentes del vivo (paridad de umbrales per-gatillo)")
    args = p.parse_args()

    if args.current_sessions:
        try:
            args.current_sessions = json.loads(Path(args.current_sessions).read_text()).get("sessions")
        except Exception as e:
            print(f"[hyperopt] ⚠ no se pudo cargar current-sessions ({e}) — se corre sin overlay", file=sys.stderr)
            args.current_sessions = None

    if not args.timesfm_cache:
        default_cache = REPO_ROOT / "logs" / args.ticker.lower() / "forecasts" / "forecasts_m5.jsonl"
        args.timesfm_cache = default_cache if default_cache.exists() else None
    if args.timesfm_cache:
        args.timesfm_cache = Path(args.timesfm_cache)

    if not WORKER_TS.exists():
        print(f"FATAL: no se encontró el worker {WORKER_TS}", file=sys.stderr)
        return 1

    return run_optimization(args)


if __name__ == "__main__":
    sys.exit(main())
