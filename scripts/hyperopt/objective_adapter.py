"""Canonical Python scoring boundary. Experimental scores never reach Optuna.

TS retains a legacy compatibility value for direct clients, not a second selector.
Every RPC value is checked against the canonical implementation. Test evidence
keeps its original metrics payload/fingerprint; extended Test statistics are separate.
"""
from __future__ import annotations
import copy
import hashlib
import json
import math
from pathlib import Path
import statistics
from typing import Iterable
import metrics as canonical_metrics
from evaluation_protocol import load_evaluation_manifest

SCORING_PATHS=(Path(canonical_metrics.__file__).resolve(),Path(__file__).resolve())
LOADED_SCORING_HASHES={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in SCORING_PATHS}


def objective_policy() -> dict:
    return copy.deepcopy(canonical_metrics.OBJECTIVE_POLICY)


def assert_scoring_snapshot(provenance: dict | None = None) -> None:
    for filename,digest in LOADED_SCORING_HASHES.items():
        if hashlib.sha256(Path(filename).read_bytes()).hexdigest()!=digest:
            raise ValueError('canonical scoring source changed after Python import; restart evaluation')
    if provenance is not None:
        worker_hashes={item['path']:item['sha256'] for item in provenance.get('source_files',[])}
        if any(worker_hashes.get(p)!=h for p,h in LOADED_SCORING_HASHES.items()):
            raise ValueError('Python loaded scoring snapshot differs from worker provenance')


def _finite_number(value) -> bool:
    return type(value) in (int,float) and math.isfinite(value)


def _assert_legacy_parity(worker: dict, canonical: dict, partition: str) -> None:
    required=('trade_count','wins','losses','win_rate','gross_profit_r','gross_loss_r',
              'net_pnl_r','profit_factor','expectancy','max_drawdown_r','sharpe_simple',
              'avg_trade_r','max_consec_losses','max_consec_wins')
    for key in (*required,*(['profit_factor_capped'] if 'profit_factor_capped' in worker else [])):
        actual=worker.get(key); expected=canonical[key]
        if (not _finite_number(actual) or not _finite_number(expected)
                or not math.isclose(actual,expected,rel_tol=1e-11,abs_tol=1e-11)):
            raise ValueError(f'legacy metrics parity mismatch: {partition}.{key}')


