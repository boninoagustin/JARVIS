#!/usr/bin/env python3
"""Read-only post-activation gate monitoring. Writes local audit/cache only."""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'data/ml_gate_monitor'
STATUS = CACHE / 'status.json'
SHARED_LOCK = ROOT / 'data/ml_calibration/worker.lock'
WEEK_MS = 7 * 24 * 3600 * 1000
RECENT_MS = 28 * 24 * 3600 * 1000
POLICY = {'version': 1, 'minimumPerArm': 30, 'recentDays': 28,
          'negativeDeltaR': -2, 'severeDeltaR': -5, 'severeAdditionalDrawdownR': 2,
          'confirmationAssessments': 2, 'minimumConfirmationSpacingMs': WEEK_MS,
          'requireNewCompletedTradesForConfirmation': True, 'maximumDataAgeMs': WEEK_MS,
          'automaticAction': False}


def now():
    return int(time.time() * 1000)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, allow_nan=False))
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {} if default is None else default


def integer(value):
    return type(value) is int and value > 0


def finite(value):
    return type(value) in (float, int) and math.isfinite(value)


class MonitorIssue(ValueError):
    def __init__(self, state, reason):
        self.state = state
        super().__init__(reason)


def validate_activation(ticker, asset):
    if asset.get('gateEnabled') is not True:
        raise MonitorIssue('INACTIVE', 'Gate ML apagado; no se realizan evaluaciones')
    if asset.get('trade') is not True:
        raise MonitorIssue('NOT_TRADE', 'Activo fuera de TRADE; sin evaluación de operativa')
    ref, record = asset.get('ref') or {}, asset.get('activation') or {}
    deployment = asset.get('deployment')
    if (ref.get('enabled') is not True or not isinstance(ref.get('activationId'), str)
            or record.get('activationId') != ref['activationId'] or record.get('ticker') != ticker
            or record.get('schemaVersion') != 1 or record.get('source') != 'dashboard_requested'
            or record.get('status') != 'requested' or not integer(record.get('requestedAtMs'))):
        raise MonitorIssue('NEEDS_ACTIVATION_RECORD', 'Falta registro inmutable de solicitud de activación; no se infiere una fecha histórica')
    if (not isinstance(deployment, dict) or deployment.get('schemaVersion') != 2
            or not re.fullmatch('[a-f0-9]{64}', str(deployment.get('modelSha256', '')))
            or not finite(deployment.get('threshold')) or not 0 < deployment['threshold'] < 1):
        raise MonitorIssue('INVALID_DEPLOYMENT', 'Despliegue ML sin identidad/umbral verificables')
    if canonical(deployment) != canonical(record.get('deployment')):
        raise MonitorIssue('ACTIVATION_MISMATCH', 'El despliegue actual no coincide con la solicitud; se requiere nueva activación registrada')
    fingerprint = record.get('configFingerprint')
    if (asset.get('snapshotError') or not isinstance(fingerprint, str)
            or fingerprint != asset.get('configFingerprint')
            or fingerprint != record.get('snapshotFingerprint')
            or deployment.get('configFingerprint') != fingerprint):
        raise MonitorIssue('CONFIG_CHANGED', 'Configuración distinta de la activación; no se mezclan resultados de estrategias diferentes')
    if not isinstance(asset.get('config'), dict) or not re.fullmatch('[a-f0-9]{64}', str(asset.get('strategyFingerprint', ''))):
        raise MonitorIssue('CONFIG_CHANGED', 'No se pudo congelar la configuración de estrategia')
    return ref['activationId'], record, deployment


