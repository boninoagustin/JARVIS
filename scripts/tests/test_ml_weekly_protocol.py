"""Weekly protocol integration on declared synthetic fixtures, not market results."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import importlib.util

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "periodic_opt"))
import train_ml_model as trainer
import train_ml_weekly as weekly
from test_ml_temporal_protocol import MANIFEST, fixture_dataset, legacy_model, trade


@unittest.skipUnless(importlib.util.find_spec("xgboost"), "XGBoost unavailable")
class WeeklyDryRunTests(unittest.TestCase):
    def test_cli_permission_routes_through_guard_and_dry_run_overrides_permission(self):
        from unittest import mock
        data = fixture_dataset()
        old = legacy_model(data)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            models = root / "models"
            models.mkdir()
            target = models / "ml_model_EURUSD.json"
            target.write_text(json.dumps(old))
            before = target.read_bytes()
            data["old_model_source"] = str(target)
            import hashlib
            data["old_source_sha256"] = hashlib.sha256(before).hexdigest()
            seed = root / "seed.json"
            candidate = trainer.train_candidate(data, seed, "EURUSD", old, force=True, config={"ticker": "EURUSD"},
                                                 n_estimators=12, max_depth=2, learning_rate=.3)
            def fixture_trainer(ticker, output, old_path, args):
                output.write_bytes(seed.read_bytes())
                return 0, candidate, "declared synthetic fixture"
            base = ["--tickers", "EURUSD", "--force", "--models-dir", str(models), "--output-dir", str(root / "artifacts")]
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(weekly, "run_trainer", side_effect=fixture_trainer):
                with mock.patch.object(weekly, "promote_candidate", wraps=weekly.promote_candidate) as guard:
                    self.assertEqual(weekly.main(base), 0)
                    self.assertFalse(guard.called)
                    self.assertEqual(target.read_bytes(), before)
                    self.assertEqual(weekly.main(base + ["--allow-promotion", "--dry-run"]), 0)
                    self.assertEqual(guard.call_count, 1)
                    self.assertTrue(guard.call_args.kwargs["allow_promotion"])
                    self.assertTrue(guard.call_args.kwargs["dry_run"])
                    self.assertEqual(target.read_bytes(), before)
                    self.assertEqual(weekly.main(base + ["--allow-promotion"]), 0)
                    self.assertEqual(guard.call_count, 2)
                    self.assertEqual(target.read_bytes(), seed.read_bytes())
            self.assertFalse((models / "ml_model.json").exists())
            proposals = [json.loads(p.read_text()) for p in (root / "artifacts").rglob("proposal_EURUSD.json")]
            self.assertEqual(sum(p["promoted"] for p in proposals), 1)
            self.assertEqual(sum(p["simulation"] for p in proposals), 2)

    def test_weekly_dry_run_saves_paired_proposal_without_network_or_current_model_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            models = root / "models"
            models.mkdir()
            active = models / "ml_model_EURUSD.json"
            active.write_text(json.dumps(legacy_model(fixture_dataset())))
            baseline = active.read_bytes()
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(MANIFEST))
            snapshot = root / "trades.json"
            raw = {"provenance": "declared_synthetic_fixture"}
            for partition, start, count in [("train", 100, 40), ("validation", 200, 24)]:
                raw[partition] = [trade(start+i*2, start+i*2+1, "WIN" if i % 2 else "LOSS",
                                        1.0 if i % 2 else -1.0) for i in range(count)]
            snapshot.write_text(json.dumps(raw))
            artifacts = root / "artifacts"
            cmd = [sys.executable, str(SCRIPTS / "periodic_opt" / "train_ml_weekly.py"),
                   "--tickers", "EURUSD", "--dry-run", "--force", "--min-new-trades", "99999", "--models-dir", str(models),
                   "--evaluation-manifest", str(manifest), "--trades-file", str(snapshot),
                   "--output-dir", str(artifacts)]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            candidates = list(artifacts.rglob("ml_model_EURUSD.json"))
            proposals = list(artifacts.rglob("proposal_EURUSD.json"))
            self.assertEqual(len(candidates), 1)
            self.assertEqual(len(proposals), 1)
            proposal = json.loads(proposals[0].read_text())
            self.assertEqual(proposal["status"], "PROPOSE")
            self.assertFalse(proposal["promoted"])
            self.assertTrue(proposal["dry_run"])
            self.assertTrue(proposal["paired_validation"]["eligible"])
            self.assertEqual(proposal["paired_validation"]["n"], 24)
            self.assertEqual(active.read_bytes(), baseline)
            self.assertFalse((models / "ml_model.json").exists())
            self.assertIn("PROPOSE", result.stdout)
            # Exercise the real trainer subprocess and CLI promotion end-to-end,
            # still exclusively on this declared synthetic snapshot and temp models.
            cmd.remove("--dry-run")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual(active.read_bytes(), baseline, "default CLI must never auto-promote")
            cmd.append("--allow-promotion")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            promoted = json.loads(result.stdout.splitlines()[0])
            self.assertEqual(promoted["status"], "PROMOTED")
            self.assertTrue(promoted["promoted"])
            self.assertEqual(active.read_bytes(), Path(promoted["candidate_path"]).read_bytes())
            self.assertFalse((models / "ml_model.json").exists())


class PromotionGuardTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("xgboost"), "XGBoost unavailable")
    def test_inconsistent_paired_metrics_cannot_be_authorized_by_eligible_flag(self):
        data = fixture_dataset()
        old = legacy_model(data)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "ml_model_EURUSD.json"
            target.write_text(json.dumps(old))
            before = target.read_bytes()
            output = root / "candidate.json"
            candidate = trainer.train_candidate(data, output, "EURUSD", old, force=True, config={"ticker": "EURUSD"},
                                                 n_estimators=12, max_depth=2, learning_rate=.3)
            candidate["meta"]["paired_validation"]["new"]["accuracy"] = .9
            candidate["meta"]["validation_metrics"]["accuracy"] = .9
            output.write_text(json.dumps(candidate))
            with self.assertRaises(trainer.ProtocolError):
                weekly.promote_candidate(candidate_path=output, target=target, ticker="EURUSD", old_source=target,
                                         expected_artifact_sha256=trainer.digest(candidate), allow_promotion=True)
            self.assertEqual(target.read_bytes(), before)

    @unittest.skipUnless(importlib.util.find_spec("xgboost"), "XGBoost unavailable")
    def test_invalid_provenance_or_old_source_change_never_writes_models(self):
        import copy
        import hashlib
        from unittest import mock
        data = fixture_dataset()
        old = legacy_model(data)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "ml_model_EURUSD.json"
            target.write_text(json.dumps(old, indent=2))
            original = target.read_bytes()
            data["old_model_source"] = str(target)
            data["old_source_sha256"] = hashlib.sha256(original).hexdigest()
            output = root / "candidate.json"
            candidate = trainer.train_candidate(data, output, "EURUSD", old, force=True, config={"ticker": "EURUSD"},
                                                 n_estimators=12, max_depth=2, learning_rate=.3)
            kwargs = dict(candidate_path=output, target=target, ticker="EURUSD", old_source=target,
                          allow_promotion=True)
            mutations = [
                (("dataset_source_sha256",), "0"*64),
                (("dataset_provenance_sha256",), "0"*64),
                (("dataset_provenance", "manifest_sha256"), "0"*64),
                (("dataset_provenance", "validation_sha256"), "0"*64),
                (("dataset_sha256",), "invalid"),
                (("config", "ticker"), "GBPUSD"),
                (("model_sha256",), "0"*64),
                (("feature_schema", "names"), []),
                (("train_end_ms",), 201),
                (("available_at_ms",), 199),
                (("trained_at",), "not UTC"),
                (("refit_on_validation",), True),
                (("test_evaluated",), True),
                (("paired_validation", "old_artifact_sha256"), "0"*64),
                (("paired_validation", "eligible"), False),
                (("paired_validation", "validation_sha256"), "0"*64),
                (("paired_validation", "new", "accuracy"), -1),
                (("paired_validation", "class_counts", "WIN"), 0),
                (("old_source_sha256",), None),
            ]
            for path, value in mutations:
                with self.subTest(path=path):
                    target.write_bytes(original)
                    corrupt = copy.deepcopy(candidate)
                    node = corrupt["meta"]
                    for key in path[:-1]:
                        node = node[key]
                    node[path[-1]] = value
                    output.write_text(json.dumps(corrupt))
                    with self.assertRaises(trainer.ProtocolError):
                        weekly.promote_candidate(**kwargs, expected_artifact_sha256=trainer.digest(corrupt))
                    self.assertEqual(target.read_bytes(), original)
                    self.assertEqual(sorted(p.name for p in root.iterdir()), ["candidate.json", "ml_model_EURUSD.json"])
            output.write_text(json.dumps(candidate))
            kwargs["expected_artifact_sha256"] = trainer.digest(candidate)
            target.write_bytes(original + b"\n")
            with self.assertRaises(trainer.ProtocolError):
                weekly.promote_candidate(**kwargs)
            self.assertEqual(target.read_bytes(), original + b"\n")
            target.write_bytes(original)
            changed = copy.deepcopy(old)
            changed["meta"]["accuracy"] = .123
            target.write_text(json.dumps(changed))
            with self.assertRaises(trainer.ProtocolError):
                weekly.promote_candidate(**kwargs)
            self.assertEqual(json.loads(target.read_text()), changed)
            target.write_bytes(original)
            with mock.patch("os.replace", side_effect=OSError("declared replace failure")):
                with self.assertRaises(OSError):
                    weekly.promote_candidate(**kwargs)
            self.assertEqual(target.read_bytes(), original)
            # Stable coordination inode intentionally persists after a replace
            # failure; unlinking it could split concurrent writers into two locks.
            self.assertEqual(sorted(p.name for p in root.iterdir()),
                             [".ml_model_EURUSD.promotion.lock", "candidate.json", "ml_model_EURUSD.json"])
            with self.assertRaises(trainer.ProtocolError):
                weekly.promote_candidate(**dict(kwargs, expected_artifact_sha256="0"*64))
            self.assertEqual(target.read_bytes(), original)
            with mock.patch.object(trainer, "MODELS_DIR", root):
                with self.assertRaises(trainer.ProtocolError):
                    weekly.promote_candidate(**kwargs)
            self.assertEqual(target.read_bytes(), original)

    @unittest.skipUnless(importlib.util.find_spec("xgboost"), "XGBoost unavailable")
    def test_generic_source_is_read_only_and_only_dedicated_target_is_created(self):
        import hashlib
        data = fixture_dataset()
        old = legacy_model(data)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generic = root / "ml_model.json"
            generic.write_text(json.dumps(old))
            before = generic.read_bytes()
            data["old_model_source"] = str(generic)
            data["old_source_sha256"] = hashlib.sha256(before).hexdigest()
            output = root / "candidate.json"
            candidate = trainer.train_candidate(data, output, "EURUSD", old, force=True, config={"ticker": "EURUSD"},
                                                 n_estimators=12, max_depth=2, learning_rate=.3)
            kwargs = dict(candidate_path=output, ticker="EURUSD", old_source=generic,
                          expected_artifact_sha256=trainer.digest(candidate), allow_promotion=True)
            with self.assertRaises(trainer.ProtocolError):
                weekly.promote_candidate(**kwargs, target=generic)
            self.assertEqual(generic.read_bytes(), before)
            dedicated = root / "ml_model_EURUSD.json"
            self.assertEqual(weekly.promote_candidate(**kwargs, target=dedicated), "PROMOTED")
            self.assertEqual(dedicated.read_bytes(), output.read_bytes())
            self.assertEqual(generic.read_bytes(), before)
            with self.assertRaises(trainer.ProtocolError):
                weekly.promote_candidate(**kwargs, target=dedicated)
            self.assertEqual(generic.read_bytes(), before)

    @unittest.skipUnless(importlib.util.find_spec("xgboost"), "XGBoost unavailable")
    def test_promotion_requires_permission_and_verified_pair_and_keeps_exact_train_only_candidate(self):
        self.assertTrue(callable(getattr(weekly, "promote_candidate", None)), "missing explicit paired promotion guard")
        data = fixture_dataset()
        old = legacy_model(data)
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            target = directory / "ml_model_EURUSD.json"
            target.write_text(json.dumps(old))
            original = target.read_bytes()
            original_mode = target.stat().st_mode & 0o777
            output = directory / "candidate.json"
            candidate = trainer.train_candidate(data, output, "EURUSD", old, force=True, config={"ticker": "EURUSD"},
                                                 n_estimators=12, max_depth=2, learning_rate=.3)
            frozen = trainer.digest(candidate)
            kwargs = dict(candidate_path=output, target=target, ticker="EURUSD",
                          old_source=target, expected_artifact_sha256=frozen)
            self.assertEqual(weekly.promote_candidate(**kwargs), "PERMISSION_REQUIRED")
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(weekly.promote_candidate(**kwargs, allow_promotion=True, dry_run=True), "DRY_RUN")
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(weekly.promote_candidate(**kwargs, allow_promotion=True), "PROMOTED")
            self.assertEqual(target.read_bytes(), output.read_bytes())
            self.assertEqual(target.stat().st_mode & 0o777, original_mode)
            self.assertEqual(json.loads(target.read_text())["meta"]["train_samples"], 40)
            self.assertFalse(json.loads(target.read_text())["meta"]["refit_on_validation"])
            self.assertFalse((directory / "ml_model.json").exists())
            # A concurrent old-model change is a HOLD, never a blind overwrite.
            target.write_text(json.dumps(legacy_model(data, reverse=False)))
            changed = target.read_bytes()
            with self.assertRaises(trainer.ProtocolError):
                weekly.promote_candidate(**kwargs, allow_promotion=True)
            self.assertEqual(target.read_bytes(), changed)
            target.write_bytes(original)
            candidate["meta"]["max_label_closed_at_ms"]["train"] = 200
            output.write_text(json.dumps(candidate))
            kwargs["expected_artifact_sha256"] = trainer.digest(candidate)
            with self.assertRaises(trainer.ProtocolError):
                weekly.promote_candidate(**kwargs, allow_promotion=True)
            self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
