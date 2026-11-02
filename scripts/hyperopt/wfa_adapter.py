"""Fail-closed canonical boundary for experimental WFA; v1 remains independent."""
from __future__ import annotations
import copy
import hashlib
import json
import math
from pathlib import Path
import subprocess
from datetime import datetime
import metrics
import wfa_protocol
from objective_adapter import _assert_legacy_parity, assert_scoring_snapshot, objective_policy

_PATHS = [Path(__file__).resolve(), Path(wfa_protocol.__file__).resolve(),
          Path(__file__).with_name('hyperopt_server.py')]
LOADED_HASHES = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in _PATHS}


def fingerprints(*values):
    # Use actual ECMAScript number serialization, also for integer-looking floats.
    source = "const fs=require('fs'),c=require('crypto');const f=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(f).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+f(x[k])).join(',')+'}';console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(x=>c.createHash('sha256').update(f(x)).digest('hex'))));"
    return json.loads(subprocess.run(['node','-e',source], input=json.dumps(values, allow_nan=False),
                                     text=True,capture_output=True,check=True).stdout)


def assert_snapshot(provenance):
    assert_scoring_snapshot(provenance)
    hashes = {f['path']:f['sha256'] for f in provenance.get('source_files',[])}
    for path, sha in LOADED_HASHES.items():
        if hashlib.sha256(Path(path).read_bytes()).hexdigest() != sha or hashes.get(path) != sha:
            raise ValueError('WFA Python loaded source snapshot differs from worker; restart')


def window_bounds(plan, fold_id, role):
    f = wfa_protocol.resolve_fold(plan, fold_id)
    bounds = {'inner_train':(f['is_start_ms'],f['inner_train_end_ms']),
              'inner_validation':(f['inner_validation_start_ms'],f['is_end_ms']),
              'is':(f['is_start_ms'],f['is_end_ms']),
              'outer_oos':(f['oos_start_ms'],f['oos_end_ms'])}
    if role not in bounds:
        raise ValueError('invalid WFA role')
    start,end = bounds[role]
    wfa_protocol.assert_window_access(plan,start,end,role=role,fold_id=fold_id)
    return f,start,end


def validate_replay_model(descriptor, plan, fold, role):
    if descriptor is None:
        return None
    fields = {'version','kind','fold_id','fit_asof_ms','plan_fingerprint','model_path','model_sha256'}
    if (role != 'outer_oos' or not isinstance(descriptor,dict) or set(descriptor) != fields
        or type(descriptor['version']) is not int or descriptor['version'] != 1
        or descriptor['kind'] != 'historical_reconstruction'
        or type(descriptor['fold_id']) is not int or descriptor['fold_id'] != fold['id']
        or type(descriptor['fit_asof_ms']) is not int or descriptor['fit_asof_ms'] != fold['is_end_ms']
        or descriptor['plan_fingerprint'] != plan['fingerprint']):
        raise ValueError('invalid replay_model identity/role/asof')
    path,sha = descriptor['model_path'],descriptor['model_sha256']
    if (not isinstance(path,str) or not Path(path).is_absolute() or not isinstance(sha,str)
        or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha)):
        raise ValueError('invalid replay_model path/hash')
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != sha:
        raise ValueError('replay_model bytes hash mismatch')
    model = json.loads(raw)
    meta = model.get('meta',{})
    r = meta.get('wfa_reconstruction',{})
    if (r.get('version') != 1 or r.get('fold_id') != fold['id']
        or r.get('fit_asof_ms') != fold['is_end_ms'] or r.get('plan_fingerprint') != plan['fingerprint']
        or type(r.get('train_label_end_ms')) is not int
        or not fold['is_start_ms'] <= r['train_label_end_ms'] < fold['inner_train_end_ms']
        or type(r.get('selection_label_end_ms')) is not int
        or not fold['inner_validation_start_ms'] <= r['selection_label_end_ms'] < fold['is_end_ms']
        or meta.get('ticker') != plan['ticker'] or meta.get('train_end_ms') != fold['inner_train_end_ms']
        or type(meta.get('available_at_ms')) is not int or type(meta.get('trained_at_ms')) is not int
        or not fold['is_end_ms'] <= meta['trained_at_ms'] <= meta['available_at_ms']):
        raise ValueError('invalid reconstruction metadata/label cutoffs')
    try:
        trained = datetime.fromisoformat(meta['trained_at'].replace('Z','+00:00'))
        if trained.utcoffset() is None or round(trained.timestamp()*1000) != meta['trained_at_ms']:
            raise ValueError('reconstruction trained wall clock mismatch')
    except (KeyError,TypeError,AttributeError,OverflowError) as exc:
        raise ValueError('invalid reconstruction trained wall clock') from exc
    return meta