def archive_model(ticker, asset, deployment, at):
    # Own-ticker filename only. No generic or candidate fallback and no mtime provenance.
    expected = ROOT / 'scripts/hyperopt/models' / f'ml_model_{ticker}.json'
    if Path(asset.get('modelPath', '')).resolve() != expected.resolve():
        raise MonitorIssue('MODEL_PATH_INVALID', 'El monitor solo admite el modelo propio del activo')
    try:
        raw = expected.read_bytes()
    except OSError:
        raise MonitorIssue('MODEL_MISSING', 'Modelo propio no disponible para archivar')
    identity = deployment['modelSha256']
    if sha(raw) != identity:
        raise MonitorIssue('MODEL_HASH_MISMATCH', 'Los bytes del modelo no coinciden con el despliegue; no se sustituye el modelo')
    try:
        meta = json.loads(raw).get('meta', {})
    except (ValueError, AttributeError):
        raise MonitorIssue('MODEL_PROVENANCE_UNKNOWN', 'Metadata del modelo inválida')
    if meta.get('ticker') != ticker:
        raise MonitorIssue('MODEL_PROVENANCE_UNKNOWN', 'El modelo archivado no declara el activo correcto')
    available, cutoff = meta.get('available_at_ms'), meta.get('train_end_ms')
    if not integer(available) or not integer(cutoff) or cutoff > available or available > at:
        raise MonitorIssue('MODEL_PROVENANCE_UNKNOWN', 'Se exige available_at_ms y train_end_ms autoritativos; no se usan mtime ni fechas inferidas')
    target = CACHE / 'models' / f'{identity}.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if sha(target.read_bytes()) != identity:
            raise MonitorIssue('ARCHIVE_CORRUPTED', 'El archivo inmutable del modelo cambió')
    else:
        with target.open('xb') as out:
            out.write(raw)
        target.chmod(0o600)
    return target, available


def create_epoch(ticker, activation_id, record, deployment, asset, engine_fingerprint, archive, available, at):
    identity = {'ticker': ticker, 'activationId': activation_id, 'modelSha256': deployment['modelSha256'],
                'threshold': deployment['threshold'], 'configFingerprint': record['configFingerprint'],
                'strategyFingerprint': asset['strategyFingerprint'], 'engineFingerprint': engine_fingerprint,
                'rulesVersion': POLICY['version']}
    epoch_id = sha(canonical(identity).encode())
    directory = CACHE / 'epochs' / epoch_id
    immutable = directory / 'epoch.json'
    if immutable.exists():
        base = read_json(immutable)
        if base.get('identity') != identity:
            raise MonitorIssue('EPOCH_CORRUPTED', 'Identidad de época inmutable alterada')
    else:
        directory.mkdir(parents=True, exist_ok=True)
        base = {'epochId': epoch_id, 'identity': identity, 'firstSeenMs': at,
                'fromMs': max(at, record['requestedAtMs'], available),
                'requestedAtMs': record['requestedAtMs'], 'modelAvailableAtMs': available,
                'runtimeAck': 'unknown', 'modelArchive': str(archive),
                'config': asset['config'], 'policy': POLICY}
        with immutable.open('x') as out:
            json.dump(base, out, allow_nan=False)
    if (not integer(base.get('firstSeenMs')) or base.get('fromMs') != max(base['firstSeenMs'], record['requestedAtMs'], available)):
        raise MonitorIssue('EPOCH_CORRUPTED', 'Inicio observado de la época alterado; no se retrocede el período')
    return base, directory


def metrics_valid(value):
    return (isinstance(value, dict) and type(value.get('n')) is int and value['n'] >= 0
            and all(finite(value.get(k)) for k in ('pnlR', 'mdd')) and value['mdd'] >= 0)


def classify(assessment, at):
    windows = assessment.get('windows') or {}
    pairs = [windows.get('cumulative'), windows.get('recent')]
    through = (assessment.get('provenance') or {}).get('dataThroughMs', assessment.get('dataThroughMs'))
    if assessment.get('dataStale') is True or assessment.get('dataStale7d') is True or not integer(through) or at - through > WEEK_MS:
        return 'INSUFFICIENT_DATA'
    for window in pairs:
        if not isinstance(window, dict) or not all(metrics_valid(window.get(k)) for k in ('baseline', 'active')):
            return 'INSUFFICIENT_DATA'
        if min(window['baseline']['n'], window['active']['n']) < POLICY['minimumPerArm']:
            return 'INSUFFICIENT_DATA'
        if not finite(window.get('deltaR')) or abs(window['deltaR'] - (window['active']['pnlR'] - window['baseline']['pnlR'])) > 1e-6:
            return 'INSUFFICIENT_DATA'
    if all(w['deltaR'] <= -5 and w['active']['mdd'] > w['baseline']['mdd'] + 2 for w in pairs):
        return 'DISABLE_SIGNAL'
    if all(w['deltaR'] <= -2 for w in pairs):
        return 'RECALIBRATE_SIGNAL'
    if all(w['deltaR'] > 0 and w['active']['mdd'] <= w['baseline']['mdd'] * 1.25 + 1 for w in pairs):
        return 'MAINTAIN'
    return 'OBSERVE'


