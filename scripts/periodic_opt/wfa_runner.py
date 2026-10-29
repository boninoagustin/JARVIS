#!/usr/bin/env python3
"""Finite, isolated rolling WFA research. No apply, promotion, network or Vault RPC.

The stitched future evaluates a recalibration procedure, not one production preset.
CLI bootstraps the existing hyperopt venv before importing Optuna/ML dependencies.
"""
from __future__ import annotations
import argparse
from copy import deepcopy
from dataclasses import asdict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]
VENV = REPO / 'scripts/hyperopt/.venv/bin/python'
if __name__ == '__main__' and VENV.is_file() and Path(sys.prefix).resolve() != VENV.parent.parent.resolve():
    os.execv(str(VENV), [str(VENV), str(Path(__file__).resolve()), *sys.argv[1:]])
for path in (REPO, REPO/'scripts/hyperopt'):
    sys.path.insert(0, str(path))


def fingerprint(value):
    # Exact worker JS canonical number/key semantics (including integer ROI keys).
    from scripts.periodic_opt.run_weekly import json_fingerprint
    return json_fingerprint(value)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
    return path


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def command_saved(command, timeout=14400):
    path = Path(command[command.index('--save')+1])
    if path.exists():
        raise ValueError(f'output already exists: {path}')
    result = subprocess.run(command, cwd=REPO, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'command exit {result.returncode}: {(result.stderr or result.stdout)[-1200:]}')
    if not path.is_file():
        raise RuntimeError('command did not save its JSON artifact')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('command JSON must be an object')
    return value


def map_asset(ticker, asset_path, output_path, timesfm_cache=None):
    command = [str(REPO/'node_modules/.bin/tsx'), str(REPO/'scripts/periodic_opt/eval_production.ts'),
               ticker, '--map-only', '--config-file', str(asset_path), '--save', str(output_path)]
    if timesfm_cache:
        command += ['--timesfm-cache', str(timesfm_cache)]
    mapped = command_saved(command, timeout=120)
    if mapped.get('mapping_only') is not True or mapped.get('ticker') != ticker:
        raise ValueError('mapper did not return map-only snapshot for ticker')
    return mapped


def bounds(fold, role):
    keys={'inner_train':('is_start_ms','inner_train_end_ms'),
          'inner_validation':('inner_validation_start_ms','is_end_ms'),
          'is':('is_start_ms','is_end_ms'),'outer_oos':('oos_start_ms','oos_end_ms')}
    if role not in keys:
        raise ValueError('unknown WFA window role')
    a,b=keys[role]
    return fold[a],fold[b]


class NoContext(Exception):
    pass


def checked_window(worker, config, plan, fold, role, *, replay_model=None):
    from scripts.hyperopt.wfa_protocol import assert_window_access
    from scripts.hyperopt.metrics import compute_metrics
    start, end = bounds(fold, role)
    assert_window_access(plan, start, end, role=role, fold_id=fold['id'])
    if replay_model is not None and role != 'outer_oos':
        raise ValueError('reconstruction is restricted to outer OOS')
    result = worker.evaluate_window(deepcopy(config), deepcopy(plan), fold['id'], role, replay_model=replay_model)
    if result.get('kind') != 'wfa_window_v1' or result.get('fold_id') != fold['id'] or result.get('role') != role:
        raise ValueError('worker WFA window identity mismatch')
    window = result.get('window', {})
    if (window.get('from_ms'), window.get('to_ms')) != (start, end):
        raise ValueError('worker WFA bounds mismatch')
    if result.get('status') == 'HOLD_CONTEXT' or result.get('replayDiagnostics', {}).get('readiness', {}).get('ready') is not True:
        raise NoContext('HOLD_NO_CONTEXT: worker readiness insufficient')
    if result.get('status') != 'OK':
        raise ValueError('unexpected worker WFA status')
    if fingerprint(result['effective_config']) != result['config_fingerprint']:
        raise ValueError('worker effective config fingerprint mismatch')
    if fingerprint(result['provenance']) != result['evaluation_fingerprint']:
        raise ValueError('worker evaluation provenance fingerprint mismatch')
    trades = result['closed_trades']
    previous = None
    identities = set()
    for trade in trades:
        entry, close = trade.get('timestamp'), trade.get('closedAt')
        r = trade.get('rMultiple')
        if (type(entry) is not int or type(close) is not int or not start <= entry <= close < end
            or trade.get('closeTimestamp') != close or trade.get('result') not in ('WIN','LOSS','BE','TIMEOUT','REVERSAL')
            or isinstance(r, bool) or not isinstance(r, (int,float)) or not math.isfinite(r)):
            raise ValueError('worker returned invalid or censored closed trade')
        if previous is not None and close < previous:
            raise ValueError('worker returns must use closure order')
        previous = close
        key = (entry, close, trade.get('direction'))
        if key in identities:
            raise ValueError('duplicate closed trade')
        identities.add(key)
    if result['returns'] != [t['rMultiple'] for t in trades]:
        raise ValueError('worker returns do not match closed trades')
    canonical = asdict(compute_metrics(trades))
    for key in ('trade_count','net_pnl_r','max_drawdown_r','expectancy'):
        if result['metrics'].get(key) != canonical[key]:
            raise ValueError(f'worker canonical metrics mismatch: {key}')
    score = result.get('selection_objective')
    if role == 'inner_train':
        if isinstance(score, bool) or not isinstance(score, (int,float)) or not math.isfinite(score):
            raise ValueError('inner_train requires finite selection objective')
    elif score is not None:
        raise ValueError('non-selection window exposed selection objective')
    return result


