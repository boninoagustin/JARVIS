"""Wire contract on PING-only declared fixtures: no market optimization or writes."""
import json
from pathlib import Path
import tempfile
import unittest
from test_worker_protocol import rpc, BASE, MANIFEST, CONFIG

class ObjectiveWireTests(unittest.TestCase):
    def test_closed_records_are_partitioned_and_test_is_final_only(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'M5.csv').write_text(''.join(
                f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {BASE+x}\n'
                for x in (0,1,699,700,999,1000,1199)))
            result=rpc(d,[('init',dict(ticker='EURUSD',log_dir=d,evaluation_manifest=MANIFEST)),
                          ('evaluate',{'config':CONFIG}),('evaluate_final',{'config':CONFIG})])
            train=result[1]['result']; final=result[2]['result']
            self.assertEqual(train.get('trade_records_version'),1)
            self.assertEqual(train['train_trades'],[])
            self.assertEqual(train['validation_trades'],[])
            self.assertNotIn('test_trades',train)
            self.assertEqual(final['test_trades'],[])
            from objective_adapter import canonicalize_result
            canonical = canonicalize_result(final)
            self.assertEqual(json.dumps(canonical['metrics_test'],sort_keys=True),
                             json.dumps(final['metrics_test'],sort_keys=True),
                             'extended statistics must not mutate signed Test payload')
            self.assertEqual(canonical['test_evidence'],final['test_evidence'])
            self.assertIn('metrics_test_canonical',canonical)
            self.assertEqual(train['objective'],-100)
            self.assertEqual(train['objective_authority'],'legacy_compatibility_ts')
            hashed={Path(f['path']).name for f in result[0]['result']['provenance']['source_files']}
            self.assertIn('metrics.py',hashed)
            self.assertIn('dsr.py',hashed)

if __name__=='__main__': unittest.main()
