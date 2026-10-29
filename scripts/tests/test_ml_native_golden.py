"""No training/artifact writes. Synthetic 14-column tree loaded in memory by real XGBoost."""
import copy
import json
import math
import subprocess
from pathlib import Path
import numpy as np
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[2]
legacy = json.loads((ROOT / 'scripts/hyperopt/models/ml_model.json').read_text())
names = ['dir_z_momentum','vwap_regime_aligned','atr_to_adr_ratio','adr_exhaustion_dir',
         'adr_room_to_tp1','htf_bias_confluence','time_sin','time_cos','session_killzone_quality',
         'recent_sweep_aligned','smc_score_excess','zone_confluence_density','spread_to_normal_ratio','tick_velocity_z']
model = copy.deepcopy(legacy)
model['meta'] = dict(feature_names=names,n_features=14,threshold=.65,accuracy=.5,f1=.5,train_samples=0,
    inference_profile='xgboost/binary-logistic/numeric-gbtree/float32/default-left/intercept/v1')
model['features'] = names
learner = model['xgboost_model']['learner']
learner['feature_names'] = names
learner['learner_model_param'].update(num_feature='14',base_score='[8E-1]',boost_from_average='0')
booster_model = learner['gradient_booster']['model']
booster_model['gbtree_model_param'].update(num_trees='1',num_parallel_tree='1')
booster_model['iteration_indptr'] = [0,1]
booster_model['tree_info'] = [0]
booster_model['trees'] = [dict(id=0,base_weights=[0.,99.,-99.],categories=[],categories_nodes=[],
    categories_segments=[],categories_sizes=[],default_left=[0,0,0],left_children=[1,-1,-1],
    right_children=[2,-1,-1],loss_changes=[0.,0.,0.],parents=[2147483647,0,0],
    split_conditions=[1.,-.4,.7],split_indices=[0,0,0],split_type=[0,0,0],sum_hessian=[0.,0.,0.],
    tree_param=dict(num_deleted='0',num_feature='14',num_nodes='3',size_leaf_vector='1'))]
# Serialized decimals deliberately straddle their binary float32 representations.
# Models/rows are declared synthetic, RAM-only. No fit/train/save_model calls.
reports = []
for split, first in [(1.,1.),(.300000012,.3),(.200000003,.2),(.100000001,.1),
                     (.699999988,.7),(.600000024,.6),(.899999976,.9),
                     (-.300000012,-.3),(1.23456788,1.23456789)]:
    rows = [[value]+[0.]*13 for value in [first-.01,first,float(np.float32(first)),first+.01,None]]
    for default_left in (0,1):
        booster_model['trees'][0]['split_conditions'][0] = split
        booster_model['trees'][0]['default_left'][0] = default_left
        native = xgb.Booster()
        native.load_model(bytearray(json.dumps(model['xgboost_model']), 'utf8'))
        X = np.array([[np.nan if x is None else x for x in row] for row in rows],dtype=np.float32)
        expected = native.predict(xgb.DMatrix(X,feature_names=names))
        result = subprocess.run([str(ROOT/'node_modules/.bin/tsx'),str(ROOT/'scripts/tests/ml_native_fixture_probe.ts')],
            input=json.dumps(dict(model=model,rows=rows)),capture_output=True,text=True,check=True,cwd=ROOT)
        actual = np.array(json.loads(result.stdout.strip()))
        error = float(np.max(np.abs(actual-expected)))
        reports.append(dict(serialized_split=split,input=first,float32=float(np.float32(first)),
            default_left=default_left,native=[float(x) for x in expected],typescript=actual.tolist(),
            max_abs_error=error,equality_right=bool(actual[1]==actual[2]==actual[3]),
            missing_branch_matches=bool(actual[4]==actual[0 if default_left else 3])))
passed = all(r['max_abs_error'] < 2e-7 and r['equality_right'] and r['missing_branch_matches'] for r in reports)
print(json.dumps(dict(test='ml-native-golden',status='PASS' if passed else 'FAIL',
    comparisons=sum(len(r['native']) for r in reports),model_cases=len(reports),
    max_abs_error=max(r['max_abs_error'] for r in reports),xgboost=xgb.__version__,
    trained=False,artifact_written=False,synthetic_ram_only=True,reports=reports)))
assert passed, 'native float32 decimal equality/default_left parity'