def advise(assessment, previous, at):
    signal = classify(assessment, at)
    state = dict(previous or {})
    count = int(state.get('confirmationCount', 0))
    prior_signal = state.get('signal')
    last_counted = state.get('lastCountedAt', 0)
    cumulative = (assessment.get('windows') or {}).get('cumulative') or {}
    totals = {k: (cumulative.get(k) or {}).get('n', 0) for k in ('baseline', 'active')}
    through = (assessment.get('provenance') or {}).get('dataThroughMs', assessment.get('dataThroughMs'))
    negative = signal in ('RECALIBRATE_SIGNAL', 'DISABLE_SIGNAL')
    counted = False
    if not negative:
        count = 0
    elif at - last_counted >= WEEK_MS or last_counted == 0:
        old_totals = state.get('countedTotals') or {}
        advanced = (last_counted == 0 or (totals['baseline'] > old_totals.get('baseline', 0)
                    and totals['active'] > old_totals.get('active', 0)
                    and integer(through) and through > state.get('countedDataThroughMs', 0)))
        if advanced:
            count = min(2, count + 1) if signal == prior_signal else 1
            state.update(lastCountedAt=at, countedTotals=totals, countedDataThroughMs=through or 0)
            counted = True
    if signal != prior_signal and negative and not counted:
        count = 0
    recommendation = 'OBSERVE'
    if signal == 'INSUFFICIENT_DATA':
        recommendation = 'INSUFFICIENT_DATA'
    elif signal == 'MAINTAIN':
        recommendation = 'MAINTAIN'
    elif negative and count >= 2:
        recommendation = 'RECOMMEND_DISABLE' if signal == 'DISABLE_SIGNAL' else 'RECOMMEND_RECALIBRATE'
    elif negative:
        recommendation = 'OBSERVE_PENDING_CONFIRMATION'
    state.update(signal=signal, confirmationCount=count, recommendation=recommendation,
                 assessedAt=at, counted=counted, automaticAction=False, applyEligible=False)
    return state


def bounded_history(history, entry):
    all_rows = [*history, entry]
    confirmed = [r for r in all_rows if r.get('counted')][-64:]
    manual = [r for r in all_rows if not r.get('counted')][-40:]
    return sorted([*confirmed, *manual], key=lambda r: r['evaluatedAt'])


def snapshot():
    env = os.environ.copy()
    env['PATH'] = '/root/.nvm/versions/node/v24.19.0/bin:' + env.get('PATH', '')
    result = subprocess.run(['node', '--import', 'tsx', str(ROOT/'scripts/ml_monitor_snapshot.ts')], cwd=ROOT,
                            env=env, text=True, capture_output=True, check=True, timeout=180)
    return json.loads(result.stdout)


def replay(params):
    env = os.environ.copy()
    env['PATH'] = '/root/.nvm/versions/node/v24.19.0/bin:' + env.get('PATH', '')
    with tempfile.TemporaryDirectory(prefix='jarvis-monitor-') as directory:
        file = Path(directory)/'input.json'; file.write_text(json.dumps(params))
        result = subprocess.run(['node', '--import', 'tsx', str(ROOT/'scripts/ml_active_monitor.ts'), '--inputfile', str(file)],
                                cwd=ROOT, env=env, text=True, capture_output=True, check=True, timeout=660)
    marker = next((s for s in reversed(result.stdout.splitlines()) if s.startswith('ML_ACTIVE_MONITOR_RESULT=')), None)
    if marker is None:
        raise MonitorIssue('REPLAY_ERROR', 'Respuesta de replay de seguimiento ausente')
    return json.loads(marker.split('=', 1)[1])


