"""Isolated historical model reconstruction. Never promotes an active model."""
from __future__ import annotations


def prepare_fold_dataset(*, ticker, fold, plan_fingerprint, inner_train, inner_validation):
    from scripts import train_ml_model as trainer
    manifest = dict(version=1, ticker=ticker, from_ms=fold['is_start_ms'],
                    train_end_ms=fold['inner_train_end_ms'], validation_end_ms=fold['is_end_ms'],
                    test_end_ms=fold['is_end_ms'], test_independence='unverified')
    # v1's validation starts at train_end; the WFA embargo has a stricter start.
    for role, rows, start, end in (
        ('train', inner_train, fold['is_start_ms'], fold['inner_train_end_ms']),
        ('validation', inner_validation, fold['inner_validation_start_ms'], fold['is_end_ms'])):
        if not isinstance(rows, list):
            raise ValueError(f'{role} trades must be a list')
        for trade in rows:
            ts = trade.get('timestamp')
            if type(ts) is not int or not start <= ts < end:
                raise ValueError(f'{role} entry outside explicit WFA window')
    data = trainer.prepare_temporal_dataset(dict(train=inner_train, validation=inner_validation), manifest, ticker)
    data['embargo_ms'] = fold['inner_validation_start_ms'] - fold['inner_train_end_ms']
    data['dataset_source'] = dict(kind='wfa_closed_trades', plan_fingerprint=plan_fingerprint,
                                  fold_id=fold['id'], validation_start_ms=fold['inner_validation_start_ms'])
    return data


def train_fold_candidate(*, ticker, fold, plan_fingerprint, inner_train, inner_validation,
                         config, output_path, old_model=None):
    """Fit Train only; use paired internal Validation, never outer or Vault labels."""
    import hashlib
    import json
    from pathlib import Path
    from scripts import train_ml_model as trainer
    data = prepare_fold_dataset(ticker=ticker, fold=fold, plan_fingerprint=plan_fingerprint,
                                inner_train=inner_train, inner_validation=inner_validation)
    config = dict(config)
    config.pop('mlGate', None)
    config['mlGateEnabled'] = False
    try:
        export = trainer.train_candidate(data, Path(output_path), ticker, old_model, config, force=True)
    except trainer.InsufficientSamples as exc:
        return dict(status='HOLD_ML_SAMPLES', reason=str(exc), paired_eligible=False,
                    apply_eligible=False, counts=data['counts'])
    reconstruction = dict(version=1, fold_id=fold['id'], fit_asof_ms=fold['is_end_ms'],
                          train_label_end_ms=data['max_label_closed_at_ms']['train'],
                          selection_label_end_ms=data['max_label_closed_at_ms']['validation'],
                          plan_fingerprint=plan_fingerprint)
    export['meta']['wfa_reconstruction'] = reconstruction
    export['meta']['windows']['validation']['from_ms'] = fold['inner_validation_start_ms']
    export['meta']['windows']['validation']['from_utc'] = trainer.utc(fold['inner_validation_start_ms'])
    export['meta']['wfa_validation_policy'] = 'paired_precision_lift_heuristic_v1'
    import numpy as np
    rows = data['validation']
    X = np.array([[r[f] for f in trainer.FEATURE_NAMES] for r in rows])
    y = np.array([r['label'] for r in rows])
    threshold = trainer.validate_export(export)[1]
    baseline_wr = float(y.mean())
    comparisons = {}
    for name, model in [('candidate', export), ('current', old_model)]:
        if model is None:
            comparisons[name] = None
            continue
        metric = trainer.classification_metrics(y, trainer.predict_export(model, X), threshold)
        metric.update(pass_rate=metric['passed']/len(rows),
                      lift_vs_unfiltered=metric['precision']-baseline_wr)
        comparisons[name] = metric
    new, old = comparisons['candidate'], comparisons['current']
    meta = (old_model or {}).get('meta', {})
    known = (type(meta.get('available_at_ms')) is int and meta['available_at_ms'] <= fold['inner_validation_start_ms']
             and type(meta.get('train_end_ms')) is int and meta['train_end_ms'] <= fold['inner_train_end_ms'])
    eligible = bool(known and old and new['passed'] >= 8 and old['passed'] >= 8
                    and new['precision'] >= old['precision']
                    and new['lift_vs_unfiltered'] >= .03)
    comparison = dict(threshold=threshold, unfiltered_win_rate=baseline_wr, **comparisons,
                      eligible=eligible, heuristic=True, auto_promotion=False,
                      min_passed=8, precision_tolerance=0., minimum_lift=.03,
                      baseline_policy='available_before_internal_validation_and_trained_before_embargo',
                      backtest_net_r_separate=True, n=len(rows))
    export['meta']['wfa_paired_validation'] = comparison
    Path(output_path).write_text(json.dumps(export, indent=2, allow_nan=False))
    sha = hashlib.sha256(Path(output_path).read_bytes()).hexdigest()
    descriptor = dict(version=1, kind='historical_reconstruction', fold_id=fold['id'],
                      fit_asof_ms=fold['is_end_ms'], plan_fingerprint=plan_fingerprint,
                      model_path=str(Path(output_path).resolve()), model_sha256=sha)
    return dict(status='PROPOSE_SHADOW' if eligible else ('HOLD_BASELINE_MODEL_UNKNOWN' if not known else 'HOLD_ML_PAIRED'),
                paired_eligible=eligible, paired_validation=comparison, replay_model=descriptor,
                counts=data['counts'], reconstruction=reconstruction, apply_eligible=False)
