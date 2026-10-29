#!/usr/bin/env python3
"""Reopen PM2 diagnostic logs; refuse compression while an archive is open.
Does not import trading code, signal/restart apps, truncate files or delete data.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def archive_holders(directory):
    directory = Path(directory)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('archive directory must be a real directory')
    identities = set()
    for file in directory.iterdir():
        if file.is_symlink():
            raise ValueError('symlink in archive directory')
        if file.is_file() and not file.name.endswith('.gz'):
            info = file.stat()
            identities.add((info.st_dev, info.st_ino))
    holders = []
    for process in Path('/proc').glob('[0-9]*'):
        try:
            for fd in (process / 'fd').iterdir():
                try:
                    info = fd.stat()
                    if (info.st_dev, info.st_ino) in identities:
                        holders.append({'pid': int(process.name), 'fd': fd.name})
                except (FileNotFoundError, PermissionError, ProcessLookupError):
                    pass
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    return holders


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-dir', required=True)
    args = parser.parse_args()
    directory = Path(args.archive_dir).resolve(strict=True)
    if directory not in (Path('/root/.pm2/logs/rotated'), Path('/root/.pm2/logs/initial-archive')):
        raise ValueError('only approved PM2 diagnostic archive directories are permitted')
    pid = int(Path('/root/.pm2/pm2.pid').read_text().strip())
    if not Path(f'/proc/{pid}').is_dir():
        raise RuntimeError('PM2 daemon is not running; will not create a new daemon')
    env = {**os.environ, 'PM2_HOME': '/root/.pm2',
           'PATH': '/root/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin'}
    result = subprocess.run(['/usr/local/bin/pm2', 'reloadLogs'], env=env,
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('PM2 could not reopen diagnostic logs: ' + result.stderr[-1000:])
    deadline = time.monotonic() + 15
    while True:
        holders = archive_holders(directory)
        if not holders:
            print(json.dumps({'pm2_log_reopen': 'verified', 'archive_dir': str(directory),
                              'app_restart_requested': False}), flush=True)
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('refusing compression: archived logs are still open: ' + json.dumps(holders))
        time.sleep(0.2)


if __name__ == '__main__':
    main()
