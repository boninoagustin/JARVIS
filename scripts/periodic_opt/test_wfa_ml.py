"""Fold ML tests exercise the actual temporal trainer, never random splitting."""
import importlib
import json
from pathlib import Path
import tempfile
import unittest


def module():
    return importlib.import_module('scripts.periodic_opt.wfa_ml')


class FoldMLTest(unittest.TestCase):
    def test_explicit_validation_start_rejects_embargo_rows(self):
        ml = module()
        fold = dict(id=1, is_start_ms=100, inner_train_end_ms=1000,
                    inner_validation_start_ms=1200, is_end_ms=2000, fit_asof_ms=2000)
        with self.assertRaisesRegex(ValueError, 'validation.*window'):
            ml.prepare_fold_dataset(ticker='TEST', fold=fold, plan_fingerprint='p',
                                    inner_train=[], inner_validation=[dict(timestamp=1100)])
        data = ml.prepare_fold_dataset(ticker='TEST', fold=fold, plan_fingerprint='p',
                                       inner_train=[], inner_validation=[])
        self.assertEqual(data['embargo_ms'], 200)
        self.assertFalse(data['test_evaluated'])

    def test_real_candidate_preserves_wallclock_and_hashes_augmented_bytes(self):
        import hashlib
        from scripts import train_ml_model as trainer
        ml = module()
        fold = dict(id=1, is_start_ms=100, inner_train_end_ms=1000,
                    inner_validation_start_ms=1200, is_end_ms=2000, fit_asof_ms=2000)
        def rows(start):
            return [dict(timestamp=start+i*2, closedAt=start+i*2+1,
                         result='WIN' if i%2 else 'LOSS', rMultiple=1 if i%2 else -1,
                         mlFeatures={f:float(i%2) for f in trainer.FEATURE_NAMES}) for i in range(24)]
        with tempfile.TemporaryDirectory() as tmp:
            result = ml.train_fold_candidate(ticker='TEST', fold=fold, plan_fingerprint='p',
                inner_train=rows(100), inner_validation=rows(1200), config={'ticker':'TEST'},
                output_path=Path(tmp)/'candidate.json', old_model=None)
            artifact = json.loads((Path(tmp)/'candidate.json').read_text())
            meta = artifact['meta']
            self.assertGreater(meta['available_at_ms'], fold['is_end_ms'])
            self.assertEqual(meta['wfa_reconstruction']['fit_asof_ms'], 2000)
            self.assertEqual(result['replay_model']['model_sha256'], hashlib.sha256((Path(tmp)/'candidate.json').read_bytes()).hexdigest())
            self.assertFalse(result['paired_eligible'])
            self.assertEqual(result['status'], 'HOLD_BASELINE_MODEL_UNKNOWN')
            # An old model available only after internal Validation started is
            # not a legitimate paired pre-validation baseline, even before IS end.
            old = json.loads(json.dumps(artifact))
            old['meta'].update(train_end_ms=1500,available_at_ms=1500)
            late = ml.train_fold_candidate(ticker='TEST',fold=fold,plan_fingerprint='p',
                inner_train=rows(100),inner_validation=rows(1200),config={'ticker':'TEST'},
                output_path=Path(tmp)/'late-baseline.json',old_model=old)
            self.assertFalse(late['paired_eligible'],'model trained on internal validation must not qualify')
            hold = ml.train_fold_candidate(ticker='TEST', fold=fold, plan_fingerprint='p',
                inner_train=[], inner_validation=[], config={}, output_path=Path(tmp)/'empty.json', old_model=None)
            self.assertEqual(hold['status'], 'HOLD_ML_SAMPLES')
            self.assertFalse((Path(tmp)/'empty.json').exists())


if __name__ == '__main__':
    unittest.main()
