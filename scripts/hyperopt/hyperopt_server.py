"""
JARVIS Hyperopt Server — motor Optuna TPE sobre worker TS.

Inspirado en freqtrade/optimize/hyperopt.py:
- El espacio de búsqueda se define vía suggest_float / suggest_int / suggest_categorical.
- TPE sampler (default) construye un modelo probabilístico sobre las trials previas.
- Las trials se persisten en SQLite (storage) para reanudar estudios entre corridas.
- El objetivo se MAXIMIZA sobre Train; Validation no decide el ganador y Test solo se evalúa al final.
- Cada escenario tiene un namespace SHA-256; nunca reusa scores de estudios legacy.
- El export publica la configuración efectiva y métricas de una re-evaluación final.

Uso:
    python scripts/hyperopt/hyperopt_server.py \
        --ticker EURUSD \
        --log-dir logs/eurusd/history \
        --n-trials 200 \
        --study-name jarvis_eurusd_v1
"""

from __future__ import annotations
import argparse
import copy
import hashlib
import inspect
import json
import os
import select
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from evaluation_protocol import load_evaluation_manifest
from objective_adapter import (canonicalize_result, objective_policy,
                               assert_scoring_snapshot, posthoc_shadow_comparison)
import optuna
from wfa_adapter import (canonicalize_window, assert_snapshot as assert_wfa_snapshot,
                         window_bounds, validate_replay_model)
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