def compare_candidate(asset, epoch, directory, deployment, until, at):
    info = asset.get('candidate') or {}
    unavailable = lambda reason: {'status': 'unavailable', 'reason': reason, 'automaticAction': False}
    if info.get('status') != 'eligible':
        return unavailable(info.get('reason', 'Sin selección de candidato comparable'))
    if info.get('modelSha256') == deployment['modelSha256']:
        return {'status': 'same_model', 'candidateSha256': deployment['modelSha256'], 'reason': 'El candidato es el modelo activo; no se inventa otra comparación'}
    if info.get('strategyFingerprint') != epoch['identity']['strategyFingerprint']:
        return unavailable('La configuración del candidato difiere de la del modelo activo')
    available, cutoff, selected_at = info.get('availableAtMs'), info.get('trainEndMs'), info.get('selectionAtMs')
    if not all(integer(v) for v in (available, cutoff, selected_at)) or cutoff > available or selected_at > at:
        return unavailable('Procedencia temporal del candidato/selección desconocida')
    try:
        candidate_path = Path(info['modelPath']).resolve()
        if not candidate_path.is_relative_to((ROOT/'data/ml_calibration/candidates').resolve()):
            return unavailable('Ruta del candidato fuera de candidatos aislados')
        raw = candidate_path.read_bytes()
        if sha(raw) != info.get('modelSha256'):
            return unavailable('Los bytes del candidato cambiaron')
        metadata = json.loads(raw).get('meta', {})
        if metadata.get('available_at_ms') != available or metadata.get('train_end_ms') != cutoff:
            return unavailable('La procedencia del candidato cambió')
        selection_id = info.get('selectionIdentity')
        if not re.fullmatch('[a-f0-9]{64}', str(selection_id)):
            return unavailable('Falta identidad de la selección de umbral')
        observed_file = directory / f'selection-{selection_id}.json'
        if observed_file.exists():
            observed = read_json(observed_file).get('firstSelectionObservedMs')
        else:
            observed = at
            with observed_file.open('x') as out:
                json.dump({'selectionIdentity': selection_id, 'firstSelectionObservedMs': observed}, out)
        if not integer(observed):
            return unavailable('Registro de observación de selección inválido')
        start = max(epoch['fromMs'], available, selected_at, observed)
        if start >= until:
            return unavailable('Sin historia posterior a la disponibilidad y primera observación verificada de la selección del candidato')
        archive = CACHE/'models'/f"{info['modelSha256']}.json"
        archive.parent.mkdir(parents=True, exist_ok=True)
        if archive.exists():
            if sha(archive.read_bytes()) != info['modelSha256']:
                return unavailable('Archivo del candidato alterado')
        else:
            with archive.open('xb') as out:
                out.write(raw)
            archive.chmod(0o600)
        common = {'ticker': asset['ticker'], 'activationId': epoch['identity']['activationId'], 'config': epoch['config'],
                  'fromMs': start, 'toMs': until, 'recentFromMs': max(start, until-RECENT_MS),
                  'dataDir': asset['dataDir'], 'engineFingerprint': epoch['identity']['engineFingerprint'],
                  'configFingerprint': epoch['identity']['strategyFingerprint']}
        active_result = replay(dict(common, modelPath=epoch['modelArchive'], modelSha256=deployment['modelSha256'], threshold=deployment['threshold']))
        candidate_result = replay(dict(common, modelPath=str(archive), modelSha256=info['modelSha256'], threshold=info['threshold']))
        for result, identity, threshold in ((active_result, deployment['modelSha256'], deployment['threshold']), (candidate_result, info['modelSha256'], info['threshold'])):
            if (result.get('status') != 'valid' or result.get('modelSha256') != identity or result.get('threshold') != threshold
                    or result.get('engineFingerprint') != epoch['identity']['engineFingerprint']
                    or result.get('configFingerprint') != epoch['identity']['strategyFingerprint']):
                return unavailable('Uno de los replays del período común no es verificable')
        a, c = active_result['windows']['cumulative'], candidate_result['windows']['cumulative']
        if (active_result.get('dataThroughMs') != candidate_result.get('dataThroughMs')
                or active_result.get('provenance', {}).get('datasetFiles') != candidate_result.get('provenance', {}).get('datasetFiles')
                or active_result.get('provenance', {}).get('auxiliaryFiles') != candidate_result.get('provenance', {}).get('auxiliaryFiles')):
            return unavailable('Los datos/snapshots de los replays no coinciden')
        if (a['fromMs'], a['toMs'], a['baseline']) != (c['fromMs'], c['toMs'], c['baseline']):
            return unavailable('La referencia sin gate o el período difieren entre comparaciones')
        if any(not metrics_valid(m) for m in (a['baseline'], a['active'], c['active'])):
            return unavailable('Métricas incompletas para comparar los tres brazos')
        sufficient = (min(a['baseline']['n'], a['active']['n'], c['active']['n']) >= 30
                      and active_result.get('dataStale') is not True and candidate_result.get('dataStale') is not True)
        return {'status': 'valid' if sufficient else 'insufficient', 'fromMs': a['fromMs'], 'toMs': a['toMs'],
                'baseline': a['baseline'], 'active': a['active'], 'candidate': c['active'],
                'deltaActiveR': a['active']['pnlR']-a['baseline']['pnlR'], 'deltaCandidateR': c['active']['pnlR']-a['baseline']['pnlR'],
                'candidateSha256': info['modelSha256'], 'threshold': info['threshold'], 'firstSelectionObservedMs': observed,
                'selectedAtMs': selected_at, 'evaluatedAt': at, 'activeModelSha256': deployment['modelSha256'],
                'epochId': epoch['epochId'], 'activeEpochId': epoch['epochId'],
                'engineFingerprint': epoch['identity']['engineFingerprint'], 'configFingerprint': epoch['identity']['strategyFingerprint'],
                'provenance': {'datasetFiles': active_result.get('provenance', {}).get('datasetFiles'), 'dataThroughMs': active_result.get('dataThroughMs')},
                'reason': 'Comparación en el mismo período posterior; requiere revisión manual, no autoriza reemplazo' if sufficient else 'Mínimo 30 operaciones en los tres brazos; no hay recomendación de reemplazo',
                'automaticAction': False, 'applyEligible': False}
    except Exception as exc:
        return unavailable(str(exc)[:500])