def canonicalize_result(result: dict) -> dict:
    """Pure copy; requires v1 closed-record transport and declared fixed windows."""
    assert_scoring_snapshot(result.get('provenance') if 'provenance' in result else None)
    if result.get('trade_records_version')!=1:
        raise ValueError('closed metric records v1 required for canonical scoring')
    manifest=load_evaluation_manifest(result['evaluation_manifest'],result['evaluation_manifest']['ticker'])
    out=copy.deepcopy(result)
    bounds={'train':(manifest['from_ms'],manifest['train_end_ms']),
            'validation':(manifest['train_end_ms'],manifest['validation_end_ms']),
            'test':(manifest['validation_end_ms'],manifest['test_end_ms'])}
    partitions=['train','validation']+(['test'] if 'metrics_test' in result else [])
    for partition in partitions:
        records=result[f'{partition}_trades']
        if not isinstance(records,list):
            raise ValueError(f'{partition}: closed records must be an array')
        start,end=bounds[partition]
        for trade in records:
            if (not isinstance(trade,dict) or trade.get('label_status')!='closed'
                    or not all(_finite_number(trade.get(k)) for k in ('rMultiple','timestamp','closeTimestamp'))
                    or not start<=trade['timestamp']<=trade['closeTimestamp']<end):
                raise ValueError(f'{partition}: invalid confirmed close or temporal boundary')
        # Monte Carlo must consume the same realization as canonical metrics,
        # including chronological close order and stable ties; reject, never repair.
        ordered=sorted(enumerate(records),key=lambda row:
                       (row[1]['closeTimestamp'],row[1]['timestamp'],row[0]))
        returns=[trade['rMultiple'] for _,trade in ordered]
        series_keys=[f'{partition}_r']
        if partition=='validation':
            series_keys.append('oos_r')
        for key in series_keys:
            if key not in result and key in ('train_r','oos_r'):
                continue  # optional compatibility series; required series fail closed
            series=result.get(key)
            if (not isinstance(series,list) or len(series)!=len(returns)
                    or any(not _finite_number(value) or value!=expected
                           for value,expected in zip(series,returns))):
                raise ValueError(f'{key}: return series must match canonical closed records exactly')
        computed=canonical_metrics.compute_metrics(records,time_bounds=(start,end) if end>start else None)
        serialized=canonical_metrics.to_dict(computed)
        _assert_legacy_parity(result[f'metrics_{partition}'],serialized,partition)
        if partition=='test':
            # Do not invalidate the original TS-signed metrics_fingerprint.
            out['metrics_test_canonical']=serialized
        else:
            out[f'metrics_{partition}']=serialized
        if partition=='train':
            legacy=canonical_metrics.objective_function(computed)
            if (not _finite_number(result.get('objective')) or not _finite_number(legacy)
                    or not math.isclose(result['objective'],legacy,rel_tol=1e-11,abs_tol=1e-11)):
                raise ValueError('legacy objective parity mismatch')
            out.update(objective_worker_legacy=result['objective'],objective=legacy,
                       objective_version=canonical_metrics.OBJECTIVE_VERSION,
                       objective_authority='scripts/hyperopt/metrics.py',
                       objective_policy=objective_policy(),
                       objective_shadow=canonical_metrics.shadow_objective(computed),
                       shadow_consumed_by_sampler=False)
    out['metrics']=out['metrics_train']
    out['metrics_oos']=out['metrics_validation']
    json.dumps(out,allow_nan=False)  # reject non-finite diagnostics as well as active metrics
    return out


def posthoc_shadow_comparison(trials: Iterable, *, legacy_best_number: int, total_trials: int|None=None) -> dict:
    """Re-score completed Train metrics with ONE reference, only after selection.

    This diagnoses the Optuna selector only. It is not a DSR certification of the
    assembled weekly candidate (GA/KS/bias/Validation are additional selections).
    Missing/constant Sharpe observations disable the common dispersion estimate.
    """
    trials=list(trials)
    sharpes=[t.user_attrs.get('metrics_train',{}).get('sharpe_per_trade') for t in trials]
    complete_dispersion=len(sharpes)>1 and all(_finite_number(x) for x in sharpes)
    sigma=statistics.stdev(sharpes) if complete_dispersion else None
    reference=dict(n_trials_reference=len(trials),trials_sr_std=sigma)
    rows=[]
    for trial in trials:
        metrics=canonical_metrics.TradeMetrics(**trial.user_attrs['metrics_train'])
        shadow=canonical_metrics.shadow_objective(metrics,**reference)
        rows.append(dict(trial_number=trial.number,legacy_value=trial.value,shadow=shadow))
    eligible=[row for row in rows if row['shadow']['eligible'] and _finite_number(row['shadow']['score'])]
    best=max(eligible,key=lambda row:(row['shadow']['score'],-row['trial_number'])) if eligible else None
    return dict(active_version=canonical_metrics.OBJECTIVE_VERSION,
                shadow_version=canonical_metrics.SHADOW_VERSION,
                legacy_selected_trial=legacy_best_number,
                shadow_best_trial_number=best['trial_number'] if best else None,
                changes_selection=False,final_pipeline_dsr_certified=False,
                reference={**reference,'completed_trials':len(trials),
                           'total_trials':len(trials) if total_trials is None else total_trials,
                           'dispersion_complete':complete_dispersion,'scope':'optuna_train_only',
                           'assumptions':['trial independence is a modeling approximation',
                                          'failed trials and GA/KS/bias/Validation selections are not calibrated']},
                objective_policy=objective_policy(),trials=rows)
