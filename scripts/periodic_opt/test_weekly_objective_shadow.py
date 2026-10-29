"""Diagnostic metadata cannot alter weekly selection/certification decisions."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/hyperopt'))
from test_objective_integration import payload
from objective_adapter import canonicalize_result
spec=importlib.util.spec_from_file_location('weekly_objective',Path(__file__).with_name('run_weekly.py'))
weekly=importlib.util.module_from_spec(spec); spec.loader.exec_module(weekly)

class WeeklyObjectiveTests(unittest.TestCase):
    def test_final_and_production_shadow_are_train_only_without_certification(self):
        result=canonicalize_result(payload())
        diag=weekly.objective_diagnostics(result,result)
        self.assertFalse(diag['changes_selection'])
        self.assertFalse(diag['final_pipeline_dsr_certified'])
        self.assertEqual(diag['production_train']['legacy_score'],.8)
        self.assertEqual(diag['candidate_train']['shadow']['version'],'risk_v2_shadow')
        self.assertEqual(diag['partition'],'train')
        json.dumps(diag,allow_nan=False)

    def test_validation_dsr_never_reuses_train_dispersion_as_a_certificate(self):
        result=weekly.run_dsr_gate('FIXTURE',[1,-.5]*20,400)
        self.assertTrue(result['skip'])
        self.assertEqual(result['calibration_status'],'missing')
        self.assertFalse(result['final_pipeline_dsr_certified'])
        self.assertEqual(result['partition'],'selection_validation')
        self.assertFalse(weekly.DSR_ENFORCE)
        self.assertFalse(weekly.AUTO_APPLY_ENABLED)

if __name__=='__main__':unittest.main()
