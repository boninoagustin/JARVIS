"""Freshness regressions on declared synthetic data, never production models."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "periodic_opt"))
import train_ml_model as trainer
import train_ml_weekly as weekly
from test_ml_temporal_protocol import MANIFEST, fixture_dataset, legacy_model, trade


class FreshnessGuardTests(unittest.TestCase):
    def test_identical_dataset_hash_is_not_fresh_even_with_zero_minimum(self):
        data = fixture_dataset()
        old = {"meta": {"train_end_ms": 100, "dataset_sha256": trainer.digest(
            dict(manifest=data["manifest"], train=data["train"], validation=data["validation"]))}}
        with self.assertRaisesRegex(trainer.InsufficientSamples, "FRESHNESS.*IDENTICAL"):
            trainer.guard_freshness(data, old, 0)
        self.assertTrue(trainer.guard_freshness(data, old, 99999, force=True)["forced"])

    def test_same_snapshot_bytes_at_new_path_is_not_fresh(self):
        data = fixture_dataset()
        data["dataset_source"] = {"path": "/new/trades.json", "snapshot_sha256": "a"*64}
        old = {"meta": {"train_end_ms": 100, "dataset_source": {
            "path": "/old/trades.json", "snapshot_sha256": "a"*64}}}
        with self.assertRaisesRegex(trainer.InsufficientSamples, "FRESHNESS.*IDENTICAL"):
            trainer.guard_freshness(data, old, 1)

    def test_shared_last_label_cutoff_counts_entries_and_closures_not_test(self):
        raw = {"train": [trade(100, 150), trade(160, 180)],
               "validation": [trade(200, 210), trade(210, 220), trade(220, 240),
                              trade(230, 300), trade(250, None)],
               "test": [trade(310, 320)] * 100}
        data = trainer.prepare_temporal_dataset(raw, MANIFEST, "EURUSD")
        old = {"meta": {"train_end_ms": 200,
                        "max_label_closed_at_ms": {"train": 179, "validation": 210}}}
        proof = trainer.guard_freshness(data, old, 1)
        self.assertEqual(proof["cutoff_ms"], 210)
        self.assertEqual(proof["new_trades_by_partition"], {"train": 0, "validation": 1})
        self.assertEqual(proof["new_trades"], 1)

    def test_same_worker_bytes_ignores_changed_paths_mtimes_and_manifest(self):
        data = fixture_dataset()
        data["dataset_source"] = {"worker_provenance": {"dataset_files": [
            {"path": "/new/M5.csv", "mtime_ms": 999999, "sha256": "a"*64}]}}
        old = {"meta": {"train_end_ms": 100, "dataset_source": {"worker_provenance": {
            "dataset_files": [{"path": "/old/M5.csv", "mtime_ms": 1, "sha256": "a"*64}]}}}}
        with self.assertRaisesRegex(trainer.InsufficientSamples, "FRESHNESS.*IDENTICAL"):
            trainer.guard_freshness(data, old, 1)

    def test_legacy_wall_clock_is_not_evidence_of_training_range(self):
        for old in (None, {"meta": {}}, {"meta": {"trained_at": "1970-01-01T00:00:00Z"}}):
            with self.subTest(old=old):
                with self.assertRaisesRegex(trainer.InsufficientSamples, "HOLD_FRESHNESS_UNKNOWN"):
                    trainer.guard_freshness(fixture_dataset(), old, 0)
                proof = trainer.guard_freshness(fixture_dataset(), old, 99999, force=True)
                self.assertTrue(proof["forced"])
                self.assertIsNone(proof["new_trades"])


class FreshnessIntegrationTests(unittest.TestCase):
    def test_promotion_rejects_identical_dataset_without_explicit_force_proof(self):
        data = fixture_dataset()
        old = legacy_model(data)
        old["meta"].update(train_end_ms=100, dataset_sha256=trainer.digest(
            dict(manifest=data["manifest"], train=data["train"], validation=data["validation"])))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "ml_model_EURUSD.json"
            active.write_text(json.dumps(old))
            before = active.read_bytes()
            output = root / "candidate.json"
            candidate = trainer.train_candidate(data, output, "EURUSD", old, {"ticker": "EURUSD"},
                                                force=True, n_estimators=12)
            candidate["meta"]["freshness"].update(forced=False, identical_dataset=False, minimum=0)
            output.write_text(json.dumps(candidate))
            with self.assertRaisesRegex(trainer.ProtocolError, "freshness"):
                weekly.promote_candidate(candidate_path=output, target=active, ticker="EURUSD",
                    old_source=active, expected_artifact_sha256=trainer.digest(candidate), allow_promotion=True)
            self.assertEqual(active.read_bytes(), before)

    def test_weekly_high_minimum_holds_before_xgboost_even_with_permission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            models = root / "models"
            models.mkdir()
            old = legacy_model(fixture_dataset())
            old["meta"].update(train_end_ms=100, max_label_closed_at_ms={"train": 99})
            active = models / "ml_model_EURUSD.json"
            active.write_text(json.dumps(old))
            before = active.read_bytes()
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(MANIFEST))
            raw = {"provenance": "declared_synthetic_fixture"}
            for partition, start, count in [("train", 100, 40), ("validation", 200, 24)]:
                raw[partition] = [trade(start+i*2, start+i*2+1, "WIN" if i % 2 else "LOSS",
                                        1 if i % 2 else -1) for i in range(count)]
            snapshot = root / "trades.json"
            snapshot.write_text(json.dumps(raw))
            args = ["--tickers", "EURUSD", "--models-dir", str(models),
                    "--evaluation-manifest", str(manifest), "--trades-file", str(snapshot),
                    "--output-dir", str(root / "artifacts"), "--min-new-trades", "99999",
                    "--allow-promotion"]
            # Run the real trainer in-process to spy on actual XGBoost fit.
            def in_process(command, **kwargs):
                import subprocess
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    code = trainer.main(command[2:])
                return subprocess.CompletedProcess(command, code, stdout.getvalue(), stderr.getvalue())
            import xgboost
            with mock.patch.object(weekly.subprocess, "run", side_effect=in_process), \
                    mock.patch.object(xgboost.XGBClassifier, "fit", side_effect=AssertionError("freshness HOLD must precede XGBoost fit")) as fit, \
                    contextlib.redirect_stdout(io.StringIO()):
                code = weekly.main(args)
                self.assertFalse(fit.called, "freshness HOLD must precede XGBoost fit")
            self.assertEqual(code, 2)
            proposals = list((root / "artifacts").rglob("proposal_EURUSD.json"))
            proposal = json.loads(proposals[0].read_text())
            self.assertEqual(proposal["status"], "HOLD")
            self.assertIn("FRESHNESS", proposal["reason"])
            self.assertFalse(proposal["promoted"])
            self.assertFalse(list((root / "artifacts").rglob("ml_model_EURUSD.json")))
            self.assertEqual(hashlib.sha256(active.read_bytes()).hexdigest(), hashlib.sha256(before).hexdigest())
            # Actual subprocess: known genuinely later labels satisfy the minimum.
            args[args.index("99999")] = "15"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(weekly.main(args), 0)
            promoted = active.read_bytes()
            self.assertNotEqual(promoted, before)
            self.assertEqual(json.loads(promoted)["meta"]["freshness"]["new_trades"], 64)
            self.assertFalse(json.loads(promoted)["meta"]["freshness"]["forced"])
            # Re-reading identical bytes is not new data, even at minimum zero.
            args[args.index("15")] = "0"
            with mock.patch.object(weekly.subprocess, "run", side_effect=in_process), \
                    mock.patch.object(xgboost.XGBClassifier, "fit", side_effect=AssertionError("same bytes must not train")), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(weekly.main(args), 2)
            self.assertEqual(active.read_bytes(), promoted)


if __name__ == "__main__":
    unittest.main()
