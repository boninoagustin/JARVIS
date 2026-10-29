import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('weekly_b', Path(__file__).with_name('run_weekly.py'))
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)

class BlockerTests(unittest.TestCase):
    def test_roi_tables_replace_including_root_off(self):
        prod = {'minimal_roi': {'0': .015, '30': .005, '60': 0}, 'sessions': {'NY': {'choch5m': {'minimal_roi': {'0': .02, '90': 0}}}}}
        off = w.assemble_candidate(prod, {'best_config': {'minimal_roi': {}}})
        self.assertEqual(off['minimal_roi'], {})
        preset = w.assemble_candidate(prod, {'best_config': {'minimal_roi': {'0': .01}}, 'session_apply': {'NY': {'choch5m': {'minimal_roi': {'0': .03}}}}})
        self.assertEqual(preset['minimal_roi'], {'0': .01})
        self.assertEqual(preset['sessions']['NY']['choch5m']['minimal_roi'], {'0': .03})

if __name__ == '__main__': unittest.main()