def assess_asset(ticker, asset, engine_fingerprint, at):
    row = {'ticker': ticker, 'gateEnabled': asset.get('gateEnabled') is True,
           'runtimeAck': 'unknown', 'automaticAction': False, 'applyEligible': False,
           'candidateComparison': {'status': 'unavailable', 'reason': 'No se mezclan resultados retrospectivos de candidatos; requieren comparación separada con el mismo período post-activación y procedencia válida.'}}
    activation_id, record, deployment = validate_activation(ticker, asset)
    archive, available = archive_model(ticker, asset, deployment, at)
    epoch, directory = create_epoch(ticker, activation_id, record, deployment, asset, engine_fingerprint, archive, available, at)
    row.update(activationId=activation_id, epochId=epoch['epochId'], firstSeenMs=epoch['firstSeenMs'], fromMs=epoch['fromMs'],
               requestedAtMs=record['requestedAtMs'], modelSha256=deployment['modelSha256'], threshold=deployment['threshold'],
               activationConfigFingerprint=record['configFingerprint'], currentConfigFingerprint=asset['configFingerprint'])
    until = asset.get('dataAvailableToMs')
    if not integer(until) or until <= epoch['fromMs']:
        row.update(state='NO_DATA', recommendation='INSUFFICIENT_DATA', reason='Sin datos históricos posteriores al inicio verificado del seguimiento; no se inventa PnL cero')
        return row
    if at - until > WEEK_MS:
        row.update(state='STALE_DATA', recommendation='INSUFFICIENT_DATA', reason='La historia disponible tiene más de siete días de atraso')
        return row
    until = min(until, at)
    result = replay({'ticker': ticker, 'activationId': activation_id, 'modelPath': str(archive),
        'modelSha256': deployment['modelSha256'], 'threshold': deployment['threshold'], 'config': epoch['config'],
        'fromMs': epoch['fromMs'], 'toMs': until, 'recentFromMs': max(epoch['fromMs'], until-RECENT_MS), 'dataDir': asset['dataDir'],
        'engineFingerprint': engine_fingerprint, 'configFingerprint': asset['strategyFingerprint']})
    if (result.get('schemaVersion') != 1 or result.get('scope') != 'post_activation_replay'
            or result.get('ticker') != ticker or result.get('activationId') != activation_id
            or result.get('modelSha256') != deployment['modelSha256'] or result.get('threshold') != deployment['threshold']
            or result.get('engineFingerprint') != engine_fingerprint or result.get('configFingerprint') != asset['strategyFingerprint']
            or result.get('rules', {}).get('version') != POLICY['version']):
        raise MonitorIssue('REPLAY_CONTEXT_MISMATCH', 'El replay no coincide con la época/configuración/modelo solicitados')
    if result.get('status') != 'valid':
        row.update(state='REPLAY_UNAVAILABLE', recommendation='INSUFFICIENT_DATA', reason=result.get('reason', 'Replay no disponible'), assessment=result)
        return row
    windows = result.get('windows') or {}
    cumulative, recent = windows.get('cumulative') or {}, windows.get('recent') or {}
    effective_to = cumulative.get('toMs')
    if (cumulative.get('fromMs') != epoch['fromMs'] or not integer(effective_to) or effective_to > until
            or effective_to <= epoch['fromMs'] or recent.get('toMs') != effective_to
            or recent.get('fromMs') != max(epoch['fromMs'], effective_to-RECENT_MS)):
        raise MonitorIssue('REPLAY_CONTEXT_MISMATCH', 'Períodos del replay no coinciden con la época observada')
    row['candidateComparison'] = compare_candidate(asset, epoch, directory, deployment, effective_to, at)
    old = read_json(directory/'state.json')
    advice = advise(result, old.get('advice'), at)
    entry = {'evaluatedAt': at, 'epochId': epoch['epochId'], 'assessment': result, **advice}
    history = bounded_history(old.get('history', []), entry)
    atomic_json(directory/'state.json', {'advice': advice, 'history': history, 'updatedAt': at})
    row.update(state='ASSESSED', recommendation=advice['recommendation'], reason=result.get('reason', ''), assessment=result,
               confirmationCount=advice['confirmationCount'], signal=advice['signal'], lastAssessedAt=at,
               confirmationState=advice, history=history[-12:])
    return row