def run_auxiliary(ticker, fold, train_result, candidate, asset_path, log_dir, fold_dir, trigger_budget):
    from scripts.periodic_opt.run_weekly import selection_command, assemble_candidate
    replay = train_result.get('replay_options')
    if not isinstance(replay, dict):
        raise NoContext('HOLD_AUX_CONTEXT_POLICY: worker omitted phased replay options')
    if (replay.get('evaluationStartMs'), replay.get('evaluationEndMs')) != bounds(fold,'inner_train'):
        raise ValueError('auxiliary replay window differs from inner_train')
    manifest = dict(version=1, ticker=ticker, from_ms=fold['is_start_ms'],
                    train_end_ms=fold['inner_train_end_ms'], validation_end_ms=fold['is_end_ms'],
                    test_end_ms=fold['is_end_ms'], test_independence='unverified')
    manifest_path = write_json(fold_dir/'selection_manifest.json', manifest)
    replay_path = write_json(fold_dir/'selection_replay.json', replay)
    base_path = write_json(fold_dir/'selection_base.json', candidate)
    empty_journal = write_json(fold_dir/'journal.json', [])
    report = {}
    selectors = [('trigger_tune','scripts/per_trigger_tune.ts',['--budget',str(trigger_budget),'--concurrency','1']),
                 ('ks_proposal','scripts/killswitch_tune.ts',[]),
                 ('directional_mcl','scripts/directional_mcl_tune.ts',[]),
                 ('bias_confluence','scripts/bias_confluence_tune.ts',[]),
                 ('loser_triggers','scripts/periodic_opt/loser_triggers_proposal.ts',[]),
                 ('sizing_proposal','scripts/periodic_opt/sizing_weekly_proposal.ts',['--trades-file',str(empty_journal)])]
    for key, script, extra in selectors:
        command = selection_command(REPO/script, ticker, manifest_path, asset_path, log_dir,
                                    '--backtest-config-file',base_path,'--wfa-replay-window',replay_path,
                                    '--save',fold_dir/f'{key}.json',*extra)
        report[key] = command_saved(command)
        if key == 'trigger_tune':
            report['session_apply'] = report[key].get('sessions') or {}
            report['session_apply_replace'] = True
    # Sizing remains diagnostic: assemble_candidate deliberately does not apply it.
    return assemble_candidate(candidate, report), dict(results=report,context_policy='context-only-reset-execution-v1')