def build_backtest_config(ticker: str, params: Dict[str, Any],
                          timesfm_cache: Optional[Path] = None,
                          current_sessions: Optional[Dict[str, Any]] = None,
                          current_timesfm: Optional[Dict[str, Any]] = None,
                          current_ml_gate_enabled: Optional[bool] = None,
                          base_config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build the unchanged 34-dimensional candidate over an immutable snapshot.

    Without a sessions snapshot, keep the legacy four 5m trigger defaults.
    With a snapshot, preserve all triggers and enabled states exactly. Optional
    current_timesfm preserves live filter settings and enabled state; an enabled
    snapshot requires a historical cache. Without it, cache presence retains
    the legacy on/off behavior. ML temporal availability is resolved by worker.
    """
    base = copy.deepcopy(base_config) if base_config is not None else {}
    if not isinstance(base, dict) or (base_config is not None and base.get('ticker') != ticker):
        raise ValueError('base-config must be a BacktestConfig object with matching ticker')
    if 'mlGateEnabled' in base and type(base['mlGateEnabled']) is not bool:
        raise ValueError('base-config mlGateEnabled must be a boolean')
    if current_ml_gate_enabled is None:
        current_ml_gate_enabled = base.get('mlGateEnabled', False)
    if type(current_ml_gate_enabled) is not bool:
        raise ValueError("mlGateEnabled must be a boolean")
    if base_config is not None:
        # A supplied effective snapshot is authoritative for every unsearched field.
        # Conflicting permission snapshots are an error, never a silent gate change.
        if base.get('mlGateEnabled', False) != current_ml_gate_enabled:
            raise ValueError('base-config and current-sessions ML permission mismatch')
        if current_sessions is None:
            current_sessions = base.get('sessions', {})
        if current_timesfm is None:
            current_timesfm = base.get('timesfm', {'enabled': False})
        if timesfm_cache is None and isinstance(base.get('timesfm'), dict):
            timesfm_cache = base['timesfm'].get('cachePath')
    # 🛡️ solo-5M (sep-2026): el hyperopt DEBE evaluar sobre gatillos 5m.
    # Antes usaba 15m → las propuestas semanales prendían 15m en producción
    # (evidencia A/B 8 meses: solo-5M +490R vs solo-15M −193R).
    active_triggers = ["choch5m", "bos5m", "oteChoch5m", "oteBos5m"]
    sessions: Dict[str, Any] = {}
    if current_sessions is not None:
        # Snapshot parity: never turn disabled triggers on, invent sessions, or
        # mutate the caller's overlay. An explicit empty snapshot stays empty.
        sessions = copy.deepcopy(current_sessions)
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
    timesfm_block: Dict[str, Any]
    cache = Path(timesfm_cache).resolve() if timesfm_cache else None
    if current_timesfm is not None:
        timesfm_block = copy.deepcopy(current_timesfm)
        enabled = timesfm_block.get("enabled", False)
        if type(enabled) is not bool:
            raise ValueError("timesfm.enabled must be a boolean")
        timesfm_block["enabled"] = enabled
        if enabled and (cache is None or not cache.is_file()):
            raise ValueError("enabled TimesFM snapshot requires an existing forecasts cache")
        # Live bridge paths do not identify a historical cache; only the
        # explicit/resolved replay cache may be used here.
        if base_config is None or enabled:
            timesfm_block.pop("cachePath", None)
        if enabled:
            timesfm_block["cachePath"] = str(cache)
            timesfm_block["minScoreToOverrideReject"] = params["minScoreToOverrideReject"]
    elif cache and cache.is_file():
        timesfm_block = {
            "enabled": True, "horizon": 12, "alignedMult": 1.0,
            "counterMult": 1.0, "lowConvictionMult": 1.0, "flatMult": 0.6,
            "spreadAtrHighConv": 5.3, "dirEpsAtr": 0.05, "rejectEnabled": True,
            "minScoreToOverrideReject": params["minScoreToOverrideReject"],
            "cachePath": str(cache),
        }
    else:
        timesfm_block = {"enabled": False}

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
        # Live permission is explicit; metadata alone must never opt a scenario in.
        "mlGateEnabled": current_ml_gate_enabled,
        "mlGate": None,
    }
    if timesfm_block:
        config["timesfm"] = timesfm_block
    if base_config is not None:
        # Only the existing 34 dimensions may override the supplied production
        # engine snapshot. In particular entryTrigger, costs, safety flags and
        # every trigger's management remain untouched.
        for key in ('minBuyPoints','minSellPoints','minRR','slBufferPercent','fixedRR',
                    'oteEntryPercent','vwapPts','tp1StructuralMinRR','minimal_roi'):
            base[key] = copy.deepcopy(config[key])
        weights = base.setdefault('zoneWeights', {})
        for family, values in config['zoneWeights'].items():
            weights.setdefault(family, {}).update(values)
        base['sessions'] = sessions
        base['timesfm'] = timesfm_block
        base['mlGateEnabled'] = current_ml_gate_enabled
        # Keep an already-resolved gate exactly, including explicit OFF.
        base.setdefault('mlGate', None)
        return base
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
        self.proc.stdin.write(json.dumps(payload, allow_nan=False) + "\n")
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

    def init(self, ticker: str, log_dir: str,
             evaluation_manifest: str | dict | None = None,
             timesfm_cache: Optional[Path] = None, wfa_plan: dict | None = None) -> dict:
        self._wfa_init = None
        params = {"ticker": ticker, "log_dir": log_dir}
        if wfa_plan is not None:
            from wfa_protocol import validate_wfa_plan
            wfa_plan = validate_wfa_plan(wfa_plan)
            if wfa_plan['ticker'] != ticker or evaluation_manifest is not None:
                raise ValueError('WFA plan ticker/manifest mismatch')
            params['wfa_plan'] = wfa_plan
        if evaluation_manifest is not None:
            params["evaluation_manifest"] = evaluation_manifest
        if timesfm_cache is not None:
            params["timesfm_cache"] = str(timesfm_cache)
        result = self._send("init", params)
        if wfa_plan is not None:
            if result.get('wfa_plan') != wfa_plan or result['provenance'].get('wfa_plan') != wfa_plan:
                raise ValueError('worker init did not sign WFA plan')
            assert_wfa_snapshot(result['provenance'])
            self._wfa_init = copy.deepcopy(result)
        return result

    def evaluate_window(self, config: dict, plan: dict, fold_id: int, role: str,
                        replay_model: dict | None = None) -> dict:
        if getattr(self, '_wfa_init', None) is None or self._wfa_init.get('wfa_plan') != plan:
            raise ValueError('WFA plan must match initialized snapshot')
        fold, _, _ = window_bounds(plan, fold_id, role)
        validate_replay_model(replay_model, plan, fold, role)
        assert_wfa_snapshot(self._wfa_init['provenance'])
        result = self._send('evaluate_window', dict(config=config, plan=plan, fold_id=fold_id,
                                                   role=role, replay_model=replay_model))
        return canonicalize_window(result, plan, fold_id, role, init_info=self._wfa_init,
                                   replay_model=replay_model, requested_config=config)

    def evaluate(self, config: dict) -> dict:
        return canonicalize_result(self._send("evaluate", {"config": config}))

    def evaluate_final(self, config: dict) -> dict:
        return canonicalize_result(self._send("evaluate_final", {"config": config}))

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
                self.proc.wait(timeout=5)
        self._stderr_thread.join(timeout=2)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if stream is not None:
                stream.close()


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
def _fingerprint(value: Any) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _file_hash(path: str | Path) -> dict:
    file = Path(path).resolve()
    return {"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}


def run_optimization(args: argparse.Namespace) -> int:
    """Resume only the exact scenario; publish a fresh final replay, never trial attrs."""
    worker = HyperoptWorker(tsx_bin="tsx", npx_bin="npx", cwd=REPO_ROOT)
    try:
        init_info = worker.init(args.ticker, args.log_dir,
                                getattr(args, "evaluation_manifest", None), args.timesfm_cache)
        assert_scoring_snapshot(init_info['provenance'])
        overlay_file = getattr(args, "current_sessions_file", None)
        overlay_files = [getattr(args, "current_sessions_file_hash", None) or _file_hash(overlay_file)] if overlay_file else []
        base_file = getattr(args, "base_config_file", None)
        base_files = [getattr(args, "base_config_file_hash", None) or _file_hash(base_file)] if base_file else []
        base_config = getattr(args, "base_config", None)
        scenario = {
            "version": 1, "ticker": args.ticker,
            "worker_evaluation_fingerprint": init_info["evaluation_fingerprint"],
            "worker_provenance": init_info["provenance"],
            "evaluation_manifest": init_info["evaluation_manifest"],
            "builder_source": inspect.getsource(build_backtest_config),
            "search_space_source": inspect.getsource(suggest_params),
            "roi_presets": ROI_PRESETS,
            "current_sessions": args.current_sessions,
            "current_timesfm": getattr(args, "current_timesfm", None),
            "current_ml_gate_enabled": getattr(args, "current_ml_gate_enabled", False),
            "overlay_files": overlay_files,
            "base_config": base_config,
            "base_config_fingerprint": _fingerprint(base_config),
            "base_config_files": base_files,
            "server_files": [_file_hash(__file__), _file_hash(Path(__file__).with_name("run_hyperopt.py"))],
            "sampler": {"name": "TPESampler", "seed": args.seed,
                        "n_startup_trials": args.n_startup, "n_ei_candidates": 24,
                        "multivariate": True, "optuna_version": optuna.__version__},
            "python_version": sys.version,
            "objective": {"partition": "train", "direction": "maximize",
                          "implementation": "scripts/hyperopt/metrics.py",
                          "policy": objective_policy(), "shadow_consumed_by_sampler": False},
        }
        fingerprint = _fingerprint(scenario)
        study_name = f"{args.study_name}__{fingerprint}"
        sampler = TPESampler(n_startup_trials=args.n_startup, n_ei_candidates=24,
                             multivariate=True, seed=args.seed)
        study = optuna.create_study(study_name=study_name, storage=f"sqlite:///{args.storage}",
                                    sampler=sampler, direction="maximize", load_if_exists=True)
        existing = study.user_attrs.get("evaluation_fingerprint")
        if existing != fingerprint and (existing is not None or study.trials):
            raise RuntimeError("study provenance missing or mismatched; refusing historical metrics")
        study.set_user_attr("evaluation_fingerprint", fingerprint)
        study.set_user_attr("requested_study_name", args.study_name)
        study.set_user_attr("evaluation_manifest", init_info["evaluation_manifest"])
        study.set_user_attr("provenance", scenario)
        trials_before = len(study.trials)
        t_start = time.monotonic()
        print(f"[hyperopt] estudio '{study_name}' | trials previas: {trials_before}", file=sys.stderr)

        def check_snapshot() -> None:
            for file in scenario["server_files"] + overlay_files + base_files:
                if _file_hash(file["path"]) != file:
                    raise RuntimeError(f"scenario snapshot changed: {file['path']}")

        def check_result(result: dict) -> None:
            if result["evaluation_fingerprint"] != init_info["evaluation_fingerprint"]:
                raise RuntimeError("worker evaluation provenance changed within scenario")
            if result["evaluation_manifest"] != init_info["evaluation_manifest"]:
                raise RuntimeError("worker evaluation manifest changed within scenario")

        def objective(trial: optuna.Trial) -> float:
            check_snapshot()
            params = suggest_params(trial)
            config = build_backtest_config(args.ticker, params, timesfm_cache=args.timesfm_cache,
                current_sessions=args.current_sessions,
                current_timesfm=getattr(args, "current_timesfm", None),
                current_ml_gate_enabled=getattr(args, "current_ml_gate_enabled", None),
                base_config=base_config)
            t0 = time.monotonic()
            res = worker.evaluate(config)
            check_snapshot()
            check_result(res)
            if any(k in res for k in ('metrics_test','test_r','test_trades','metrics_test_canonical')):
                raise RuntimeError("optimization evaluate unexpectedly exposed Test")
            for key in ("effective_config", "config_fingerprint", "evaluation_fingerprint",
                        "metrics_train", "metrics_validation", "validation_r", "ml_provenance",
                        "objective_version", "objective_shadow", "shadow_consumed_by_sampler"):
                trial.set_user_attr(key, res[key])
            metrics = res["metrics_train"]
            trial.set_user_attr("metrics", metrics)
            trial.set_user_attr("metrics_oos", res["metrics_validation"])
            for key in ("trade_count", "profit_factor", "max_drawdown_r", "win_rate"):
                trial.set_user_attr(key, metrics[key])
            trial.set_user_attr("eval_ms", (time.monotonic() - t0) * 1000)
            print(f"[trial {trial.number}] obj={res['objective']:+.4f} | n={metrics['trade_count']}",
                  file=sys.stderr)
            return res["objective"]

        # Failures are FAILED trials, never synthetic complete scores that can win.
        try:
            study.optimize(objective, n_trials=5 if args.smoke_test else args.n_trials,
                           show_progress_bar=False)
        except KeyboardInterrupt:
            print("[hyperopt] interrumpido; re-evaluando ganador completo", file=sys.stderr)
        complete = study.get_trials(states=(optuna.trial.TrialState.COMPLETE,))
        if not complete:
            raise RuntimeError("no completed trials; no candidate exported")
        best = study.best_trial
        check_snapshot()
        final = worker.evaluate_final(best.user_attrs["effective_config"])
        check_snapshot()
        check_result(final)
        if (final["config_fingerprint"] != best.user_attrs["config_fingerprint"] or
                final["effective_config"] != best.user_attrs["effective_config"]):
            raise RuntimeError("final replay changed the winning effective config")
        output = {
            "study_name": study_name, "requested_study_name": args.study_name,
            "ticker": args.ticker, "n_trials": len(study.trials),
            "new_trials": len(study.trials) - trials_before,
            "completed_trials": len(complete),
            "elapsed_seconds": time.monotonic() - t_start,
            "evaluation_manifest": init_info["evaluation_manifest"],
            "evaluation_fingerprint": fingerprint,
            "worker_evaluation_fingerprint": final["evaluation_fingerprint"],
            "provenance": scenario, "config_fingerprint": final["config_fingerprint"],
            "best_value": final["objective"], "best_trial_value": best.value,
            "best_trial_number": best.number, "best_params": best.params,
            "best_config": final["effective_config"],
            "best_metrics": final["metrics_train"],
            "best_metrics_train": final["metrics_train"],
            "best_metrics_validation": final["metrics_validation"],
            "best_metrics_oos": final["metrics_validation"],
            "best_metrics_test": final["metrics_test"],
            "best_validation_r": final["validation_r"],
            "best_oos_r": final["validation_r"], "best_test_r": final["test_r"],
            "ml_provenance": final["ml_provenance"], "final_evaluation": final,
            "objective_version": final['objective_version'],
            "objective_comparison": posthoc_shadow_comparison(complete,
                legacy_best_number=best.number, total_trials=len(study.trials)),
        }
        out_path = Path(args.output)
        out_path.write_text(json.dumps(output, indent=2, allow_nan=False))
        print(f"[hyperopt] resultados re-evaluados en {out_path}", file=sys.stderr)
        return 0
    except Exception as exc:
        print(f"[hyperopt] FATAL: {exc}", file=sys.stderr)
        return 1
    finally:
        worker.close()


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
    p.add_argument("--evaluation-manifest", default=None,
                   help="Version 1 temporal evaluation manifest JSON; default elapsed 70/30, empty Test")
    p.add_argument("--base-config", default=None,
                   help="Immutable effective production BacktestConfig JSON; preserve every unsearched field")
    p.add_argument("--current-sessions", default=None,
                   help="JSON snapshot {ticker, sessions, timesfm?, mlGateEnabled?}; missing ML permission is OFF")
    args = p.parse_args()

    args.base_config_file = args.base_config
    args.base_config_file_hash = None
    args.base_config = None
    if args.base_config_file:
        try:
            file = Path(args.base_config_file).resolve()
            raw = file.read_bytes()
            args.base_config = json.loads(raw)
            if not isinstance(args.base_config, dict) or args.base_config.get("ticker") != args.ticker:
                raise ValueError("base-config must be a BacktestConfig object with matching ticker")
            if "mlGateEnabled" in args.base_config and type(args.base_config["mlGateEnabled"]) is not bool:
                raise ValueError("base-config mlGateEnabled must be a boolean")
            args.base_config_file_hash = {"path":str(file),"sha256":hashlib.sha256(raw).hexdigest()}
        except (OSError, ValueError) as exc:
            p.error(str(exc))

    args.current_sessions_file = args.current_sessions
    args.current_sessions_file_hash = None
    args.current_timesfm = None
    args.current_ml_gate_enabled = args.base_config.get("mlGateEnabled", False) if args.base_config is not None else False
    if args.current_sessions_file:
        try:
            file = Path(args.current_sessions_file).resolve()
            raw = file.read_bytes()
            snapshot = json.loads(raw)
            if not isinstance(snapshot, dict) or snapshot.get("ticker") != args.ticker:
                raise ValueError("current-sessions ticker mismatch")
            if not isinstance(snapshot.get("sessions"), dict):
                raise ValueError("current-sessions requires a sessions object")
            if any(not isinstance(session, dict) for session in snapshot["sessions"].values()):
                raise ValueError("each current-sessions session must be an object")
            args.current_sessions = snapshot["sessions"]
            args.current_timesfm = snapshot.get("timesfm")
            args.current_ml_gate_enabled = snapshot.get("mlGateEnabled", False)
            if type(args.current_ml_gate_enabled) is not bool:
                raise ValueError("current-sessions mlGateEnabled must be a boolean")
            if args.current_timesfm is not None and not isinstance(args.current_timesfm, dict):
                raise ValueError("current-sessions timesfm must be an object")
            args.current_sessions_file_hash = {"path": str(file), "sha256": hashlib.sha256(raw).hexdigest()}
        except (OSError, ValueError) as exc:
            p.error(str(exc))
    if args.evaluation_manifest:
        try:
            load_evaluation_manifest(args.evaluation_manifest, args.ticker)
        except (OSError, ValueError) as exc:
            p.error(str(exc))

    if not args.timesfm_cache and args.base_config is not None:
        args.timesfm_cache = (args.base_config.get("timesfm") or {}).get("cachePath")
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
