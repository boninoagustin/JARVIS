"""Offline AST execution of real bridge functions; no imports/model/HTTP listener."""
import ast
import unittest
import re
import math
import threading
from collections import deque
from pathlib import Path
from types import SimpleNamespace
SOURCE = Path(__file__).with_name('timesfm_bridge.py')

def load():
    tree=ast.parse(SOURCE.read_text())
    nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in {'norm_tf','norm_ts','recompute','ingest_candle','bootstrap_from_csv','valid_forecast_arrays'}]
    now=1792160100300
    ns={'re':re,'math':math,'deque':deque,'_series':{},'_latest':{},'_series_conventions':{},'_state_lock':threading.RLock(),'TRACKED_TFS':[5,15],'MAXLEN':2048,'CONTEXT_N':2,'HORIZON':2,'MODEL_VERSION':'unit-model','SCHEMA_VERSION':2,'TIMESTAMP_CONVENTION':'context_close_ms_v2','time':SimpleNamespace(time=lambda:now/1000),'np':SimpleNamespace(array=lambda v,dtype:list(v),float64=float),'enqueue_recompute':lambda *a:True,'persist_latest':lambda *a:None}
    ns['forecast_batch']=lambda *a:[{'point':[2,2],'q10':[1,1],'q50':[2,2],'q90':[3,3]}]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),ns)
    return ns

class ProtocolTest(unittest.TestCase):
    def test_timeframe_real_mapping(self):
        n=load()
        self.assertEqual([n['norm_tf'](x) for x in ['M5','M15','H1','H4','D1','W1','60']],[5,15,60,240,1440,10080,60])
        for x in ['bad','garbage15','H2','',True]:
            with self.assertRaises(ValueError):n['norm_tf'](x)

    def test_explicit_close_and_legacy_separation(self):
        n=load();self.assertIn('ingest_candle',n,'validated protocol ingestion required')
        for bad in [None, [], 'not-an-object']:
            code,_=n['ingest_candle'](bad);self.assertEqual(code,400)
        body={'ticker':'EURUSD','tf':'M15','ts':1792160100000,'contextCloseTimeMs':1792160100000,'close':1.2,'schema_version':2,'timestamp_convention':'context_close_ms_v2'}
        code,_=n['ingest_candle'](body);self.assertEqual(code,202)
        self.assertEqual(n['_series'][('eurusd',15)][-1][0],body['ts'])
        self.assertEqual(n['_series_conventions'][('eurusd',15)],'context_close_ms_v2')
        before=list(n['_series'][('eurusd',15)])
        for patch in [{'tf':'H1'},{'close':float('nan')},{'contextCloseTimeMs':1792161000000},{'ts':1792160100001},{'contextCloseTimeMs':None}]:
            code,_=n['ingest_candle']({**body,**patch});self.assertEqual(code,400,patch)
            self.assertEqual(list(n['_series'][('eurusd',15)]),before)
        code,_=n['ingest_candle']({'ticker':'EURUSD','tf':15,'ts':1792160100000,'close':1.2})
        self.assertEqual(code,409,'legacy timestamp must not be relabelled v2')
        code,_=n['ingest_candle']({'ticker':'GBPUSD','tf':15,'ts':1792159200000,'close':1.2})
        self.assertEqual(code,202);self.assertEqual(n['_series_conventions'][('gbpusd',15)],'legacy_unspecified')

    def test_bootstrap_close_boundary_is_not_shifted(self):
        import tempfile
        n=load();origin=1792160100000
        with tempfile.TemporaryDirectory() as d:
            n['LOGS_DIR']=Path(d)
            hist=Path(d)/'eurusd'/'history_exported';hist.mkdir(parents=True)
            n['PING_RE']=re.compile(r'PING_PRICE \| TF: (?P<tf>\S+) \| Precio: (?P<price>[0-9.]+).*?\| TS: (?P<ts>\d+)')
            (hist/'pine-logs-SMC Master_M15.csv').write_text(''.join(f'PING_PRICE | TF: 15 | Precio: 1.2 | TS: {ts}\n' for ts in [origin-900000,origin,origin,origin-900000,origin+900000]))
            n['bootstrap_from_csv']()
        self.assertEqual(list(n['_series'][('eurusd',15)]),[(origin-900000,1.2),(origin,1.2)])
        self.assertEqual(n['_series_conventions'].get(('eurusd',15)),'context_close_ms_v2')
        n['recompute']('eurusd',15);self.assertEqual(n['_latest'][('eurusd',15)]['contextCloseTimeMs'],origin)

    def test_recompute_uses_snapshot_and_validated_availability(self):
        n=load();key=('eurusd',15);origin=1792160100000
        n['_series'][key]=deque([(origin-900000,1),(origin,2)])
        n['_series_conventions'][key]='context_close_ms_v2'
        n['recompute'](*key);f=n['_latest'][key]
        self.assertEqual(f.get('contextCloseTimeMs'),origin)
        self.assertEqual(f.get('availableAt'),1792160100300)
        self.assertEqual(f.get('schema_version'),2)
        self.assertEqual(f['ts'],origin)
        old=dict(f)
        n['forecast_batch']=lambda *a:[{'point':[2,2],'q10':[3,3],'q50':[2,2],'q90':[1,1]}]
        n['recompute'](*key);self.assertEqual(n['_latest'][key],old,'invalid result cannot replace good snapshot')
        n['_series_conventions'][key]='legacy_unspecified';n['forecast_batch']=lambda *a:[{'point':[2,2],'q10':[1,1],'q50':[2,2],'q90':[3,3]}]
        n['_latest'].clear();n['recompute'](*key)
        self.assertNotIn('contextCloseTimeMs',n['_latest'][key]);self.assertNotIn('schema_version',n['_latest'][key])

if __name__=='__main__':unittest.main(verbosity=2)