def refresh():
    previous_assets = read_json(STATUS, {'assets': {}}).get('assets', {})
    snap = snapshot(); at = now()
    fingerprint = snap.get('engineFingerprint')
    if not re.fullmatch('[a-f0-9]{64}', str(fingerprint)):
        raise MonitorIssue('ENGINE_PROVENANCE_UNKNOWN', 'No se pudo congelar la identidad del motor')
    output = {'schemaVersion': 1, 'scope': 'post_activation_replay', 'state': 'RUNNING', 'startedAt': at,
              'policy': POLICY, 'assets': {}, 'activeGateCount': 0, 'automaticAction': False}
    atomic_json(STATUS, output)
    for ticker, asset in snap.get('assets', {}).items():
        if asset.get('gateEnabled') is True:
            output['activeGateCount'] += 1
        try:
            row = assess_asset(ticker, asset, fingerprint, at)
        except MonitorIssue as exc:
            row = {'ticker': ticker, 'gateEnabled': asset.get('gateEnabled') is True, 'state': exc.state,
                   'reason': str(exc), 'recommendation': 'INSUFFICIENT_DATA' if asset.get('gateEnabled') else 'INACTIVE',
                   'runtimeAck': 'unknown', 'automaticAction': False}
        except Exception as exc:
            row = {'ticker': ticker, 'state': 'ERROR', 'reason': str(exc)[:500], 'recommendation': 'INSUFFICIENT_DATA', 'automaticAction': False}
        prior_epoch = previous_assets.get(ticker, {}).get('epochId')
        if prior_epoch and re.fullmatch('[a-f0-9]{64}', prior_epoch) and row.get('epochId') != prior_epoch:
            event = {'evaluatedAt': at, 'state': row.get('state'), 'reason': row.get('reason', 'Nueva época de modelo/configuración/motor'), 'nextEpochId': row.get('epochId')}
            file = CACHE/'epochs'/prior_epoch/'invalidations.json'
            atomic_json(file, (read_json(file, [])+[event])[-64:])
            row['previousEpochId'] = prior_epoch
            row['epochReset'] = True
        output['assets'][ticker] = row
        atomic_json(STATUS, output)
    output.update(state='IDLE', updatedAt=now())
    atomic_json(STATUS, output)
    return output


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['refresh']); parser.parse_args()
    SHARED_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with SHARED_LOCK.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 3
        try:
            refresh(); return 0
        except Exception as exc:
            value = read_json(STATUS, {'schemaVersion': 1, 'assets': {}})
            value.update(state='ERROR', error=str(exc)[:500], updatedAt=now(), automaticAction=False)
            atomic_json(STATUS, value)
            return 1


if __name__ == '__main__':
    raise SystemExit(main())
