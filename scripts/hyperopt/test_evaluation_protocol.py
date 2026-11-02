import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


def protocol():
    spec = importlib.util.spec_from_file_location('evaluation_protocol', ROOT / 'evaluation_protocol.py')
    if not spec or not Path(spec.origin).exists():
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TemporalProtocolTests(unittest.TestCase):
    def test_default_is_elapsed_time_validation_not_independent_test(self):
        p = protocol()
        self.assertIsNotNone(p, 'missing temporal protocol implementation')
        m = p.generate_manifest('EURUSD', 1000, 2000)
        self.assertEqual(m, dict(version=1, ticker='EURUSD', from_ms=1000,
                                 train_end_ms=1700, validation_end_ms=2000,
                                 test_end_ms=2000, test_independence='unverified'))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'manifest.json'
            target.write_text(json.dumps(m))
            self.assertEqual(p.load_evaluation_manifest(target, 'EURUSD'), m)


if __name__ == '__main__':
    unittest.main()
