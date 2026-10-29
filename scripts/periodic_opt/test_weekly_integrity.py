"""Offline behavioral contracts: no broker, Firestore or large backtests."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('weekly', Path(__file__).with_name('run_weekly.py'))
weekly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weekly)

class WeeklyIntegrityTests(unittest.TestCase):
    def test_final_evaluation_receives_complete_candidate(self):
        production = {'ticker': 'EURUSD', 'sessions': {'NY': {'choch5m': {'minScore': 4}, 'maxBuyLosses': 1}}, 'timesfm': {'enabled': True}, 'vwapPts': 2}
        report = {'best_config': {'vwapPts': 3}, 'session_apply': {'NY': {'choch5m': {'minScore': 6}}}, 'timesfm_apply': {'minScoreToOverrideReject': 7, 'source': 'proposal'}, 'ks_proposal': {'maxDailyLossR': 2, 'score': 8}, 'directional_mcl': {'updates': {'sessions.NY.maxBuyLosses': 2}}, 'bias_confluence': {'status': 'RECOMMEND', 'recommended': {'bc': {'fullPts': 5}}}, 'loser_triggers': {'disables': [{'session': 'NY', 'trigger': 'bos5m'}]}}
        candidate = weekly.assemble_candidate(production, report)
        self.assertEqual(candidate['sessions']['NY']['choch5m']['minScore'], 6)
        self.assertEqual(candidate['sessions']['NY']['maxBuyLosses'], 2)
        self.assertEqual(candidate['sessions']['NY']['bos5m']['minScore'], 99)
        self.assertEqual(candidate['timesfm']['minScoreToOverrideReject'], 7)
        self.assertEqual(candidate['biasConfluence'], {'fullPts': 5})
        self.assertEqual(candidate['maxDailyLossR'], 2)
        self.assertEqual(production['sessions']['NY']['choch5m']['minScore'], 4)
        self.assertNotIn('source', candidate['timesfm'])
        self.assertNotIn('score', candidate)

    def test_complete_tune_replacement_preserves_roi_deletion_and_live_strategy(self):
        production = {'ticker':'EURUSD', 'entryTrigger':'OTE', 'sessions':{'NY':{'choch5m':{'minScore':5, 'minimal_roi':{'0':0.2}}, 'choch15m':{'enabled':False, 'minScore':99}}}}
        report = {'best_config':{'entryTrigger':'SMART', 'entryStrategy':'SMART', 'minRR':1}, 'session_apply_replace':True, 'session_apply':{'NY':{'choch5m':{'minScore':8}, 'choch15m':{'enabled':False, 'minScore':99}}}, 'loser_triggers':{'enables':[{'session':'LONDON','trigger':'bos5m'}]}}
        candidate = weekly.assemble_candidate(production, report)
        self.assertNotIn('minimal_roi', candidate['sessions']['NY']['choch5m'])
        self.assertFalse(candidate['sessions']['NY']['choch15m']['enabled'])
        self.assertEqual(candidate['sessions']['LONDON']['bos5m'], {'minScore':4, 'enabled':True})
        self.assertEqual(candidate['entryTrigger'], 'OTE')
        asset = weekly.assemble_asset_snapshot({'entryStrategy':'BOTH', 'minRR':9, 'sessions':production['sessions']}, production, candidate)
        self.assertEqual(asset['entryStrategy'], 'BOTH')
        self.assertEqual(asset['minRR'], 9)
        self.assertNotIn('minimal_roi', asset['sessions']['NY']['choch5m'])

    def manifest(self):
        return dict(version=1, ticker='EURUSD', from_ms=100, train_end_ms=200, validation_end_ms=300, test_end_ms=300, test_independence='unverified')

    def test_mc_uses_final_candidate_not_production_and_mutation_holds(self):
        manifest = self.manifest()
        production = {'ticker': 'EURUSD', 'sessions': {}}
        provenance = {'evaluation_manifest':manifest, 'dataset_files':[]}
        evaluation_fp = weekly.json_fingerprint(provenance)
        report = {'best_config': {'vwapPts': 3}}
        seen = []
        def evaluate(config):
            seen.append(config)
            return {'config': config, 'config_fingerprint': weekly.json_fingerprint(config), 'evaluation_fingerprint': evaluation_fp, 'provenance':provenance, 'metrics_validation': {'expectancy': .2, 'net_pnl_r': 2}, 'validation_r': [1] * 10}
        mc_seen = []
        result = weekly.certify_report(report, production, production, {'metrics_validation': {'expectancy': 0}, 'validation_r': [-1] * 10, 'provenance':provenance, 'evaluation_fingerprint':evaluation_fp}, manifest, evaluate, lambda ticker, rs: mc_seen.append(rs) or {'survival': .9})
        self.assertEqual(seen[0]['vwapPts'], 3)
        self.assertEqual(mc_seen, [[1] * 10])
        self.assertEqual(result['status'], 'RECOMMEND')
        self.assertFalse(result['evaluation_certificate']['test_evaluated'])
        self.assertEqual(result['evaluation_certificate']['validation_role'], 'selection_validation')
        self.assertFalse(result['apply_eligible'])
        result['session_apply'] = {'NY': {'choch5m': {'minScore': 99}}}
        self.assertFalse(weekly.validate_certified_report(result))
        self.assertEqual(result['status'], 'HOLD_INTEGRITY')

    def test_manifest_claim_cannot_certify_prospective_test_without_registry(self):
        manifest = self.manifest()
        manifest.update(test_end_ms=400, test_independence='prospective')
        production = {'ticker':'EURUSD'}
        provenance = {'evaluation_manifest':manifest}
        fp = weekly.json_fingerprint(provenance)
        prod = {'provenance':provenance, 'evaluation_fingerprint':fp, 'metrics_validation':{'expectancy':0}}
        def evaluate(config):
            return {'config':config, 'config_fingerprint':weekly.json_fingerprint(config), 'provenance':provenance, 'evaluation_fingerprint':fp, 'metrics_validation':{'expectancy':.2}, 'validation_r':[1]*10, 'metrics_test':{'trade_count':10, 'expectancy':.1}}
        report = weekly.certify_report({},production,production,prod,manifest,evaluate,lambda *a:{'survival':.9})
        self.assertFalse(report['apply_eligible'])
        self.assertEqual(report['certificate']['test_independence'],'unverified')
        self.assertTrue(report['certificate']['test_evaluated'])

    def test_worker_hash_mismatch_fails_closed(self):
        manifest = self.manifest()
        def bad(config):
            return {'config': config, 'config_fingerprint': 'bad', 'evaluation_fingerprint': weekly.json_fingerprint(manifest), 'metrics_validation': {'expectancy': 2}, 'validation_r': [1]*10}
        result = weekly.certify_report({'best_config': {'vwapPts': 3}}, {'ticker': 'EURUSD'}, {}, {}, manifest, bad, lambda *args: self.fail('MC must not certify a mismatched candidate'))
        self.assertEqual(result['status'], 'HOLD_INTEGRITY')

    def test_every_selection_command_propagates_same_manifest_and_snapshot(self):
        for script in ('per_trigger_tune.ts', 'killswitch_tune.ts', 'directional_mcl_tune.ts', 'bias_confluence_tune.ts', 'loser_triggers_proposal.ts', 'sizing_weekly_proposal.ts'):
            cmd = weekly.selection_command(script, 'EURUSD', Path('/tmp/manifest.json'), Path('/tmp/snapshot.json'), Path('/tmp/logs'))
            self.assertEqual(cmd[cmd.index('--evaluation-manifest')+1], '/tmp/manifest.json')
            self.assertEqual(cmd[cmd.index('--config-file')+1], '/tmp/snapshot.json')
            self.assertIn('--dry-run', cmd)

if __name__ == '__main__':
    unittest.main()