def stitch(fold_results):
    """Only disjoint OOS windows, validated trades, closure order, no duplicated fills."""
    ordered = sorted(fold_results, key=lambda r:r['window']['from_ms'])
    trades, seen, prior_end = [], set(), None
    for result in ordered:
        window = result['window']
        if prior_end is not None and window['from_ms'] < prior_end:
            raise ValueError('overlapping outer OOS windows')
        prior_end = window['to_ms']
        for trade in result['closed_trades']:
            key = (trade['timestamp'],trade['closedAt'],trade.get('direction'))
            if key in seen:
                raise ValueError('duplicate stitched closed trade')
            seen.add(key)
            trades.append(dict(trade, fold_id=result['fold_id']))
    return sorted(trades, key=lambda t:(t['closedAt'],t['timestamp']))


def calendar_pair(prop, prod, windows):
    day = 86400000
    # Full common UTC calendar, including zero-activity days and step gaps.
    start = min(w['from_ms'] for w in windows)//day
    end = (max(w['to_ms'] for w in windows)-1)//day
    vectors = []
    for trades in (prop,prod):
        totals = dict.fromkeys(range(start,end+1),0.)
        for trade in trades:
            totals[trade['closedAt']//day] += trade['rMultiple']
        vectors.append(list(totals.values()))
    return dict(from_day_utc_ms=start*day,day_ms=day,prop=vectors[0],prod=vectors[1])


def run_wfa_shadow(*, ticker, log_dir, asset_config:dict, output_dir:Path,
                   n_trials:int=1, trigger_budget:int=1, skip_aux:bool=False,
                   skip_ml:bool=False, policy:dict|None=None, worker_factory=None):
    import optuna
    from hyperopt_server import HyperoptWorker, suggest_params, build_backtest_config
    from scripts.hyperopt.wfa_protocol import build_wfa_plan, resolve_fold
    from scripts.hyperopt.metrics import compute_metrics, objective_policy
    from scripts.periodic_opt.wfa_gates import (stationary_bootstrap, paired_calendar_bootstrap,
                                               evaluate_wfa_gates, GATE_POLICY)
    if not isinstance(ticker,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+',ticker) or ticker in ('.','..'):
        raise ValueError('ticker must be a safe single asset identifier')
    if type(n_trials) is not int or n_trials < 1 or type(trigger_budget) is not int or trigger_budget < 1:
        raise ValueError('n_trials and trigger_budget must be positive integers')
    if not isinstance(asset_config,dict):
        raise ValueError('asset_config must be a raw object')
    if asset_config.get('ticker',ticker) != ticker:
        raise ValueError('asset snapshot ticker mismatch')
    output_dir = Path(output_dir).resolve()
    # No study/report/model/preset artifacts inside active data or source trees.
    if output_dir == REPO or REPO in output_dir.parents:
        raise ValueError('output-dir must be isolated outside the repository')
    output_dir.mkdir(parents=True,exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix='wfa-',dir=output_dir))
    asset_path = write_json(run_dir/'production_asset.json',deepcopy(asset_config))
    cache = (asset_config.get('timesfm') or {}).get('cachePath')
    mapped = map_asset(ticker,asset_path,run_dir/'mapping.json',cache)
    base = deepcopy(mapped['config'])
    cache = (base.get('timesfm') or {}).get('cachePath')
    if (base.get('timesfm') or {}).get('enabled') and not cache:
        raise ValueError('TimesFM enabled but replay cache unavailable; WFA will not silently disable it')
    if base.get('ticker') != ticker or base.get('mlGateEnabled',False) != (asset_config.get('mlGateEnabled') is True):
        raise ValueError('mapped production identity or ML permission mismatch')
    base_path = write_json(run_dir/'production_config.json',base)
    protected = {asset_path:file_sha(asset_path),base_path:file_sha(base_path)}
    for source in (Path(__file__),Path(__file__).with_name('wfa_ml.py'),
                   Path(__file__).with_name('wfa_gates.py')):
        protected[source] = file_sha(source)
    if cache:
        protected[Path(cache).resolve()] = file_sha(cache)
    worker = worker_factory() if worker_factory else HyperoptWorker(str(REPO/'node_modules/.bin/tsx'),'npx',REPO)
    report = dict(version=1,kind='rolling_wfa_shadow_report',ticker=ticker,status='HOLD_INSUFFICIENT_DATA',
                  apply_eligible=False,changes_production=False,run_dir=str(run_dir),folds=[],
                  dsr=dict(skip=True,calibration_status='missing',scope='selection_pipeline_incomplete'),
                  gate_policy=GATE_POLICY,production_asset_snapshot=deepcopy(asset_config),
                  production_asset_fingerprint=mapped.get('production_asset_fingerprint'),
                  production_config=base,source_artifacts={str(p):sha for p,sha in protected.items()})
    prop_outer,prod_outer,is_metrics = [],[],[]
    def verify_artifacts():
        for path, sha in protected.items():
            if file_sha(path) != sha:
                raise ValueError(f'frozen artifact/source tamper: {path}')
    try:
        discovery = worker.init(ticker,str(log_dir),timesfm_cache=cache)
        coverage = discovery['m5_coverage']
        plan = build_wfa_plan(ticker,coverage['from_ms'],coverage['to_ms'],policy=policy)
        plan_path = write_json(run_dir/'wfa_plan.json',plan)
        protected[plan_path] = file_sha(plan_path)
        init = worker.init(ticker,str(log_dir),timesfm_cache=cache,wfa_plan=plan)
        report.update(plan=plan,vault={**plan['vault'],'evaluated':False},worker_init=init,
                      coverage=dict(expected=len(plan['folds']),evaluated=0))
        # Final fit uses only registered history BEFORE Vault. It is not another
        # outer fold and has no evaluator for the reserved future interval.
        for fold in [*plan['folds'],resolve_fold(plan,0)]:
            fold_dir = run_dir/f"fold-{fold['id']}"; fold_dir.mkdir()
            fr = dict(id=fold['id'],status='HOLD_INSUFFICIENT_DATA',windows=fold)
            if fold['id']==0:
                report['final_candidate']=fr
            else:
                report['folds'].append(fr)
            try:
                verify_artifacts()
                baseline_model = None
                if not skip_ml or base.get('mlGateEnabled') is True:
                    from scripts import train_ml_model as trainer
                    explicit = (base.get('mlGate') or {}).get('modelPath')
                    baseline_model, model_path = trainer.load_current_model(ticker,explicit=explicit)
                    if model_path:
                        protected[Path(model_path).resolve()] = file_sha(model_path)
                    meta = (baseline_model or {}).get('meta',{})
                    known = (type(meta.get('available_at_ms')) is int and meta['available_at_ms'] <= fold['is_end_ms']
                             and type(meta.get('train_end_ms')) is int and meta['train_end_ms'] <= fold['is_end_ms'])
                    if base.get('mlGateEnabled') is True and not known:
                        fr.update(status='HOLD_BASELINE_MODEL_UNKNOWN',reason='baseline unavailable as of fold IS end')
                        continue
                identity = dict(plan=plan['fingerprint'],fold=fold,base=base,worker=init,
                                source_artifacts={str(p):sha for p,sha in protected.items()},
                                sampler={'name':'TPESampler','seed':42},schema='existing_suggest_params_34',
                                objective=objective_policy(),policy=plan['policy'])
                identity_hash = fingerprint(identity)
                study = optuna.create_study(direction='maximize',study_name=f'wfa_{ticker}_{fold["id"]}_{identity_hash}',
                    storage=f'sqlite:///{fold_dir/"study.sqlite3"}',sampler=optuna.samplers.TPESampler(seed=42))
                study.set_user_attr('identity',identity)
                def objective(trial):
                    verify_artifacts()
                    params = suggest_params(trial)
                    candidate = build_backtest_config(ticker,params,base_config=deepcopy(base))
                    try:
                        result = checked_window(worker,candidate,plan,fold,'inner_train')
                    except NoContext as exc:
                        trial.set_user_attr('status','HOLD_NO_CONTEXT')
                        raise optuna.TrialPruned(str(exc))
                    trial.set_user_attr('effective_config',result['effective_config'])
                    trial.set_user_attr('metrics',result['metrics'])
                    trial.set_user_attr('evaluation_fingerprint',result['evaluation_fingerprint'])
                    return result['selection_objective']
                study.optimize(objective,n_trials=n_trials)
                complete = [t for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE]
                fr['optimization'] = dict(completed=len(complete),pruned=sum(t.state == optuna.trial.TrialState.PRUNED for t in study.trials),
                    attempted=len(study.trials),identity=identity_hash,dimensions=len(study.trials[0].params),selector='legacy_v1',
                    objective_values=[t.value for t in complete])
                if not complete:
                    raise NoContext('HOLD_NO_CONTEXT: no completed selection trials')
                winner = deepcopy(study.best_trial.user_attrs['effective_config'])
                train = checked_window(worker,winner,plan,fold,'inner_train')
                if train['config_fingerprint'] != fingerprint(winner) or train['selection_objective'] != study.best_value:
                    raise ValueError('winner reevaluation diverged from selected trial')
                candidate = deepcopy(train['effective_config'])
                if not skip_aux:
                    candidate,fr['auxiliary'] = run_auxiliary(ticker,fold,train,candidate,asset_path,log_dir,fold_dir,trigger_budget)
                else:
                    fr['auxiliary'] = dict(skipped=True)
                ml = dict(status='SKIPPED',paired_eligible=False)
                replay_model = None
                is_candidate = deepcopy(candidate)
                if not skip_ml:
                    from scripts.periodic_opt.wfa_ml import train_fold_candidate
                    unfiltered = deepcopy(candidate);unfiltered['mlGateEnabled']=False;unfiltered['mlGate']={'enabled':False}
                    ml_train = checked_window(worker,unfiltered,plan,fold,'inner_train')
                    ml_val = checked_window(worker,unfiltered,plan,fold,'inner_validation')
                    ml = train_fold_candidate(ticker=ticker,fold=fold,plan_fingerprint=plan['fingerprint'],
                        inner_train=ml_train['closed_trades'],inner_validation=ml_val['closed_trades'],config=unfiltered,
                        output_path=fold_dir/'ml_candidate.json',old_model=baseline_model)
                    if ml.get('replay_model'):
                        model_path = Path(ml['replay_model']['model_path'])
                        protected[model_path] = ml['replay_model']['model_sha256']
                    if base.get('mlGateEnabled') is True and ml['paired_eligible']:
                        replay_model = ml['replay_model']
                        candidate['mlGate'] = dict(enabled=True,modelPath=replay_model['model_path'])
                        is_candidate['mlGateEnabled']=False;is_candidate['mlGate']={'enabled':False}
                        fr['wfe_comparable']=False
                    elif base.get('mlGateEnabled') is not True:
                        ml['candidate_use']='unused_model_permission_off'
                fr['ml'] = ml
                # Re-evaluate the fully assembled strategy on inner train before freeze.
                assembled_train = checked_window(worker,is_candidate,plan,fold,'inner_train')
                is_candidate = deepcopy(assembled_train['effective_config'])
                if replay_model is None:
                    candidate = deepcopy(is_candidate)
                frozen = dict(candidate=deepcopy(candidate),production=deepcopy(base),is_diagnostic=is_candidate,
                              replay_model=replay_model,plan_fingerprint=plan['fingerprint'],fold_id=fold['id'])
                frozen_path = write_json(fold_dir/'frozen.json',frozen)
                protected[frozen_path] = file_sha(frozen_path)
                fr['frozen'] = dict(path=str(frozen_path),sha256=protected[frozen_path],**frozen)
                verify_artifacts()
                if fold['id']==0:
                    fr.update(status='FROZEN_AWAITING_VAULT',vault_evaluated=False,
                              apply_eligible=False,changes_production=False)
                    continue
                prop_is = checked_window(worker,is_candidate,plan,fold,'is')
                verify_artifacts()
                production = checked_window(worker,base,plan,fold,'outer_oos')
                verify_artifacts()
                proposal = checked_window(worker,candidate,plan,fold,'outer_oos',replay_model=replay_model)
                verify_artifacts()
                fr.update(status='OK',prop_is=prop_is,prop_oos=proposal,prod_oos=production,
                          wfe_comparable=fr.get('wfe_comparable',True))
                is_metrics.append(prop_is['metrics']);prop_outer.append(proposal);prod_outer.append(production)
                report['coverage']['evaluated'] += 1
            except NoContext as exc:
                fr.update(status='HOLD_NO_CONTEXT',reason=str(exc))
        if prop_outer:
            prop, prod = stitch(prop_outer), stitch(prod_outer)
            # IS windows overlap by design: summarize a weighted diagnostic, not stitched IS returns.
            total = sum(m['trade_count'] for m in is_metrics)
            is_summary = dict(trade_count=total,net_pnl_r=sum(m['net_pnl_r'] for m in is_metrics),
                              expectancy=sum(m['net_pnl_r'] for m in is_metrics)/total if total else 0.,
                              max_drawdown_r=max(m['max_drawdown_r'] for m in is_metrics))
            prop_metric,prod_metric = asdict(compute_metrics(prop)),asdict(compute_metrics(prod))
            paired = calendar_pair(prop,prod,[r['window'] for r in prop_outer])
            mc_prop = stationary_bootstrap([t['rMultiple'] for t in prop])
            mc_prod = stationary_bootstrap([t['rMultiple'] for t in prod])
            paired_result = paired_calendar_bootstrap(paired['prop'],paired['prod'])
            gates = evaluate_wfa_gates(is_summary,prop_metric,prod_metric,[r['metrics'] for r in prop_outer],
                                      report['dsr'],mc_prop,mc_prod,paired_result=paired_result)
            report.update(stitched=dict(proposal=prop,production=prod,prop_metrics=prop_metric,prod_metrics=prod_metric),
                          is_diagnostic=is_summary,mc_proposal=mc_prop,mc_production=mc_prod,
                          paired_calendar=paired,paired_bootstrap=paired_result,gates=gates,status=gates['status'])
        reasons = [dict(fold_id=f['id'],status=f['status'],reason=f.get('reason')) for f in report['folds'] if f['status']!='OK']
        report['incomplete_folds']=reasons
        if reasons or report['coverage']['evaluated'] != report['coverage']['expected']:
            report['status']='HOLD_INSUFFICIENT_DATA'
        if report.get('final_candidate',{}).get('status')!='FROZEN_AWAITING_VAULT':
            report['status']='HOLD_INSUFFICIENT_DATA'
        if any(f.get('wfe_comparable') is False for f in report['folds']):
            report['status']='HOLD_WFE_MODEL_INCOMPARABLE'
        verify_artifacts()
    finally:
        worker.close()
    report['apply_eligible']=False
    report['changes_production']=False
    report_path = output_dir/'reports'/f'{ticker}.wfa.json'
    report['report_path']=str(report_path)
    # Atomic report replacement; unique run artifacts remain immutable.
    temp_report = write_json(run_dir/'report.json',report)
    report_path.parent.mkdir(parents=True,exist_ok=True)
    os.replace(temp_report,report_path)
    return report


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ticker',required=True)
    parser.add_argument('--config-file',required=True,type=Path)
    parser.add_argument('--log-dir',type=Path)
    parser.add_argument('--output-dir',required=True,type=Path)
    parser.add_argument('--n-trials',type=int,default=1)
    parser.add_argument('--trigger-budget',type=int,default=1)
    parser.add_argument('--policy-file',type=Path)
    parser.add_argument('--skip-aux',action='store_true')
    parser.add_argument('--skip-ml',action='store_true')
    args=parser.parse_args(argv)
    try:
        result=run_wfa_shadow(ticker=args.ticker,log_dir=args.log_dir or REPO/'logs'/args.ticker.lower()/'history_exported',
            asset_config=json.loads(args.config_file.read_text()),output_dir=args.output_dir,n_trials=args.n_trials,
            trigger_budget=args.trigger_budget,skip_aux=args.skip_aux,skip_ml=args.skip_ml,
            policy=json.loads(args.policy_file.read_text()) if args.policy_file else None)
    except Exception as exc:
        print(json.dumps(dict(status='ERROR',reason=str(exc),apply_eligible=False)),file=sys.stderr)
        return 1
    print(json.dumps(result,allow_nan=False))
    return 0


if __name__=='__main__':
    sys.exit(main())
