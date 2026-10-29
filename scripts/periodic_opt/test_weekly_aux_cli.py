"""Synthetic ping-only CSVs: real subprocess/worker CLI contracts, no market edge claim."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
TSX=ROOT/'node_modules/.bin/tsx'
BASE=1770000000000

class AuxiliaryCliTests(unittest.TestCase):
    def test_explicit_disabled_mask_never_creates_tasks_or_sessions(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); logs=root/'logs'; logs.mkdir()
            (logs/'M5.csv').write_text(f'PING_PRICE | TF: 5 | Precio: 1.10 | TS: {BASE}\n')
            manifest=dict(version=1,ticker='EURUSD',from_ms=BASE,train_end_ms=BASE+700,validation_end_ms=BASE+1000,test_end_ms=BASE+1000,test_independence='unverified')
            mf=root/'manifest.json'; mf.write_text(json.dumps(manifest))
            asset={'sessions':{'NY':{'choch5m':{'enabled':False,'minScore':99}}}}
            af=root/'asset.json'; af.write_text(json.dumps(asset)); out=root/'result.json'
            r=subprocess.run([str(TSX),str(ROOT/'scripts/per_trigger_tune.ts'),'EURUSD','--evaluation-manifest',str(mf),'--config-file',str(af),'--logs-dir',str(logs),'--save',str(out),'--dry-run','--budget','1','--concurrency','1'],cwd=ROOT,text=True,capture_output=True,timeout=30)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertIn('0 gatillos a optimizar',r.stderr)
            self.assertEqual(json.loads(out.read_text())['sessions'],asset['sessions'])

    def test_sizing_has_no_fixed_output_writes(self):
        source=(ROOT/'scripts/periodic_opt/sizing_weekly_proposal.ts').read_text()
        self.assertNotIn('writeFileSync("/opt/JARVIS',source)

    def test_actual_main_with_real_worker_and_all_auxiliary_entrypoints(self):
        with tempfile.TemporaryDirectory(prefix='weekly-synthetic-cli-') as d:
            root=Path(d)
            manifest=dict(version=1,ticker='EURUSD',from_ms=BASE,train_end_ms=BASE+700,validation_end_ms=BASE+1000,test_end_ms=BASE+1000,test_independence='unverified')
            mf=root/'manifest.json';mf.write_text(json.dumps(manifest))
            asset={'entryTrigger':'SMART','minPointsForBuy':7,'minPointsForSell':8,'tp1StructuralMinRR':2.4,'sessions':{'NY':{'choch5m':{'enabled':True,'minScore':7}}},'timesfm':{'enabled':False}}
            af=root/'asset.json';af.write_text(json.dumps(asset))
            logs=root/'logs';logs.mkdir()
            # A raw CSV-export input, exercising identical worker/selector unwrapping.
            lines='Fecha,Mensaje\n'+''.join(f'2026-01-01T00:00:00Z,"PING_PRICE | TF: 5 | Precio: 1.10 | TS: {BASE+x}"\n' for x in (0,1,699,700,999))
            (logs/'pine-logs-SMC Master_M5.csv').write_text(lines)
            cmd=['python3',str(ROOT/'scripts/periodic_opt/run_weekly.py'),'--tickers','EURUSD','--verification','--skip-hyperopt','--skip-ml','--config-file',str(af),'--evaluation-manifest',str(mf),'--logs-dir',str(logs),'--output-dir',str(root/'out'),'--trigger-budget','1']
            r=subprocess.run(cmd,cwd=ROOT,text=True,capture_output=True,timeout=120)
            report=json.loads((root/'out/reports/EURUSD.json').read_text())
            self.assertEqual(r.returncode,0,r.stdout+'\n'+r.stderr+'\n'+json.dumps(report))
            self.assertEqual(report['status'],'HOLD')
            self.assertFalse(report['apply_eligible'])
            self.assertEqual(report['final_config']['minBuyPoints'],7)
            self.assertEqual(report['final_config']['tp1StructuralMinRR'],2.4)
            self.assertEqual(report['final_config']['mlGate'],{'enabled':False})
            self.assertFalse(report['certificate']['test_evaluated'])
            self.assertEqual(report['metrics_test']['trade_count'],0)
            self.assertEqual(report['montecarlo']['partition'],'validation')
            self.assertFalse(any(k.endswith('_error') for k in report),report)
            for name in ('trigger_tune','ks_proposal','directional_mcl','bias_confluence','loser_triggers','sizing_proposal'):
                self.assertIn(name,report)
                self.assertEqual(report[name]['selection_partition'],'train')
                self.assertEqual(report[name]['evaluation_manifest'],manifest)
            self.assertFalse(report['sizing_proposal']['apply_eligible'])
            self.assertEqual(report['sizing_proposal']['n'],0)
            self.assertEqual(report['evaluation_fingerprint'],report['certificate']['evaluation_fingerprint'])
            self.assertEqual(report['evaluation_manifest'],manifest)

if __name__=='__main__':unittest.main()
