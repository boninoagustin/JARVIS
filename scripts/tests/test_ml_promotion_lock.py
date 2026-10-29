"""Promotion locking regressions: real Linux processes, only temporary models."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "periodic_opt"))
import train_ml_model as trainer
import train_ml_weekly as weekly
from test_ml_temporal_protocol import fixture_dataset, legacy_model


CHILD = r'''
import fcntl, json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
sys.path.insert(0, str(Path(sys.argv[1]) / "periodic_opt"))
import train_ml_model as trainer
import train_ml_weekly as weekly
kwargs = json.loads(sys.argv[2])
for name in ("candidate_path", "target", "old_source"):
    kwargs[name] = Path(kwargs[name])
real_flock = fcntl.flock
held_lock = sys.argv[3]
def observe_flock(fd, operation):
    if operation == fcntl.LOCK_EX and os.readlink(f"/proc/self/fd/{fd}") == held_lock:
        print("WAITING_ON_SHARED_LOCK", flush=True)
    return real_flock(fd, operation)
fcntl.flock = observe_flock
try:
    result = dict(status=weekly.promote_candidate(**kwargs))
except trainer.ProtocolError as exc:
    result = dict(status="REJECTED", reason=str(exc))
print(json.dumps(result), flush=True)
'''


class PromotionLockTests(unittest.TestCase):
    def make_candidate(self, root, old_name="ml_model_EURUSD.json"):
        data = fixture_dataset()
        old = legacy_model(data)
        source = root / old_name
        source.write_text(json.dumps(old))
        source.chmod(0o640)
        data["old_model_source"] = str(source)
        data["old_source_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
        candidate_path = root / "candidate.json"
        candidate = trainer.train_candidate(data, candidate_path, "EURUSD", old,
            force=True, config={"ticker": "EURUSD"}, n_estimators=12,
            max_depth=2, learning_rate=.3)
        return dict(candidate_path=candidate_path, target=root / "ml_model_EURUSD.json",
                    ticker="EURUSD", old_source=source,
                    expected_artifact_sha256=trainer.digest(candidate), allow_promotion=True)

    def test_real_process_waits_for_writer_then_rejects_changed_source_hash(self):
        # Fallback requires BOTH the generic source and dedicated target locks.
        for old_name, lock_name in [
            ("ml_model_EURUSD.json", ".ml_model_EURUSD.promotion.lock"),
            ("ml_model.json", ".ml_model.promotion.lock"),
            ("ml_model.json", ".ml_model_EURUSD.promotion.lock"),
        ]:
            with self.subTest(old_name=old_name, held_lock=lock_name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                kwargs = self.make_candidate(root, old_name)
                source, target = kwargs["old_source"], kwargs["target"]
                lock_path = root / lock_name
                # A real cooperating writer owns the dedicated stable lock inode.
                with lock_path.open("a+b") as writer_lock:
                    fcntl.flock(writer_lock.fileno(), fcntl.LOCK_EX)
                    child = subprocess.Popen([sys.executable, "-u", "-c", CHILD, str(SCRIPTS),
                        json.dumps({k: str(v) if isinstance(v, Path) else v for k, v in kwargs.items()}),
                        str(lock_path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    try:
                        marker = child.stdout.readline().strip()
                        self.assertEqual(marker, "WAITING_ON_SHARED_LOCK",
                            "promotion never acquired the cooperating writer's lock: " + marker)
                        with self.assertRaises(subprocess.TimeoutExpired):
                            child.wait(timeout=.25)
                        changed = json.loads(source.read_bytes())
                        changed["meta"]["accuracy"] = .123
                        replacement = root / "writer-staged.json"
                        replacement.write_text(json.dumps(changed))
                        os.replace(replacement, source)
                        concurrent_bytes = source.read_bytes()
                        fcntl.flock(writer_lock.fileno(), fcntl.LOCK_UN)
                        stdout, stderr = child.communicate(timeout=15)
                        self.assertEqual(child.returncode, 0, stderr)
                        result = json.loads(stdout.splitlines()[-1])
                        self.assertEqual(result["status"], "REJECTED", result)
                        self.assertIn("old source bytes changed", result["reason"])
                        self.assertEqual(source.read_bytes(), concurrent_bytes)
                        if source != target:
                            self.assertFalse(target.exists())
                    finally:
                        fcntl.flock(writer_lock.fileno(), fcntl.LOCK_UN)
                        if child.poll() is None:
                            child.kill()
                        child.communicate(timeout=15)


if __name__ == "__main__":
    unittest.main()
