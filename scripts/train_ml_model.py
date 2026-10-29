#!/usr/bin/env python3
"""Train-only XGBoost candidate and paired temporal Validation (never final Test).

Candidates are immutable isolated artifacts; --dry-run permits these proposals,
never active-model/Firestore writes. Freshness is checked before XGBoost fit;
--force only bypasses the new-data minimum/unknown legacy bootstrap, not protocol.
The exported-tree evaluator matches MLFilter.ts (zero initial margin, base_weights
leaves). Candidate base_score=0.5 makes that runtime equal native XGBoost; legacy
models are evaluated with actual runtime semantics, not historical meta.accuracy.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
VENV_PYTHON = REPO_ROOT / 'scripts/hyperopt/.venv/bin/python'
if __name__ == '__main__' and VENV_PYTHON.is_file() and Path(sys.prefix).resolve() != VENV_PYTHON.parent.parent.resolve():
    # The installed systemd caller uses /usr/bin/python3, without ML packages.
    import os
    os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]])
import numpy as np

MODELS_DIR = REPO_ROOT / "scripts" / "hyperopt" / "models"
FEATURE_NAMES = ["z_score", "vwap_status", "atr_value", "sweep_direction", "simple_trend",
                 "hour_of_day", "session", "day_of_week", "score_points", "active_zones",
                 "choch_points", "bias_aligned"]
INFERENCE_PROFILE = "MLFilter.ts/array-trees/zero-margin/base_weights/v1"


class ProtocolError(ValueError):
    """Fail-closed schema/provenance violation."""


class InsufficientSamples(ProtocolError):
    """Safe HOLD: sample-size or class guard failed."""


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def utc(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_manifest(manifest: dict, ticker: str) -> dict:
    if not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1:
        raise ProtocolError("evaluation_manifest version must be 1")
    if manifest.get("ticker") != ticker:
        raise ProtocolError("evaluation_manifest ticker mismatch")
    keys = ["from_ms", "train_end_ms", "validation_end_ms", "test_end_ms"]
    values = [manifest.get(k) for k in keys]
    if any(type(v) is not int or v < 0 for v in values):
        raise ProtocolError("manifest windows require nonnegative integer milliseconds")
    if not values[0] < values[1] < values[2] <= values[3]:
        raise ProtocolError("manifest windows must be chronological (empty Test allowed)")
    if manifest.get("test_independence") not in ("unverified", "prospective"):
        raise ProtocolError("test_independence must be unverified or prospective")
    return dict(manifest)


def prepare_temporal_dataset(raw: dict, manifest: dict, ticker: str) -> dict:
    manifest = validate_manifest(manifest, ticker)
    bounds = {"train": (manifest["from_ms"], manifest["train_end_ms"]),
              "validation": (manifest["train_end_ms"], manifest["validation_end_ms"])}
    data = {"manifest": manifest, "counts": {}, "max_label_closed_at_ms": {},
            "test_evaluated": False, "embargo_ms": 0}
    for partition, (start, end) in bounds.items():
        trades = raw.get(partition)
        if not isinstance(trades, list):
            raise ProtocolError(f"missing {partition} trades")
        rows = []
        counts = dict(raw=len(trades), accepted=0, purged_overlap=0, excluded_unlabelled=0)
        for trade in trades:
            if not isinstance(trade, dict):
                raise ProtocolError("trade must be an object")
            ts = trade.get("timestamp")
            if type(ts) is not int or not start <= ts < end:
                raise ProtocolError(f"entry timestamp outside {partition} half-open window")
            close = trade.get("closedAt")
            if trade.get("result") not in ("WIN", "LOSS") or close is None:
                counts["excluded_unlabelled"] += 1
                continue
            if type(close) is not int or close < ts:
                raise ProtocolError("closedAt must be integer milliseconds after entry")
            if close >= end:
                counts["purged_overlap"] += 1
                continue
            features = trade.get("mlFeatures")
            if not isinstance(features, dict) or set(features) != set(FEATURE_NAMES):
                raise ProtocolError("mlFeatures must match the exact 12-feature schema")
            if any(isinstance(features[f], bool) or not isinstance(features[f], (int, float))
                   or not np.isfinite(features[f]) for f in FEATURE_NAMES):
                raise ProtocolError("features must be finite numeric values")
            row = {f: float(features[f]) for f in FEATURE_NAMES}
            row.update(ts=ts, closedAt=close, label=int(trade["result"] == "WIN"),
                       result=trade["result"], rMultiple=trade.get("rMultiple"),
                       direction=trade.get("direction"))
            rows.append(row)
        rows.sort(key=lambda row: (row["ts"], row["closedAt"]))
        counts["accepted"] = len(rows)
        data[partition] = rows
        data["counts"][partition] = counts
        data["max_label_closed_at_ms"][partition] = max((r["closedAt"] for r in rows), default=None)
    return data


def validate_export(export: dict) -> tuple[list, float]:
    try:
        declared = [v for v in [export.get("features"), export.get("meta", {}).get("feature_names")] if v is not None]
        if not declared or any(v != FEATURE_NAMES for v in declared):
            raise ProtocolError("model feature order/schema mismatch")
        threshold = export.get("meta", {}).get("threshold", .65)
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 < threshold < 1:
            raise ProtocolError("invalid probability threshold")
        learner = export["xgboost_model"]["learner"]
        if learner["objective"]["name"] != "binary:logistic":
            raise ProtocolError("only binary:logistic supported")
        params = learner["learner_model_param"]
        if int(params["num_feature"]) != 12 or int(params.get("num_class", 0)) != 0 or int(params.get("num_target", 1)) != 1:
            raise ProtocolError("model dimensions mismatch")
        booster = learner["gradient_booster"]
        if booster["name"] != "gbtree":
            raise ProtocolError("only numerical gbtree supported by runtime")
        trees = booster["model"]["trees"]
        if not trees or any(v != 0 for v in booster["model"].get("tree_info", [])):
            raise ProtocolError("empty/multiclass model")
        for tree in trees:
            keys = ["left_children", "right_children", "split_indices", "split_conditions", "base_weights"]
            n = len(tree["left_children"])
            if not n or any(len(tree[k]) != n for k in keys) or any(v != 0 for v in tree.get("split_type", [])):
                raise ProtocolError("invalid tree arrays/categorical splits")
            seen = set()
            stack = [0]
            while stack:
                node = stack.pop()
                if type(node) is not int or node < 0 or node >= n or node in seen:
                    raise ProtocolError("tree contains invalid child/cycle/shared node")
                seen.add(node)
                left, right = tree["left_children"][node], tree["right_children"][node]
                weight, split = tree["base_weights"][node], tree["split_conditions"][node]
                if not np.isfinite(weight) or not np.isfinite(split):
                    raise ProtocolError("nonfinite tree value")
                if left < 0 and right < 0:
                    continue
                if left < 0 or right < 0 or type(tree["split_indices"][node]) is not int or not 0 <= tree["split_indices"][node] < 12:
                    raise ProtocolError("invalid numerical split")
                stack.extend([left, right])
        return trees, float(threshold)
    except (KeyError, TypeError, IndexError, OverflowError, ValueError) as exc:
        if isinstance(exc, ProtocolError):
            raise
        raise ProtocolError(f"invalid exported XGBoost schema: {exc}") from exc


def model_fingerprint(export: dict) -> str:
    _, threshold = validate_export(export)
    return digest(dict(features=FEATURE_NAMES, threshold=threshold, xgboost_model=export["xgboost_model"]))


def predict_export(export: dict, X) -> np.ndarray:
    """Real exported-tree inference matching the current TypeScript runtime.

    Runtime intentionally starts at raw=0, including for legacy base_score != .5.
    Inputs must be finite; unsupported formats fail closed, never constant fallback.
    """
    trees, _ = validate_export(export)
    X = np.asarray(X, dtype=np.float64)
    if X.ndim != 2 or X.shape[1] != 12 or not np.all(np.isfinite(X)):
        raise ProtocolError("prediction requires finite N x 12 features")
    margins = np.zeros(len(X), dtype=np.float64)
    for i, row in enumerate(X):
        for tree in trees:
            node = 0
            while tree["left_children"][node] >= 0:
                feature = tree["split_indices"][node]
                side = "right_children" if row[feature] >= tree["split_conditions"][node] else "left_children"
                node = tree[side][node]
            margins[i] += tree["base_weights"][node]
    return 1 / (1 + np.exp(-np.clip(margins, -700, 700)))


def classification_metrics(y, probability, threshold: float) -> dict:
    approved = probability >= threshold
    wins = y == 1
    tp = int(np.sum(approved & wins))
    fp = int(np.sum(approved & ~wins))
    fn = int(np.sum(~approved & wins))
    return dict(accuracy=float(np.mean(approved == wins)),
                precision=tp / max(1, tp + fp), recall=tp / max(1, tp + fn),
                f1=2 * tp / max(1, 2 * tp + fp + fn), passed=int(approved.sum()),
                passed_wins=tp, passed_losses=fp)


def guard_samples(rows: list, partition: str, minimum: int) -> None:
    if len(rows) < minimum or {r["label"] for r in rows} != {0, 1}:
        raise InsufficientSamples(f"HOLD: {partition} requires >= {minimum} samples and both WIN/LOSS classes; n={len(rows)}")


def ensure_candidate_path(output_path: Path) -> Path:
    path = Path(output_path).resolve()
    if path == MODELS_DIR.resolve() or MODELS_DIR.resolve() in path.parents:
        raise ProtocolError("candidate output must be outside the active models directory")
    if path.exists():
        raise ProtocolError("candidate artifacts are immutable: output already exists")
    return path


def same_dataset(candidate_meta: dict, old_meta: dict) -> bool:
    """Match row or source byte identities, independent of paths/mtime/windows."""
    def equal_hash(a, b):
        return (isinstance(a, str) and len(a) == 64 and all(c in "0123456789abcdef" for c in a)
                and a == b)
    if equal_hash(candidate_meta.get("dataset_sha256"), old_meta.get("dataset_sha256")):
        return True
    proof, old_proof = (m.get("dataset_provenance", {}) for m in (candidate_meta, old_meta))
    if all(equal_hash(proof.get(k), old_proof.get(k)) for k in ("train_sha256", "validation_sha256")):
        return True
    source, old_source = (m.get("dataset_source", {}) for m in (candidate_meta, old_meta))
    if equal_hash(source.get("snapshot_sha256"), old_source.get("snapshot_sha256")):
        return True
    def file_hashes(s):
        provenance = s.get("worker_provenance") or {}
        files = provenance.get("dataset_files", [])
        if not files or any(not isinstance(f, dict) or not equal_hash(f.get("sha256"), f.get("sha256")) for f in files):
            return None
        return sorted(f["sha256"] for f in files)
    hashes = file_hashes(source)
    return hashes is not None and hashes == file_hashes(old_source)


def freshness_cutoff(meta: dict) -> int | None:
    """Conservative shared old label cutoff; never infer it from trained UTC."""
    cutoffs = []
    end = meta.get("train_end_ms")
    if type(end) is int and end > 0:
        cutoffs.append(end - 1)
    closures = meta.get("max_label_closed_at_ms", {})
    if isinstance(closures, dict):
        cutoffs.extend(v for k, v in closures.items() if k in ("train", "validation")
                       and type(v) is int and v >= 0)
    return max(cutoffs) if cutoffs else None


def guard_freshness(data: dict, old_model: dict | None, minimum: int, force: bool = False) -> dict:
    """Count accepted Train/Validation entries and closures after one old cutoff.

    Neither file mtime nor training wall-clock time proves a legacy training range.
    Unknown legacy provenance requires explicit --force bootstrap. Test is unused.
    """
    if type(minimum) is not int or minimum < 0 or type(force) is not bool:
        raise ProtocolError("invalid freshness minimum/force")
    meta = old_model.get("meta", {}) if old_model else {}
    identity = dict(dataset_sha256=digest(dict(manifest=data["manifest"], train=data["train"], validation=data["validation"])),
                    dataset_provenance={f"{p}_sha256": digest(data[p]) for p in ("train", "validation")},
                    dataset_source=data.get("dataset_source", {}))
    identical = same_dataset(identity, meta)
    cutoff = freshness_cutoff(meta)
    counts = {p: sum(r["ts"] > cutoff and r["closedAt"] > cutoff for r in data[p])
              if cutoff is not None else None for p in ("train", "validation")}
    n = sum(counts.values()) if cutoff is not None else None
    proof = dict(version=1, minimum=minimum, forced=force, cutoff_ms=cutoff,
                 new_trades=n, new_trades_by_partition=counts, identical_dataset=identical)
    if not force:
        if identical:
            raise InsufficientSamples("HOLD_FRESHNESS_IDENTICAL_DATASET: same rows/source bytes are not new data; explicit --force required")
        if cutoff is None:
            raise InsufficientSamples("HOLD_FRESHNESS_UNKNOWN: old label/training range unknown; explicit --force required")
        if n < minimum:
            raise InsufficientSamples(f"HOLD_FRESHNESS: {n} new closed trades < {minimum}")
    return proof


def train_candidate(data: dict, output_path: Path, ticker: str, old_model: dict | None,
                    config: dict, n_estimators: int = 100, max_depth: int = 4,
                    learning_rate: float = .1, random_seed: int = 42,
                    min_train_samples: int = 20, min_validation_samples: int = 20,
                    min_new_trades: int = 15, force: bool = False) -> dict:
    import xgboost as xgb
    output_path = ensure_candidate_path(output_path)
    manifest = validate_manifest(data["manifest"], ticker)
    config = data.get("effective_config", config)
    train, validation = data["train"], data["validation"]
    guard_samples(train, "train", min_train_samples)
    guard_samples(validation, "validation", min_validation_samples)
    freshness = guard_freshness(data, old_model, min_new_trades, force)
    threshold = validate_export(old_model)[1] if old_model is not None else .65
    X_train = np.array([[row[f] for f in FEATURE_NAMES] for row in train], dtype=np.float32)
    y_train = np.array([r["label"] for r in train], dtype=np.int32)
    X_val = np.array([[row[f] for f in FEATURE_NAMES] for row in validation], dtype=np.float64)
    y_val = np.array([r["label"] for r in validation], dtype=np.int32)
    model = xgb.XGBClassifier(n_estimators=n_estimators, max_depth=max_depth,
                              learning_rate=learning_rate, objective="binary:logistic",
                              eval_metric="logloss", random_state=random_seed, base_score=.5,
                              n_jobs=1, verbosity=0)
    # No random split, eval_set/early stopping, Validation refit or Test access.
    model.fit(X_train, y_train)
    export = dict(features=list(FEATURE_NAMES),
                  meta=dict(feature_names=list(FEATURE_NAMES), threshold=threshold),
                  importance={f: float(v) for f, v in zip(FEATURE_NAMES, model.feature_importances_)},
                  xgboost_model=json.loads(model.get_booster().save_raw(raw_format="json")))
    # XGBoost can leave unscaled base_weights in unsplit stump trees, while the
    # actual leaf prediction is split_conditions. Runtime reads base_weights:
    # normalize only leaf storage, without changing Booster-native predictions.
    for tree in export["xgboost_model"]["learner"]["gradient_booster"]["model"]["trees"]:
        for node, child in enumerate(tree["left_children"]):
            if child < 0:
                tree["base_weights"][node] = tree["split_conditions"][node]
    new_probability = predict_export(export, X_val)
    native = model.get_booster().predict(xgb.DMatrix(X_val))
    if not np.allclose(new_probability, native, rtol=1e-6, atol=1e-7):
        raise ProtocolError("candidate native XGBoost/runtime inference mismatch")
    new_metrics = classification_metrics(y_val, new_probability, threshold)
    old_metrics = None
    eligible = False
    old_provenance = "absent"
    old_hash = None
    if old_model is not None:
        old_probability = predict_export(old_model, X_val)
        old_metrics = classification_metrics(y_val, old_probability, threshold)
        eligible = new_metrics["accuracy"] >= old_metrics["accuracy"]
        old_hash = model_fingerprint(old_model)
        old_provenance = "legacy_unverified" if old_model.get("meta", {}).get("protocol_version") != 1 else "declared_unverified"
    now_ms = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    bounds = dict(train=(manifest["from_ms"], manifest["train_end_ms"]),
                  validation=(manifest["train_end_ms"], manifest["validation_end_ms"]),
                  test=(manifest["validation_end_ms"], manifest["test_end_ms"]))
    val_hash = digest(validation)
    paired = dict(n=len(validation), class_counts={"LOSS": int(np.sum(y_val == 0)), "WIN": int(np.sum(y_val == 1))},
                  threshold=threshold, old=old_metrics, new=new_metrics, eligible=eligible,
                  status="PROPOSE" if eligible else "HOLD", old_model_sha256=old_hash,
                  old_artifact_sha256=digest(old_model) if old_model is not None else None,
                  old_provenance=old_provenance, validation_sha256=val_hash,
                  inference_profile=INFERENCE_PROFILE,
                  reason="paired_accuracy_non_degradation" if old_metrics else "no_comparable_old_model",
                  return_metrics_not_inferred_from_accuracy=True)
    schema = dict(version=1, names=FEATURE_NAMES, n_features=12, type="finite_numeric", order="runtime")
    dataset_source = data.get("dataset_source", {"provenance": "provided_rows_unverified"})
    dataset_provenance = dict(manifest_sha256=digest(manifest), train_sha256=digest(train),
                              validation_sha256=val_hash,
                              counts=data["counts"], max_label_closed_at_ms=data["max_label_closed_at_ms"])
    export["meta"].update(protocol_version=1, ticker=ticker, n_features=12,
                          freshness=freshness,
                          trained_at=utc(now_ms), trained_at_ms=now_ms, available_at_ms=now_ms,
                          train_end_ms=manifest["train_end_ms"], evaluation_manifest=manifest,
                          windows={k: dict(from_ms=a, to_ms=b, from_utc=utc(a), to_utc=utc(b),
                                           semantics="[from,to)") for k, (a, b) in bounds.items()},
                          max_label_closed_at_ms=data["max_label_closed_at_ms"], counts=data["counts"],
                          embargo_ms=data["embargo_ms"], purge_policy="exclude_close_at_or_after_partition_end",
                          train_samples=len(train), validation_samples=len(validation), test_samples=0,
                          test_evaluated=False, test_independence_verified=False,
                          feature_schema=schema, feature_schema_sha256=digest(schema),
                          dataset_source=dataset_source, dataset_source_sha256=digest(dataset_source),
                          dataset_provenance=dataset_provenance, dataset_provenance_sha256=digest(dataset_provenance),
                          old_model_source=data.get("old_model_source"), old_source_sha256=data.get("old_source_sha256"),
                          dataset_sha256=digest(dict(manifest=manifest, train=train, validation=validation)),
                          validation_sha256=val_hash, config=config, config_sha256=digest(config),
                          model_sha256=model_fingerprint(export), paired_validation=paired,
                          validation_metrics=new_metrics, accuracy=new_metrics["accuracy"],
                          precision=new_metrics["precision"], recall=new_metrics["recall"], f1=new_metrics["f1"],
                          threshold_source="current_model" if old_model else "runtime_default",
                          inference_profile=INFERENCE_PROFILE, runtime_native_parity_verified=True,
                          training_parameters=dict(n_estimators=n_estimators, max_depth=max_depth,
                                                   learning_rate=learning_rate, random_seed=random_seed,
                                                   base_score=.5, n_jobs=1),
                          xgboost_version=xgb.__version__, refit_on_validation=False)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("x") as stream:
        json.dump(export, stream, indent=2, allow_nan=False)
    return export


class WorkerRPC:
    """Bounded subprocess NDJSON RPC; stderr drains to a file, not a blocked pipe."""
    def __init__(self, command=None, timeout=300):
        import subprocess
        import tempfile
        self.timeout = timeout
        self.next_id = 0
        self.buffer = b""
        self.stderr = tempfile.TemporaryFile()
        command = command or [str(REPO_ROOT / "node_modules" / ".bin" / "tsx"),
                              str(REPO_ROOT / "scripts" / "hyperopt" / "jarvis_hyperopt_worker.ts")]
        self.proc = subprocess.Popen(command, cwd=REPO_ROOT, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=self.stderr, bufsize=0)

    def __call__(self, method: str, params: dict) -> dict:
        import os
        import select
        import time
        self.next_id += 1
        request = dict(id=self.next_id, method=method, params=params)
        self.proc.stdin.write((json.dumps(request, allow_nan=False) + "\n").encode())
        self.proc.stdin.flush()
        deadline = time.monotonic() + self.timeout
        while True:
            if b"\n" not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([self.proc.stdout], [], [], remaining)[0]:
                    raise ProtocolError(f"worker RPC timeout: {method}")
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                if not chunk:
                    raise ProtocolError(f"worker closed stdout during {method}")
                self.buffer += chunk
                continue
            line, self.buffer = self.buffer.split(b"\n", 1)
            try:
                response = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(response, dict) or response.get("id") != request["id"]:
                continue
            if "error" in response:
                raise ProtocolError(f"worker RPC {method}: {response['error']}")
            if not isinstance(response.get("result"), dict):
                raise ProtocolError("invalid worker result")
            return response["result"]

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.proc.stdin.close()
        self.proc.stdout.close()
        self.stderr.close()


def read_manifest(value, ticker: str) -> dict | None:
    if value is None:
        return None
    manifest = value if isinstance(value, dict) else json.loads(Path(value).read_text())
    return validate_manifest(manifest, ticker)


def collect_temporal_trades(log_dir: Path, ticker: str, config: dict,
                            evaluation_manifest=None, rpc=None) -> dict:
    requested = read_manifest(evaluation_manifest, ticker)
    own_rpc = rpc is None
    rpc = WorkerRPC() if own_rpc else rpc
    try:
        params = dict(ticker=ticker, log_dir=str(log_dir))
        if requested is not None:
            params["evaluation_manifest"] = requested
        if (config.get('timesfm') or {}).get('cachePath'):
            params['timesfm_cache'] = config['timesfm']['cachePath']
        init = rpc("init", params)
        # Never reconstruct temporal bounds from trade percentiles or old oos_split.
        manifest = validate_manifest(init.get("evaluation_manifest", init.get("manifest")), ticker)
        if requested is not None and manifest != requested:
            raise ProtocolError("worker manifest differs from requested evaluation windows")
        raw, contexts = {}, {}
        effective = None
        # The worker otherwise enables its current model by default. Training
        # rows must come from the same explicitly unfiltered strategy in both windows.
        request_config = dict(config, mlGate={"enabled": False})
        modern = "evaluation_fingerprint" in init or "provenance" in init
        for partition in ("train", "validation"):
            response = rpc("collect_trades", dict(config=request_config, partition=partition))
            if "trade_count" in response and response["trade_count"] != len(response.get("trades", [])):
                raise ProtocolError("worker trade_count mismatch")
            if modern:
                ds = response.get("dataset_meta", {})
                start, end = ((manifest["from_ms"], manifest["train_end_ms"]) if partition == "train"
                              else (manifest["train_end_ms"], manifest["validation_end_ms"]))
                current = response.get("effective_config")
                if (response.get("evaluation_manifest") != manifest
                        or response.get("evaluation_fingerprint") != init.get("evaluation_fingerprint")
                        or response.get("provenance") != init.get("provenance")
                        or not isinstance(current, dict) or current.get("ticker") != ticker
                        or current.get("mlGate") != {"enabled": False}
                        or response.get("ml_provenance", {}).get("enabled") is not False
                        or ds.get("partition") != partition or ds.get("from_ms") != start or ds.get("to_ms") != end
                        or ds.get("evaluation_manifest") != manifest
                        or ds.get("evaluation_fingerprint") != response.get("evaluation_fingerprint")
                        or ds.get("dataset_files") != init.get("provenance", {}).get("dataset_files")
                        or ds.get("terminal_close_policy") != "censored"):
                    raise ProtocolError("worker temporal/config/provenance context mismatch")
                cfg_hash = response.get("config_fingerprint")
                if not isinstance(cfg_hash, str) or len(cfg_hash) != 64 or any(c not in "0123456789abcdef" for c in cfg_hash):
                    raise ProtocolError("invalid worker config_fingerprint")
                if effective is not None and (effective != current or cfg_hash != contexts["train"]["config_fingerprint"]):
                    raise ProtocolError("Train/Validation effective configs differ")
                effective = current
                contexts[partition] = {key: response[key] for key in
                                       ("dataset_meta", "config_fingerprint", "effective_config", "ml_provenance")}
            raw[partition] = response.get("trades")
        data = prepare_temporal_dataset(raw, manifest, ticker)
        data["effective_config"] = effective or request_config
        data["dataset_source"] = dict(provenance="worker_temporal_rpc" if modern else "worker_temporal_rpc_unverified",
                                      log_dir=str(log_dir.resolve()),
                                      worker_dataset_fingerprint=init.get("evaluation_fingerprint",
                                          init.get("dataset_fingerprint", init.get("dataset_sha256"))),
                                      worker_provenance=init.get("provenance"), partitions=contexts)
        rpc("shutdown", {})
        return data
    finally:
        if own_rpc:
            rpc.close()


def default_config(ticker: str) -> dict:
    return dict(ticker=ticker, minBuyPoints=5, minSellPoints=5, minRR=1.5,
                oteEntryPercent=50, entryTrigger="SMART", slBufferPercent=0, fixedRR=2,
                minimal_roi={"0": .015, "30": .005, "60": 0})


def load_current_model(ticker: str, models_dir: Path = MODELS_DIR, explicit=None) -> tuple[dict | None, Path | None]:
    if explicit is not None:
        path = Path(explicit).resolve()
        if not path.is_file():
            raise ProtocolError("explicit current model does not exist")
    else:
        specific = Path(models_dir) / f"ml_model_{ticker}.json"
        generic = Path(models_dir) / "ml_model.json"
        path = specific if specific.is_file() else generic if generic.is_file() else None
        if path is None:
            return None, None
        path = path.resolve()
    model = json.loads(path.read_text())
    validate_export(model)
    return model, path


def main(argv=None) -> int:
    import tempfile
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ticker")
    parser.add_argument("--log-dir")
    parser.add_argument("--evaluation-manifest", help="version=1 Train/Validation/Test windows")
    parser.add_argument("--output", help="new isolated JSON artifact; never active models")
    parser.add_argument("--output-dir", help="compatibility: isolated candidate directory")
    parser.add_argument("--dry-run", action="store_true", help="still train/save candidate, never promote")
    parser.add_argument("--current-model", help="explicit old exported model for paired validation")
    parser.add_argument("--trades-file", help="offline partitioned collect_trades snapshot (requires manifest)")
    parser.add_argument("--config", help="JSON config used for both Train/Validation trade collection")
    parser.add_argument("--n-estimators", type=int, default=100)
    parser.add_argument("--max-depth", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=.1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--min-train-samples", type=int, default=20)
    parser.add_argument("--min-validation-samples", type=int, default=20)
    parser.add_argument("--min-new-trades", type=int, default=15)
    parser.add_argument("--force", action="store_true", help="bypass freshness minimum/unknown bootstrap only; never protocol guards")
    args = parser.parse_args(argv)
    ticker = args.ticker.upper()
    try:
        if not ticker.isalnum():
            raise ProtocolError("invalid ticker")
        if args.output and args.output_dir:
            raise ProtocolError("choose --output or --output-dir, not both")
        if min(args.min_train_samples, args.min_validation_samples) < 20:
            raise ProtocolError("sample guard cannot be reduced below 20 per partition")
        directory = Path(args.output_dir) if args.output_dir else None
        output = Path(args.output) if args.output else (directory or Path(tempfile.mkdtemp(prefix="jarvis-ml-candidate-"))) / f"ml_model_{ticker}.json"
        output = ensure_candidate_path(output)
        old, old_path = load_current_model(ticker, explicit=args.current_model)
        old_bytes = old_path.read_bytes() if old_path else None
        if old_bytes is not None and digest(json.loads(old_bytes)) != digest(old):
            raise ProtocolError("old model changed while loading")
        config = json.loads(Path(args.config).read_text()) if args.config else default_config(ticker)
        if not isinstance(config, dict) or config.get("ticker") != ticker or config.get("mlGate"):
            raise ProtocolError("config requires matching ticker and no ML gate (paired unfiltered trades)")
        manifest = read_manifest(args.evaluation_manifest, ticker)
        if args.trades_file:
            if manifest is None:
                raise ProtocolError("offline trades require an explicit evaluation manifest")
            path = Path(args.trades_file).resolve()
            raw = json.loads(path.read_text())
            data = prepare_temporal_dataset(raw, manifest, ticker)
            data["dataset_source"] = dict(provenance=raw.get("provenance", "offline_snapshot_unverified"),
                                          path=str(path), snapshot_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        else:
            log_dir = Path(args.log_dir) if args.log_dir else REPO_ROOT / "logs" / ticker.lower() / "history_exported"
            if not log_dir.is_dir():
                raise ProtocolError(f"log directory does not exist: {log_dir}")
            data = collect_temporal_trades(log_dir, ticker, config, manifest)
        data["old_model_source"] = str(old_path) if old_path else None
        data["old_source_sha256"] = hashlib.sha256(old_bytes).hexdigest() if old_bytes is not None else None
        if old_path and old_path.read_bytes() != old_bytes:
            raise ProtocolError("old model changed during data collection")
        candidate = train_candidate(data, output, ticker, old, config,
                                    n_estimators=args.n_estimators, max_depth=args.max_depth,
                                    learning_rate=args.learning_rate, random_seed=args.seed,
                                    min_train_samples=args.min_train_samples,
                                    min_validation_samples=args.min_validation_samples,
                                    min_new_trades=args.min_new_trades, force=args.force)
        print(json.dumps(dict(status="CANDIDATE_SAVED", output=str(output), promoted=False,
                              dry_run=args.dry_run, paired_validation=candidate["meta"]["paired_validation"])))
        return 0
    except InsufficientSamples as exc:
        print(json.dumps(dict(status="HOLD", reason=str(exc), promoted=False)))
        return 2
    except (ProtocolError, OSError, ValueError, ImportError) as exc:
        print(json.dumps(dict(status="ERROR", reason=str(exc), promoted=False)), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
