"""Actual logrotate retention/compression tests; all data is in private temp dirs."""
import datetime
import gzip
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

BASE = Path(__file__).resolve().parent / 'log_rotation'
spec = importlib.util.spec_from_file_location('pm2_log_reopen', '/opt/JARVIS/scripts/ops/pm2_log_reopen.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LogRetentionTests(unittest.TestCase):
    def test_open_archives_are_detected_until_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp)
            with (archive / 'diagnostic.log-old').open('w') as stream:
                stream.write('diagnostic data')
                stream.flush()
                self.assertTrue(any(item['pid'] == os.getpid() for item in module.archive_holders(archive)))
            self.assertEqual(module.archive_holders(archive), [])

    def test_symlink_archives_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp)
            (archive / 'link').symlink_to('/dev/null')
            with self.assertRaises(ValueError):
                module.archive_holders(archive)

    def exercise_rotation(self, initial=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            logs = root / 'logs'
            logs.mkdir()
            rotated = logs / ('initial-archive' if initial else 'rotated')
            rotated.mkdir()
            initial_archive = logs / 'protected-history'
            initial_archive.mkdir()
            protected = initial_archive / 'do-not-delete.gz'
            protected.write_bytes(gzip.compress(b'preserved initial diagnostic history'))
            names = ['JARVIS-out.log', 'JARVIS-error.log', 'JARVIS-OS-out.log', 'JARVIS-OS-error.log', 'KRONOS-API-out.log', 'KRONOS-API-error.log']
            contents = {}
            inodes = {}
            for name in names:
                file = logs / name
                contents[name] = ('complete '+name+'\n').encode()*500
                file.write_bytes(contents[name])
                inodes[name] = file.stat().st_ino
            for age in (29, 31):
                past = datetime.datetime.now()-datetime.timedelta(days=age)
                file = rotated / ('JARVIS-out.log-'+past.strftime('%Y%m%d-%H%M%S')+'.gz')
                file.write_bytes(gzip.compress(f'{age}-day diagnostic log'.encode()))
                os.utime(file, (past.timestamp(), past.timestamp()))
                if age == 29:
                    recent = file
                else:
                    expired = file
            config = (BASE / ('initial-logrotate.conf' if initial else 'pm2-logrotate.conf')).read_text()
            config = config.replace('/root/.pm2/logs', str(logs))
            start = config.index('    postrotate\n')
            end = config.index('    endscript\n', start)+len('    endscript\n')
            config = config[:start]+'    postrotate\n        /usr/bin/touch '+str(root/'postrotate-ran')+'\n    endscript\n'+config[end:]
            configuration = root / 'test.conf'
            configuration.write_text(config)
            configuration.chmod(0o600)
            result = subprocess.run(['/usr/sbin/logrotate', '--force', '--verbose', '--state', str(root/'state'), str(configuration)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
            self.assertTrue((root/'postrotate-ran').exists())
            self.assertTrue(recent.exists(), '29-day log must remain')
            self.assertEqual(expired.exists(), initial, '31-day log removed only from the regular retention directory')
            self.assertTrue(protected.exists(), 'initial history must remain outside normal retention')
            for name in names:
                active = logs/name
                self.assertEqual(active.read_bytes(), b'')
                self.assertNotEqual(active.stat().st_ino, inodes[name], 'rename/reopen, never copytruncate')
                matches = [p for p in rotated.glob(name+'-*.gz') if p not in (recent, expired)]
                self.assertEqual(len(matches), 1)
                self.assertEqual(gzip.decompress(matches[0].read_bytes()), contents[name])

    def test_real_rotation_compression_and_30_day_retention(self):
        self.exercise_rotation()

    def test_initial_archive_never_expires_in_first_cleanup(self):
        self.exercise_rotation(initial=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
