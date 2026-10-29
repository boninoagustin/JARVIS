"""Declared synthetic fixtures only; these tests do not claim market performance."""
import importlib.util
from pathlib import Path
import sys
import unittest
import json
import tempfile
import numpy as np
import subprocess
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import train_ml_model as trainer


MANIFEST = dict(version=1, ticker="EURUSD", from_ms=100, train_end_ms=200,
                validation_end_ms=300, test_end_ms=400, test_independence="unverified")


def trade(ts, close, result="WIN", value=1.0):
    return dict(timestamp=ts, closedAt=close, result=result, rMultiple=1 if result == "WIN" else -1,
                mlFeatures={name: value for name in trainer.FEATURE_NAMES})


class TemporalDatasetTests(unittest.TestCase):
    def test_system_python_entrypoints_resolve_project_dependencies(self):
        for entry in (ROOT / 'train_ml_model.py', ROOT / 'periodic_opt/train_ml_weekly.py'):
            result = subprocess.run(['/usr/bin/python3', str(entry), '--help'],
                                    capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('--evaluation-manifest', result.stdout)

    def test_real_worker_timesfm_cache_has_same_context_in_both_windows(self):
        # Declared PING-only fixture: verifies real RPC/cache plumbing, not PnL.
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / 'M5.csv').write_text(''.join(
                f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {ts}\n'
                for ts in (100, 120, 199, 200, 210, 299)))
            cache = directory / 'cache.jsonl'
            cache.write_text('')
            manifest = dict(MANIFEST, ticker='FIXTURE', test_end_ms=300)
            config = trainer.default_config('FIXTURE')
            config['timesfm'] = dict(enabled=True, cachePath=str(cache))
            result = trainer.collect_temporal_trades(directory, 'FIXTURE', config, manifest)
            context = result['dataset_source']
            self.assertEqual(context['worker_provenance']['cache_files'][0]['path'], str(cache))
            self.assertEqual(set(context['partitions']), {'train', 'validation'})
            self.assertEqual(result['counts']['train']['accepted'], 0)

    def test_half_open_windows_purge_overlap_and_never_label_timeout(self):
        self.assertTrue(callable(getattr(trainer, "prepare_temporal_dataset", None)),
                        "missing temporal dataset API; random split must be replaced")
        raw = {"train": [trade(100, 199), trade(199, 200), trade(150, 175, "TIMEOUT"),
                         trade(160, None, None)],
               "validation": [trade(200, 299, "LOSS"), trade(250, 300)],
               "test": [trade(300, 399)]}
        data = trainer.prepare_temporal_dataset(raw, MANIFEST, "EURUSD")
        self.assertEqual([t["ts"] for t in data["train"]], [100])
        self.assertEqual([t["ts"] for t in data["validation"]], [200])
        self.assertEqual(data["counts"]["train"]["purged_overlap"], 1)
        self.assertEqual(data["counts"]["train"]["excluded_unlabelled"], 2)
        self.assertEqual(data["counts"]["validation"]["purged_overlap"], 1)
        self.assertEqual(data["max_label_closed_at_ms"]["train"], 199)
        self.assertFalse(data["test_evaluated"])


def fixture_dataset():
    raw = {"train": [], "validation": []}
    for partition, start, count in [("train", 100, 40), ("validation", 200, 24)]:
        for i in range(count):
            raw[partition].append(trade(start+i*2, start+i*2+1,
                                        "WIN" if i % 2 else "LOSS", 1.0 if i % 2 else -1.0))
    return trainer.prepare_temporal_dataset(raw, MANIFEST, "EURUSD")


def legacy_model(data, reverse=True):
    import xgboost as xgb
    rows = data["train"]
    X = np.array([[r[f] for f in trainer.FEATURE_NAMES] for r in rows], dtype=np.float32)
    y = np.array([1-r["label"] if reverse else r["label"] for r in rows])
    model = xgb.XGBClassifier(n_estimators=12, max_depth=2, learning_rate=.3,
                             base_score=.5, n_jobs=1, random_state=42)
    model.fit(X, y)
    return dict(features=trainer.FEATURE_NAMES,
                meta=dict(feature_names=trainer.FEATURE_NAMES, threshold=.65, accuracy=1.0),
                xgboost_model=json.loads(model.get_booster().save_raw(raw_format="json")))


