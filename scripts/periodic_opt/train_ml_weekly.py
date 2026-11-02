#!/usr/bin/env python3
"""Isolated weekly ML candidates and paired Validation proposals.

Default and --dry-run are simulation/proposal-only, independent of Firestore and
run_weekly AUTO_APPLY_ENABLED. Only --allow-promotion authorizes verified paired
replacement; --dry-run always overrides it. No historical accuracy comparison or
Train+Val refit. Candidate and proposal persist in a unique artifact run directory.
Freshness counts closed accepted Train/Validation entries after the current last
label cutoff (not file mtime). Unknown legacy range or identical dataset needs
explicit --force, which never bypasses paired, temporal or artifact-hash guards.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]
VENV_PY = REPO / "scripts" / "hyperopt" / ".venv" / "bin" / "python"
if __name__ == '__main__' and VENV_PY.is_file() and Path(sys.prefix).resolve() != VENV_PY.parent.parent.resolve():
    import os
    os.execv(str(VENV_PY), [str(VENV_PY), str(Path(__file__).resolve()), *sys.argv[1:]])
sys.path.insert(0, str(REPO / "scripts"))
import train_ml_model as trainer

MODELS_DIR = trainer.MODELS_DIR
TRAINER = REPO / "scripts" / "train_ml_model.py"
TICKERS_ALL = ["EURUSD", "GBPUSD", "AUDCAD", "US500", "XAUUSD",
               "USDJPY", "USDCAD", "NZDUSD", "USOIL", "BTCUSD"]
MIN_NEW_TRADES = 15


def run_trainer(ticker: str, output: Path, old_path: Path | None, args) -> tuple[int, dict | None, str]:
    command = [str(VENV_PY if VENV_PY.is_file() else Path(sys.executable)), str(TRAINER), ticker,
               "--output", str(output), "--dry-run", "--min-new-trades", str(args.min_new_trades)]
    if args.force:
        command.append("--force")
    for flag, value in [("--evaluation-manifest", args.evaluation_manifest),
                        ("--trades-file", args.trades_file), ("--log-dir", args.log_dir),
                        ("--config", args.config), ("--current-model", old_path)]:
        if value is not None:
            command.extend([flag, str(value)])
    result = subprocess.run(command, cwd=REPO, capture_output=True, text=True, timeout=3600)
    if result.returncode:
        return result.returncode, None, (result.stdout or result.stderr)[-2000:]
    if not output.is_file():
        raise trainer.ProtocolError("trainer succeeded without candidate artifact")
    candidate = json.loads(output.read_text())
    trainer.validate_export(candidate)
    freshness = candidate.get("meta", {}).get("freshness", {})
    if freshness.get("minimum") != args.min_new_trades or freshness.get("forced") is not args.force:
        raise trainer.ProtocolError("trainer freshness policy differs from requested CLI policy")
    return 0, candidate, result.stdout


def promote_candidate(*, candidate_path: Path, target: Path, ticker: str,
                      old_source: Path, expected_artifact_sha256: str,
                      allow_promotion: bool = False, dry_run: bool = False) -> str:
    """Promote only the frozen, paired Train-only artifact with explicit permission.

    The approved digest covers the entire JSON, not just its trees. A dedicated
    ticker destination is atomically replaced; the generic fallback is read-only.
    """
    if allow_promotion is not True:
        return "PERMISSION_REQUIRED"
    if dry_run:
        return "DRY_RUN"
    import hashlib
    import os
    candidate_path, target, old_source = map(Path, (candidate_path, target, old_source))
    if (not ticker.isalnum() or ticker != ticker.upper()
            or target.name != f"ml_model_{ticker}.json"
            or target.is_symlink() or candidate_path.is_symlink() or old_source.is_symlink()
            or target.resolve() == candidate_path.resolve()
            or trainer.MODELS_DIR.resolve() in candidate_path.resolve().parents
            or target.parent.resolve() != old_source.parent.resolve()
            or old_source.name not in (f"ml_model_{ticker}.json", "ml_model.json")):
        raise trainer.ProtocolError("invalid candidate/current-model promotion paths")
    candidate_bytes = candidate_path.read_bytes()
    candidate = json.loads(candidate_bytes)
    if trainer.digest(candidate) != expected_artifact_sha256:
        raise trainer.ProtocolError("candidate artifact differs from approved digest")
    trainer.validate_export(candidate)
    meta = candidate.get("meta", {})
    manifest = trainer.validate_manifest(meta.get("evaluation_manifest"), ticker)
    schema = dict(version=1, names=trainer.FEATURE_NAMES, n_features=12, type="finite_numeric", order="runtime")
    proof = meta.get("dataset_provenance", {})
    source = meta.get("dataset_source", {})
    if (not isinstance(proof, dict) or not isinstance(source, dict)
            or meta.get("dataset_provenance_sha256") != trainer.digest(proof)
            or meta.get("dataset_source_sha256") != trainer.digest(source)
            or not isinstance(source.get("provenance"), str)
            or proof.get("manifest_sha256") != trainer.digest(manifest)
            or proof.get("validation_sha256") != meta.get("validation_sha256")
            or proof.get("counts") != meta.get("counts")
            or proof.get("max_label_closed_at_ms") != meta.get("max_label_closed_at_ms")):
        raise trainer.ProtocolError("dataset provenance hashes/context mismatch")
    if (meta.get("protocol_version") != 1 or meta.get("ticker") != ticker
            or meta.get("model_sha256") != trainer.model_fingerprint(candidate)
            or meta.get("config_sha256") != trainer.digest(meta.get("config"))
            or meta.get("feature_schema_sha256") != trainer.digest(meta.get("feature_schema"))
            or meta.get("feature_schema") != schema
            or not isinstance(meta.get("config"), dict) or meta["config"].get("ticker") != ticker
            or meta["config"].get("mlGate") not in (None, {"enabled": False})
            or meta.get("inference_profile") != trainer.INFERENCE_PROFILE
            or meta.get("runtime_native_parity_verified") is not True
            or meta.get("refit_on_validation") is not False
            or meta.get("test_evaluated") is not False or meta.get("test_samples") != 0
            or meta.get("train_end_ms") != manifest["train_end_ms"]):
        raise trainer.ProtocolError("candidate provenance/Train-only protocol mismatch")
    for partition, start, end in [("train", manifest["from_ms"], manifest["train_end_ms"]),
                                  ("validation", manifest["train_end_ms"], manifest["validation_end_ms"])]:
        close = meta.get("max_label_closed_at_ms", {}).get(partition)
        n = meta.get(f"{partition}_samples")
        if (type(close) is not int or not start <= close < end
                or type(n) is not int or n < 20
                or meta.get("counts", {}).get(partition, {}).get("accepted") != n):
            raise trainer.ProtocolError("candidate has invalid sample/label closure provenance")
    available = meta.get("available_at_ms")
    trained = meta.get("trained_at_ms")
    if (type(available) is not int or type(trained) is not int
            or not manifest["train_end_ms"] <= trained <= available
            or meta.get("trained_at") != trainer.utc(trained)):
        raise trainer.ProtocolError("invalid model availability/trained UTC metadata")
    for key, value in [("dataset_sha256", meta.get("dataset_sha256")),
                       ("validation_sha256", meta.get("validation_sha256")),
                       ("train_sha256", proof.get("train_sha256"))]:
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise trainer.ProtocolError(f"invalid {key}")
    paired = meta.get("paired_validation", {})
    old_bytes = old_source.read_bytes()
    old = json.loads(old_bytes)
    old_threshold = trainer.validate_export(old)[1]
    freshness = meta.get("freshness", {})
    cutoff = trainer.freshness_cutoff(old.get("meta", {}))
    identical = trainer.same_dataset(meta, old.get("meta", {}))
    if (not isinstance(freshness, dict) or freshness.get("version") != 1
            or type(freshness.get("forced")) is not bool
            or type(freshness.get("minimum")) is not int or freshness["minimum"] < 0
            or freshness.get("cutoff_ms") != cutoff
            or freshness.get("identical_dataset") is not identical):
        raise trainer.ProtocolError("candidate freshness proof mismatch")
    counts = freshness.get("new_trades_by_partition", {})
    n = freshness.get("new_trades")
    if cutoff is None:
        if n is not None or counts != {"train": None, "validation": None}:
            raise trainer.ProtocolError("unknown freshness must not invent new trade counts")
    elif (not isinstance(counts, dict) or set(counts) != {"train", "validation"}
          or any(type(counts[p]) is not int or not 0 <= counts[p] <= meta[f"{p}_samples"]
                 or (meta["max_label_closed_at_ms"][p] <= cutoff and counts[p] != 0)
                 for p in ("train", "validation"))
          or type(n) is not int or n != sum(counts.values())):
        raise trainer.ProtocolError("invalid freshness new trade counts")
    if not freshness["forced"] and (cutoff is None or identical or n < freshness["minimum"]):
        raise trainer.ProtocolError("candidate fails freshness minimum/known/new dataset guard")
    if (paired.get("eligible") is not True or paired.get("status") != "PROPOSE"
            or paired.get("inference_profile") != trainer.INFERENCE_PROFILE
            or paired.get("validation_sha256") != meta["validation_sha256"]
            or paired.get("old_model_sha256") != trainer.model_fingerprint(old)
            or paired.get("threshold") != old_threshold or meta.get("threshold") != old_threshold
            or paired.get("n") != meta["validation_samples"]
            or not isinstance(paired.get("old"), dict) or not isinstance(paired.get("new"), dict)
            or paired["new"] != meta.get("validation_metrics")
            or not 0 <= paired["old"].get("accuracy", -1) <= paired["new"].get("accuracy", -1) <= 1):
        raise trainer.ProtocolError("missing/mismatched or degrading paired Validation")
    classes = paired.get("class_counts", {})
    if (set(classes) != {"WIN", "LOSS"}
            or any(type(classes.get(c)) is not int or classes[c] < 1 for c in ("WIN", "LOSS"))
            or sum(classes.values()) != paired["n"]):
        raise trainer.ProtocolError("paired Validation requires both classes")
    for metrics in (paired["old"], paired["new"]):
        tp, fp, passed = (metrics.get(k) for k in ("passed_wins", "passed_losses", "passed"))
        if (any(type(v) is not int for v in (tp, fp, passed))
                or not 0 <= tp <= classes["WIN"] or not 0 <= fp <= classes["LOSS"]
                or passed != tp + fp):
            raise trainer.ProtocolError("invalid paired Validation confusion counts")
        fn = classes["WIN"] - tp
        expected = dict(accuracy=(tp + classes["LOSS"] - fp) / paired["n"],
                        precision=tp / max(1, passed), recall=tp / classes["WIN"],
                        f1=2 * tp / max(1, 2 * tp + fp + fn))
        import math
        for key, value in expected.items():
            actual = metrics.get(key)
            if (type(actual) not in (int, float) or not math.isfinite(actual)
                    or not math.isclose(actual, value, rel_tol=1e-12, abs_tol=1e-12)):
                raise trainer.ProtocolError("inconsistent paired Validation metrics")
    # A fallback may initialize a ticker file, but may never overwrite a newer
    # ticker model that appeared since collection.
    target_before = target.read_bytes() if target.exists() else None
    if old_source.resolve() != target.resolve() and target_before is not None:
        raise trainer.ProtocolError("ticker model appeared since generic fallback collection")
    declared_source = meta.get("old_model_source")
    if declared_source and Path(declared_source).resolve() != old_source.resolve():
        raise trainer.ProtocolError("old model source path mismatch")
    if declared_source and meta.get("old_source_sha256") != hashlib.sha256(old_bytes).hexdigest():
        raise trainer.ProtocolError("old source bytes changed since paired Validation")
    if paired.get("old_artifact_sha256") != trainer.digest(old):
        raise trainer.ProtocolError("old model artifact changed since paired Validation")
    # Stable separate lock inodes survive os.replace. Lock both the generic
    # fallback and dedicated target in a fixed order so cooperating promotions
    # cannot validate one version and replace a newer concurrent writer.
    import fcntl
    from contextlib import ExitStack
    lock_paths = sorted({p.parent.resolve() / f".{p.stem}.promotion.lock"
                         for p in (old_source, target)}, key=str)
    with ExitStack() as locks:
        for lock_path in lock_paths:
            fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
            handle = locks.enter_context(os.fdopen(fd, "a+b"))
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        if old_source.read_bytes() != old_bytes:
            raise trainer.ProtocolError("old source bytes changed before locked promotion")
        if (candidate_path.read_bytes() != candidate_bytes
                or (target.read_bytes() if target.exists() else None) != target_before):
            raise trainer.ProtocolError("model/artifact changed before locked promotion")
        staged = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f".{target.name}-", delete=False) as stream:
                staged = Path(stream.name)
                # Preserve existing readers' permissions; NamedTemporaryFile
                # defaults to 0600, potentially unreadable by the live bot.
                os.fchmod(stream.fileno(), old_source.stat().st_mode & 0o777)
                stream.write(candidate_bytes)
                stream.flush()
                os.fsync(stream.fileno())
            if (old_source.read_bytes() != old_bytes or candidate_path.read_bytes() != candidate_bytes
                    or (target.read_bytes() if target.exists() else None) != target_before):
                raise trainer.ProtocolError("model/artifact changed before atomic promotion")
            os.replace(staged, target)
            staged = None
            if target.read_bytes() != candidate_bytes:
                raise trainer.ProtocolError("promoted model readback differs from approved artifact")
        finally:
            if staged is not None:
                staged.unlink(missing_ok=True)
    return "PROMOTED"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tickers", default=",".join(TICKERS_ALL))
    parser.add_argument("--min-new-trades", type=int, default=MIN_NEW_TRADES)
    parser.add_argument("--force", action="store_true", help="bypass freshness only; never temporal/paired guards")
    parser.add_argument("--dry-run", action="store_true", help="save candidate and paired proposal without promotion")
    parser.add_argument("--allow-promotion", action="store_true", help="explicitly authorize guarded paired promotion; --dry-run always wins")
    parser.add_argument("--evaluation-manifest")
    parser.add_argument("--trades-file", help="offline partitioned snapshot; single ticker")
    parser.add_argument("--config")
    parser.add_argument("--log-dir")
    parser.add_argument("--output-dir", help="isolated artifact root; unique run subdirectory")
    parser.add_argument("--models-dir", default=str(MODELS_DIR), help="current model directory (read only in simulation)")
    args = parser.parse_args(argv)
    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    try:
        if not tickers or len(set(tickers)) != len(tickers) or any(not t.isalnum() for t in tickers):
            raise trainer.ProtocolError("invalid/duplicate tickers")
        if (args.evaluation_manifest or args.trades_file or args.config or args.log_dir) and len(tickers) != 1:
            raise trainer.ProtocolError("explicit dataset/config paths require one ticker per invocation")
        if args.min_new_trades < 0:
            raise trainer.ProtocolError("min-new-trades must be nonnegative")
        models_dir = Path(args.models_dir).resolve()
        if args.output_dir:
            root = Path(args.output_dir).resolve()
            # Reject both active and supplied-current model trees, including symlinks.
            trainer.ensure_candidate_path(root / "check-new-artifact.json")
            if root == models_dir or models_dir in root.parents:
                raise trainer.ProtocolError("artifact directory must be isolated from current models")
            root.mkdir(parents=True, exist_ok=True)
            artifacts = Path(tempfile.mkdtemp(prefix="run-", dir=root))
        else:
            artifacts = Path(tempfile.mkdtemp(prefix="jarvis-ml-weekly-"))
        summary = []
        exit_code = 0
        for ticker in tickers:
            output = artifacts / f"ml_model_{ticker}.json"
            proposal = dict(ticker=ticker, dry_run=args.dry_run, simulation=True, promoted=False,
                            candidate_path=str(output), status="HOLD")
            try:
                old, old_path = trainer.load_current_model(ticker, models_dir)
                code, candidate, message = run_trainer(ticker, output, old_path, args)
                proposal["current_model_source"] = str(old_path) if old_path else None
                if code:
                    proposal.update(status="HOLD" if code == 2 else "ERROR", trainer_exit=code,
                                    reason=message)
                    exit_code = max(exit_code, code)
                else:
                    paired = candidate["meta"].get("paired_validation", {})
                    proposal.update(status="PROPOSE" if paired.get("eligible") else "HOLD",
                                    paired_validation=paired,
                                    candidate_sha256=trainer.model_fingerprint(candidate),
                                    candidate_artifact_sha256=trainer.digest(candidate),
                                    permission_required=True, reason=paired.get("reason"))
                    if args.allow_promotion and paired.get("eligible") is True:
                        if old_path is None:
                            raise trainer.ProtocolError("paired promotion requires a current model source")
                        status = promote_candidate(candidate_path=output,
                                                   target=models_dir / f"ml_model_{ticker}.json",
                                                   ticker=ticker, old_source=old_path,
                                                   expected_artifact_sha256=proposal["candidate_artifact_sha256"],
                                                   allow_promotion=args.allow_promotion, dry_run=args.dry_run)
                        proposal.update(promotion_status=status, promoted=status == "PROMOTED",
                                        simulation=status != "PROMOTED", permission_required=False)
                        if status == "PROMOTED":
                            proposal["status"] = status
            except (trainer.ProtocolError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
                proposal.update(status="ERROR", reason=str(exc))
                exit_code = 1
            proposal_path = artifacts / f"proposal_{ticker}.json"
            with proposal_path.open("x") as stream:
                json.dump(proposal, stream, indent=2, allow_nan=False)
            summary.append(proposal)
            print(json.dumps(proposal))
        print(json.dumps(dict(artifact_dir=str(artifacts), summary=summary)))
        return exit_code
    except (trainer.ProtocolError, OSError, ValueError) as exc:
        print(json.dumps(dict(status="ERROR", promoted=False, reason=str(exc))), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