def canonicalize_window(result, plan, fold_id, role, *, init_info, replay_model=None, requested_config=None):
    plan = wfa_protocol.validate_wfa_plan(plan)
    fold,start,end = window_bounds(plan,fold_id,role)
    json.dumps(result,allow_nan=False)
    if (not isinstance(result,dict) or result.get('kind') != 'wfa_window_v1'
        or type(result.get('fold_id')) is not int or result['fold_id'] != fold_id
        or result.get('role') != role or result.get('wfa_plan') != plan
        or result.get('plan_fingerprint') != plan['fingerprint']
        or result.get('window') != {'from_ms':start,'to_ms':end}
        or result.get('trade_records_version') != 1 or result.get('apply_eligible') is not False
        or result.get('objective_version') != 'legacy_v1' or result.get('shadow_consumed_by_sampler') is not False):
        raise ValueError('WFA response identity/role/window/schema mismatch')
    provenance = result.get('provenance',{})
    assert_snapshot(provenance)
    config = result.get('effective_config',{})
    if config.get('ticker') != plan['ticker']:
        raise ValueError('WFA config ticker mismatch')
    if requested_config is not None:
        requested = copy.deepcopy(requested_config)
        effective = copy.deepcopy(config)
        requested.pop('mlGate',None);effective.pop('mlGate',None)
        for obj in (requested,effective):
            tfm = obj.get('timesfm')
            if isinstance(tfm,dict):
                for key in ('collectOnly','collectPath','auditPath'):
                    tfm.pop(key,None)
                if tfm.get('cachePath'):
                    tfm['cachePath'] = str(Path(tfm['cachePath']).resolve())
        if requested != effective:
            raise ValueError('WFA effective config differs from requested non-ML settings')
    a,b = fingerprints(provenance,config)
    if result.get('evaluation_fingerprint') != a or result.get('config_fingerprint') != b:
        raise ValueError('WFA provenance/config fingerprint mismatch')
    expected = copy.deepcopy(init_info['provenance'])
    # Model/cache are scenario-specific; everything else must remain the init snapshot.
    expected.update(model_files=provenance.get('model_files'),cache_files=provenance.get('cache_files'),
                    wfa_window=dict(fold_id=fold_id,role=role,from_ms=start,to_ms=end),replay_model=replay_model)
    if provenance != expected or provenance.get('wfa_plan') != plan:
        raise ValueError('WFA provenance differs from initialized plan/source snapshot')
    for category in ('source_files','dataset_files','model_files','cache_files','manifest_files'):
        items = provenance.get(category)
        if not isinstance(items,list):
            raise ValueError('invalid provenance file list')
        for item in items:
            if (not isinstance(item,dict) or set(item) != {'path','sha256'}
                or hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() != item['sha256']):
                raise ValueError(f'WFA provenance file snapshot mismatch: {item}')
    model_meta = validate_replay_model(replay_model,plan,fold,role)
    ml = result.get('ml_provenance',{})
    if replay_model is not None:
        if (provenance['model_files'] != [dict(path=replay_model['model_path'],sha256=replay_model['model_sha256'])]
            or ml.get('replay_model') != replay_model or ml.get('reconstruction') != model_meta['wfa_reconstruction']
            or ml.get('available_at_ms') != model_meta['available_at_ms']
            or ml.get('simulated_asof_ms') != fold['is_end_ms']):
            raise ValueError('WFA replay model provenance mismatch')
    gate = config.get('mlGate',{})
    if ml.get('enabled') is not gate.get('enabled') or (gate.get('enabled') and config.get('mlGateEnabled') is not True):
        raise ValueError('WFA ML permission/provenance mismatch')
    if requested_config is not None:
        request_gate = requested_config.get('mlGate') or {}
        model_path = (replay_model['model_path'] if replay_model is not None else
                      request_gate.get('modelPath',init_info.get('ml_provenance',{}).get('model_path')))
        model_path = str(Path(model_path).resolve()) if model_path else None
        model_files = provenance['model_files']
        if model_path is None:
            if model_files:
                raise ValueError('unexpected WFA model snapshot')
            available = None
        else:
            raw = Path(model_path).read_bytes()
            if model_files != [dict(path=model_path,sha256=hashlib.sha256(raw).hexdigest())]:
                raise ValueError('WFA model differs from requested artifact')
            meta = json.loads(raw).get('meta',{})
            train,available = meta.get('train_end_ms'),meta.get('available_at_ms')
            if available is None and isinstance(meta.get('trained_at'),str):
                try:
                    available = round(datetime.fromisoformat(meta['trained_at'].replace('Z','+00:00')).timestamp()*1000)
                except ValueError:
                    available = None
            if type(train) is not int or type(available) is not int or available < train:
                available = None
        enabled = requested_config.get('mlGateEnabled') is True and request_gate.get('enabled') is not False and available is not None
        expected_gate = dict(enabled=True,modelPath=model_path,
                             trainedAt=fold['is_end_ms'] if replay_model is not None else available) if enabled else {'enabled':False}
        if gate != expected_gate:
            raise ValueError('WFA gate differs from requested permission/model availability')
    expected_replay = dict(warmupStartMs=max(0,start-int(plan['policy']['warmup_days']*86400000)),
        evaluationStartMs=start,evaluationEndMs=end,statePolicy='context-only-reset-execution-v1',
        minContextObservations=plan['policy']['min_context_observations'])
    diagnostics = result.get('replayDiagnostics',{})
    actual_warmup = result.get('replay_options',{}).get('warmupStartMs')
    if type(actual_warmup) is not int or not 0 <= actual_warmup <= expected_replay['warmupStartMs']:
        raise ValueError('WFA warmup must cover elapsed floor using causal context, distinct from M5 scoring horizon')
    expected_replay['warmupStartMs'] = actual_warmup
    if (result.get('replay_options') != expected_replay or any(diagnostics.get(k) != v for k,v in expected_replay.items())
        or diagnostics.get('portfolioPolicy') != 'reset-per-fold' or diagnostics.get('version') != 1):
        raise ValueError('WFA replay frame/context policy mismatch')
    ready = diagnostics.get('readiness',{}).get('ready')
    observations = diagnostics.get('readiness',{}).get('observations',{})
    minimums = plan['policy']['min_context_observations']
    if not isinstance(observations,dict) or any(type(observations.get(tf)) is not int or observations[tf]<0 for tf in minimums):
        raise ValueError('invalid WFA context observation counts')
    missing = {tf for tf,n in minimums.items() if observations[tf]<n}
    reported_missing = diagnostics.get('readiness',{}).get('missing')
    if not isinstance(reported_missing,list) or set(reported_missing) != missing or ready is not (not missing):
        raise ValueError('WFA readiness contradicts observations')
    if type(ready) is not bool or result.get('status') != ('OK' if ready else 'HOLD_CONTEXT'):
        raise ValueError('WFA readiness/status mismatch')
    records = result.get('closed_trades')
    if not isinstance(records,list):
        raise ValueError('closed_trades must be an array')
    previous = None
    identities = set()
    for t in records:
        if (not isinstance(t,dict) or t.get('label_status') != 'closed'
            or type(t.get('timestamp')) is not int or type(t.get('closeTimestamp')) is not int
            or not start <= t['timestamp'] <= t['closeTimestamp'] < end
            or t.get('closedAt') != t['closeTimestamp'] or t.get('closeTs') != t['closeTimestamp']
            or t.get('result') not in ('WIN','LOSS','BE','TIMEOUT','REVERSAL')
            or type(t.get('rMultiple')) not in (int,float) or not math.isfinite(t['rMultiple'])):
            raise ValueError('invalid confirmed WFA close record')
        order = (t['closeTimestamp'],t['timestamp'])
        identity = (t['timestamp'],t['closeTimestamp'],t.get('direction'))
        if (previous is not None and order < previous) or identity in identities:
            raise ValueError('WFA closed records unordered or duplicate')
        previous = order;identities.add(identity)
    returns = result.get('returns')
    if (not isinstance(returns,list) or len(returns) != len(records)
        or any(type(v) not in (int,float) or not math.isfinite(v) or v != t['rMultiple'] for v,t in zip(returns,records))):
        raise ValueError('WFA returns must match exact closed realization')
    computed = metrics.compute_metrics(records,time_bounds=(start,end))
    canonical = metrics.to_dict(computed)
    _assert_legacy_parity(result['metrics'],canonical,role)
    selecting = role == 'inner_train' and ready
    legacy = metrics.objective_function(computed) if selecting else None
    score = result.get('selection_objective')
    if ((selecting and (type(score) not in (int,float) or not math.isfinite(score)
                       or not math.isclose(score,legacy,rel_tol=1e-11,abs_tol=1e-11)))
        or (not selecting and score is not None)):
        raise ValueError('WFA selection objective restricted to ready inner_train legacy_v1')
    out = copy.deepcopy(result)
    out.update(metrics=canonical,selection_objective=legacy,
               objective_authority='scripts/hyperopt/metrics.py',objective_policy=objective_policy(),
               objective_shadow=metrics.shadow_objective(computed),shadow_consumed_by_sampler=False)
    json.dumps(out,allow_nan=False)
    return out