@unittest.skipUnless(importlib.util.find_spec("xgboost"), "XGBoost unavailable")
class TrainingTests(unittest.TestCase):
    def test_candidate_loads_in_real_typescript_runtime_and_matches_native_at_split(self):
        data = fixture_dataset()
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            output = directory / "candidate.json"
            candidate = trainer.train_candidate(data, output, "EURUSD", legacy_model(data),
                                                 force=True, config={"ticker": "EURUSD"}, n_estimators=12, max_depth=2,
                                                 learning_rate=.3)
            trees, _ = trainer.validate_export(candidate)
            self.assertEqual(trees[0]["split_indices"][0], 0)
            split = trees[0]["split_conditions"][0]
            ts = directory / "parity.ts"
            ts.write_text("import {readFileSync} from 'node:fs';\n"
                + "import {loadModelFromJSON,predict} from "
                + json.dumps(str(ROOT.parent / "src/engine/MLFilter.ts")) + ";\n"
                + "const model=JSON.parse(readFileSync(process.argv[2],'utf8'));\n"
                + "if (!loadModelFromJSON(model,'EURUSD')) throw new Error('candidate runtime load failed');\n"
                + "const rows=" + json.dumps([-1, split, 1]) + ";\n"
                + "const result=rows.map(z=>predict({zUp:z,zDn:0} as any,'BUY',0,0,0,'5','EURUSD',{auditOnly:true}));\n"
                + "console.log(JSON.stringify(result));\n")
            command = [str(ROOT.parent / "node_modules/.bin/tsx"), str(ts), str(output)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            predictions = json.loads(result.stdout.splitlines()[-1])
            X = np.array([r["features"] for r in predictions])
            expected = trainer.predict_export(candidate, X)
            np.testing.assert_allclose([r["probability"] for r in predictions], expected, atol=1e-12)
            import xgboost as xgb
            booster = xgb.Booster()
            booster.load_model(bytearray(json.dumps(candidate["xgboost_model"]), "utf-8"))
            np.testing.assert_allclose(expected, booster.predict(xgb.DMatrix(X)), rtol=1e-6, atol=1e-7)
            self.assertEqual(expected[1], expected[2], 'split equality must take the right branch, not <= left')
            self.assertNotEqual(expected[0], expected[1])
            self.assertIsInstance(trees, list)
            # Legacy runtime starts at zero margin regardless of serialized
            # base_score type. Only new base_score=.5 candidates claim native parity.
            for base_score in (.9, "9E-1", "[9E-1]", [.9]):
                with self.subTest(base_score=base_score):
                    candidate["xgboost_model"]["learner"]["learner_model_param"]["base_score"] = base_score
                    output.write_text(json.dumps(candidate))
                    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    probabilities = [r["probability"] for r in json.loads(result.stdout.splitlines()[-1])]
                    np.testing.assert_allclose(trainer.predict_export(candidate, X), expected, atol=1e-12)
                    np.testing.assert_allclose(probabilities, expected, atol=1e-12)

    def test_candidate_binds_full_old_artifact_and_effective_dataset_provenance(self):
        data = fixture_dataset()
        old = legacy_model(data)
        effective = dict(ticker="EURUSD", mlGate={"enabled": False})
        data["effective_config"] = effective
        data["dataset_source"] = {"provenance": "declared_synthetic_fixture"}
        with tempfile.TemporaryDirectory() as directory:
            old_path = Path(directory) / "ml_model_EURUSD.json"
            old_path.write_text(json.dumps(old, indent=2))
            data["old_model_source"] = str(old_path)
            import hashlib
            source_hash = hashlib.sha256(old_path.read_bytes()).hexdigest()
            data["old_source_sha256"] = source_hash
            candidate = trainer.train_candidate(data, Path(directory) / "candidate.json", "EURUSD", old,
                                                 force=True, config={"ticker": "EURUSD"}, n_estimators=2, max_depth=1)
            meta = candidate["meta"]
            self.assertEqual(meta["paired_validation"].get("old_artifact_sha256"), trainer.digest(old))
            self.assertEqual(meta.get("old_source_sha256"), source_hash)
            self.assertEqual(meta["config"], effective)
            self.assertEqual(meta.get("dataset_source_sha256"), trainer.digest(data["dataset_source"]))
            proof = meta.get("dataset_provenance")
            self.assertIsInstance(proof, dict)
            self.assertEqual(proof["manifest_sha256"], trainer.digest(MANIFEST))
            self.assertEqual(proof["train_sha256"], trainer.digest(data["train"]))
            self.assertEqual(proof["validation_sha256"], meta["validation_sha256"])
            self.assertEqual(meta["dataset_provenance_sha256"], trainer.digest(proof))

    def test_real_xgboost_candidate_pairs_same_validation_and_records_utc_provenance(self):
        self.assertTrue(callable(getattr(trainer, "train_candidate", None)),
                        "missing Train-only candidate + paired Validation API")
        data = fixture_dataset()
        old = legacy_model(data)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "candidate.json"
            candidate = trainer.train_candidate(data, output, "EURUSD", old,
                                                 force=True, config={"ticker": "EURUSD"},
                                                 n_estimators=12, max_depth=2, learning_rate=.3)
            self.assertTrue(output.exists())
            meta = candidate["meta"]
            paired = meta["paired_validation"]
            self.assertEqual(paired["n"], 24)
            self.assertEqual(paired["class_counts"], {"LOSS": 12, "WIN": 12})
            self.assertLess(paired["old"]["accuracy"], paired["new"]["accuracy"])
            self.assertTrue(paired["eligible"])
            self.assertEqual(paired["old_provenance"], "legacy_unverified")
            self.assertEqual(meta["train_samples"], 40)
            self.assertEqual(meta["train_end_ms"], 200)
            self.assertEqual(meta["max_label_closed_at_ms"]["train"], 179)
            self.assertGreater(meta["available_at_ms"], meta["train_end_ms"])
            self.assertTrue(meta["trained_at"].endswith("Z"))
            self.assertFalse(meta["test_independence_verified"])
            self.assertEqual(meta["embargo_ms"], 0)
            self.assertEqual(len(meta["model_sha256"]), 64)
            self.assertEqual(len(meta["dataset_sha256"]), 64)
            X = np.array([[r[f] for f in trainer.FEATURE_NAMES] for r in data["validation"]], dtype=np.float32)
            import xgboost as xgb
            booster = xgb.Booster()
            booster.load_model(bytearray(json.dumps(candidate["xgboost_model"]), "utf-8"))
            np.testing.assert_allclose(trainer.predict_export(candidate, X),
                                       booster.predict(xgb.DMatrix(X)), rtol=1e-6, atol=1e-7)


class CandidateCLITests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("xgboost"), "XGBoost unavailable")
    def test_cli_dry_run_writes_candidate_not_default_and_hold_has_explicit_exit(self):
        self.assertTrue(callable(getattr(trainer, "main", None)), "missing safe candidate CLI")
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            manifest = directory / "manifest.json"
            manifest.write_text(json.dumps(MANIFEST))
            raw = {"provenance": "declared_synthetic_fixture", "train": [], "validation": []}
            for partition, start, count in [("train", 100, 40), ("validation", 200, 24)]:
                raw[partition] = [trade(start+i*2, start+i*2+1, "WIN" if i % 2 else "LOSS",
                                        1.0 if i % 2 else -1.0) for i in range(count)]
            trades_file = directory / "trades.json"
            trades_file.write_text(json.dumps(raw))
            old = directory / "old.json"
            old.write_text(json.dumps(legacy_model(fixture_dataset())))
            baseline = old.read_bytes()
            output = directory / "candidate.json"
            cmd = [sys.executable, str(ROOT / "train_ml_model.py"), "EURUSD", "--dry-run", "--force",
                   "--evaluation-manifest", str(manifest), "--trades-file", str(trades_file),
                   "--current-model", str(old), "--output", str(output), "--n-estimators", "12"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.exists())
            self.assertFalse((directory / "ml_model.json").exists())
            self.assertEqual(old.read_bytes(), baseline)
            exported = json.loads(output.read_text())
            self.assertEqual(exported["meta"]["dataset_source"]["provenance"], "declared_synthetic_fixture")
            import hashlib
            self.assertEqual(exported["meta"].get("old_source_sha256"), hashlib.sha256(baseline).hexdigest())
            raw["train"] = raw["train"][:2]
            trades_file.write_text(json.dumps(raw))
            cmd[cmd.index(str(output))] = str(directory / "insufficient.json")
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("HOLD", result.stdout)
            self.assertFalse((directory / "insufficient.json").exists())

    def test_real_worker_collects_declared_tiny_event_fixture_without_training_or_test_access(self):
        base = 1_770_000_000_000
        manifest = dict(version=1, ticker="EURUSD", from_ms=base, train_end_ms=base+700,
                        validation_end_ms=base+1000, test_end_ms=base+1200, test_independence="unverified")
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            source = directory / "M5.csv"
            source.write_text(''.join(f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {base+delta}\n'
                                     for delta in (0, 1, 699, 700, 999, 1000, 1199)))
            data = trainer.collect_temporal_trades(directory, "EURUSD", trainer.default_config("EURUSD"),
                                                   evaluation_manifest=manifest)
            self.assertEqual(data["train"], [])
            self.assertEqual(data["validation"], [])
            self.assertFalse(data["test_evaluated"])
            self.assertEqual(data["effective_config"]["mlGate"], {"enabled": False})
            provenance = data["dataset_source"]
            self.assertEqual(provenance["provenance"], "worker_temporal_rpc")
            self.assertEqual(set(provenance["partitions"]), {"train", "validation"})
            files = provenance["worker_provenance"]["dataset_files"]
            self.assertEqual(files[0]["path"], str(source))
            import hashlib
            self.assertEqual(files[0]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(len(provenance["worker_dataset_fingerprint"]), 64)

    def test_real_worker_contract_disables_gate_and_preserves_temporal_provenance(self):
        calls = []
        provenance = {"version": 1, "evaluation_manifest": MANIFEST,
                      "dataset_files": [{"path": "/declared-fixture/events.csv", "sha256": "a"*64}]}
        fingerprint = "b"*64
        config = trainer.default_config("EURUSD")
        effective = dict(config, mlGate={"enabled": False})
        def rpc(method, params):
            calls.append((method, params))
            if method == "shutdown":
                return {}
            context = dict(evaluation_manifest=MANIFEST, evaluation_fingerprint=fingerprint,
                           provenance=provenance)
            if method == "init":
                return context
            partition = params["partition"]
            start, end = (100, 200) if partition == "train" else (200, 300)
            row = trade(start, end-1, "WIN" if partition == "train" else "LOSS")
            row.update(label_status="closed", closeTimestamp=end-1, closeTs=end-1)
            return dict(context, effective_config=effective, config_fingerprint="c"*64,
                        ml_provenance={"enabled": False}, trades=[row], trade_count=1,
                        dataset_meta=dict(partition=partition, from_ms=start, to_ms=end,
                                          evaluation_manifest=MANIFEST, evaluation_fingerprint=fingerprint,
                                          dataset_files=provenance["dataset_files"], terminal_close_policy="censored"))
        data = trainer.collect_temporal_trades(Path("/declared-fixture"), "EURUSD", config, rpc=rpc)
        for method, params in calls:
            if method == "collect_trades":
                self.assertEqual(params["config"]["mlGate"], {"enabled": False})
        source = data["dataset_source"]
        self.assertEqual(source["worker_dataset_fingerprint"], fingerprint)
        self.assertEqual(source["worker_provenance"], provenance)
        self.assertEqual(source["partitions"]["train"]["dataset_meta"]["to_ms"], 200)
        self.assertEqual(data["effective_config"], effective)
        self.assertEqual(data["max_label_closed_at_ms"], {"train": 199, "validation": 299})
        def drifting(method, params):
            response = rpc(method, params)
            if method == "collect_trades" and params["partition"] == "validation":
                response["evaluation_fingerprint"] = "d"*64
            return response
        with self.assertRaises(trainer.ProtocolError):
            trainer.collect_temporal_trades(Path("/declared-fixture"), "EURUSD", config, rpc=drifting)

    def test_worker_collection_requests_only_train_and_validation_and_uses_declared_manifest(self):
        self.assertTrue(callable(getattr(trainer, "collect_temporal_trades", None)), "missing manifest-aware RPC")
        calls = []
        def rpc(method, params):
            calls.append((method, params))
            if method == "init":
                return {"evaluation_manifest": MANIFEST, "dataset_fingerprint": "fixture-hash"}
            if method == "shutdown":
                return {}
            return {"trades": [trade(100, 199) if params["partition"] == "train" else trade(200, 299, "LOSS")]}
        data = trainer.collect_temporal_trades(Path("/declared-fixture"), "EURUSD", {"ticker": "EURUSD"},
                                               evaluation_manifest=MANIFEST, rpc=rpc)
        self.assertEqual(calls[0][1]["evaluation_manifest"], MANIFEST)
        self.assertEqual([p["partition"] for method,p in calls if method == "collect_trades"], ["train", "validation"])
        self.assertEqual(data["manifest"], MANIFEST)
        self.assertEqual(data["dataset_source"]["worker_dataset_fingerprint"], "fixture-hash")
        def legacy_rpc(method, params):
            return {"oos_split": {"train": 10, "test": 5}}
        with self.assertRaises(trainer.ProtocolError):
            trainer.collect_temporal_trades(Path("/declared-fixture"), "EURUSD", {}, rpc=legacy_rpc)


if __name__ == "__main__":
    unittest.main()
