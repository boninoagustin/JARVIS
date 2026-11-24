#!/usr/bin/env python3
"""Fail-closed identity/evidence for a weekly cycle. Legacy empty PYDONE is NOT proof.
All commands except begin/complete are read-only. No Firebase or systemd writes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
from datetime import datetime, timezone

MAX_AGE_MS = 21 * 86400000

def read_json(path):
    return json.loads(Path(path).read_text())

def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    with tmp.open('w') as f:
        json.dump(value, f, sort_keys=True)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    if read_json(path) != value:
        raise ValueError('persistence readback mismatch')

def week_of(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%G-W%V')

def valid_week(week):
    if not isinstance(week, str) or not re.fullmatch(r'\d{4}-W\d{2}', week):
        raise ValueError('invalid ISO week')
    datetime.strptime(week + '-1', '%G-W%V-%u')
    return week

def tickers(value):
    if not isinstance(value, list) or not value or any(not isinstance(t, str) or not re.fullmatch(r'[A-Z0-9]+', t) for t in value) or len(set(value)) != len(value):
        raise ValueError('invalid/empty/duplicate ticker roster')
    return value

def positive_int(value):
    return type(value) is int and value > 0

def context(state_dir, now):
    c = read_json(Path(state_dir) / 'weekly_cycle_context.json')
    if c.get('version') != 1 or not positive_int(c.get('started_at')):
        raise ValueError('invalid cycle context')
    valid_week(c.get('week'))
    if c['week'] != week_of(c['started_at']):
        raise ValueError('cycle week does not match original start')
    if c['started_at'] > now + 60000 or now - c['started_at'] > MAX_AGE_MS:
        raise ValueError('cycle context future/expired (>21d)')
    if str(uuid.UUID(c.get('run_id', ''))) != c['run_id']:
        raise ValueError('invalid cycle run_id')
    tickers(c.get('tickers'))
    return c

def summary_evidence(c, summary_path, now):
    raw = Path(summary_path).read_bytes()
    s = json.loads(raw)
    if s.get('version') != 1 or s.get('cycle_run_id') != c['run_id'] or s.get('cycle_week') != c['week'] or s.get('started_at') != c['started_at']:
        raise ValueError('summary belongs to another cycle')
    end = s.get('completed_at')
    if not positive_int(end) or not c['started_at'] <= end <= now + 60000:
        raise ValueError('invalid summary completion time')
    if s.get('status') != 'completed' or s.get('errors') != [] or s.get('error'):
        raise ValueError('summary is not successfully completed')
    expected = set(tickers(c['tickers']))
    if set(tickers(s.get('tickers'))) != expected:
        raise ValueError('summary roster mismatch')
    outcomes = s.get('outcomes')
    if not isinstance(outcomes, list) or len(outcomes) != len(expected):
        raise ValueError('summary missing/duplicate outcomes')
    if {x.get('ticker') for x in outcomes} != expected:
        raise ValueError('summary outcome ticker mismatch')
    counts = {k: sum(x.get('outcome') == k for x in outcomes) for k in ('evaluated', 'skipped', 'failed')}
    bad = {'ERROR', 'HOLD_SELECTION_ERROR', 'HOLD_INTEGRITY', 'HOLD_ML_ERROR'}
    if counts != s.get('counts') or counts['failed'] or sum(counts.values()) != len(expected):
        raise ValueError('summary counts incomplete/failed')
    if any(not isinstance(x.get('status'), str) or not x['status'] or x['status'] in bad or x.get('deployment_error') for x in outcomes):
        raise ValueError('summary has invalid/error outcome or deployment error')
    if any(not positive_int(x.get('timestamp')) or not c['started_at'] <= x['timestamp'] <= end for x in outcomes):
        raise ValueError('outcome timestamp outside cycle')
    return {'version': 1, **{k: c[k] for k in ('week', 'run_id', 'started_at', 'tickers')},
            'completed_at': end, 'summary_sha256': hashlib.sha256(raw).hexdigest()}

def verify(state_dir, summary_path, now):
    c = context(state_dir, now)
    proof = summary_evidence(c, summary_path, now)
    saved = read_json(Path(state_dir) / ('weekly_python_done_' + c['week']))
    if saved != proof:
        raise ValueError('PYDONE receipt does not match context and summary')
    return c

def plan(state_dir, summary_path, progress_path, week, now, force=False):
    valid_week(week)
    state_dir = Path(state_dir)
    mark_path = state_dir / 'weekly_cycle_last'
    mark = mark_path.read_text().strip() if mark_path.exists() else ''
    if mark:
        valid_week(mark)
        if mark > week:
            raise ValueError('seal is newer than requested week')
    cp = state_dir / 'weekly_cycle_context.json'
    if cp.exists():
        c = context(state_dir, now)  # corrupt context requires operator inspection
        if c['week'] > week or (mark and mark > c['week']):
            raise ValueError('cycle context/mark ordering invalid')
        try:
            verify(state_dir, summary_path, now)
            completed = True
        except (ValueError, OSError, TypeError, KeyError):
            completed = False
        if completed:
            if mark != c['week']:
                return 'posts', c
            if c['week'] == week and not force:
                return 'skip', c
        else:
            if mark == c['week']:
                raise ValueError('sealed cycle has no valid evidence; inspect before continuing')
            # Resume only a checkpoint explicitly bound to this context (never timestamp-only).
            progress = Path(progress_path)
            if progress.exists():
                p = read_json(progress)
                if p.get('cycle_run_id') != c['run_id'] or p.get('cycle_week') != c['week'] or p.get('started_at') != c['started_at']:
                    raise ValueError('progress is not bound to the cycle context')
                return 'resume', c
            return 'run', c
    elif mark == week and not force:
        raise ValueError('legacy seal without cycle evidence; inspect before continuing')
    return 'new', None

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('action', choices=['plan', 'begin', 'complete', 'verify'])
    ap.add_argument('--state-dir', default='/var/lib/jarvis')
    ap.add_argument('--summary', default='/opt/JARVIS/scripts/periodic_opt/opt_out/weekly_selection_summary.json')
    ap.add_argument('--progress', default='/opt/JARVIS/scripts/periodic_opt/opt_out/weekly_progress.json')
    ap.add_argument('--week', default=week_of(int(time.time() * 1000)))
    ap.add_argument('--tickers-json')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()
    now = int(time.time() * 1000)
    try:
        if args.action in ('plan', 'begin'):
            action, c = plan(args.state_dir, args.summary, args.progress, args.week, now, args.force)
            if args.action == 'begin' and action != 'skip':
                roster = tickers(json.loads(args.tickers_json))
                if action == 'new':
                    c = {'version': 1, 'week': args.week, 'run_id': str(uuid.uuid4()), 'started_at': now, 'tickers': roster}
                    if week_of(now) != args.week:
                        raise ValueError('new cycle must start in its actual ISO week')
                elif set(roster) != set(c['tickers']):
                    raise ValueError('roster changed during unfinished cycle; explicit recovery required')
                c['invocation_id'] = os.environ.get('INVOCATION_ID', '')
                atomic_json(Path(args.state_dir) / 'weekly_cycle_context.json', c)
            print(json.dumps({'action': action, 'context': c}))
        elif args.action == 'complete':
            c = context(args.state_dir, now)
            proof = summary_evidence(c, args.summary, now)
            atomic_json(Path(args.state_dir) / ('weekly_python_done_' + c['week']), proof)
            print(json.dumps(verify(args.state_dir, args.summary, now)))
        else:
            print(json.dumps(verify(args.state_dir, args.summary, now)))
        return 0
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as e:
        print('cycle evidence invalid: ' + str(e), file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
