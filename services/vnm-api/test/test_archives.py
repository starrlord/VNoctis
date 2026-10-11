import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

INSPECT = Path(__file__).resolve().parents[1] / 'src/services/archive_inspect.py'
class ArchiveTests(unittest.TestCase):
    def setUp(self): self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def inspect(self, path, kind, env=None):
        return subprocess.run([sys.executable, str(INSPECT), str(path), kind], capture_output=True, text=True, env=env)
    def test_nested_zip_reports_folder_size_and_files(self):
        path = self.root / 'game.zip'
        with zipfile.ZipFile(path, 'w') as archive: archive.writestr('Game/game/script.rpy', 'hello')
        result = self.inspect(path, 'zip'); self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), dict(singleFolder='Game', files=1, bytes=5))
    def test_zip_traversal_absolute_paths_and_symlinks_are_rejected(self):
        for name in ['../escape', '/escape', 'Game/../escape', 'C:/escape', 'Game\\escape', 'Game//escape']:
            with self.subTest(name=name):
                path = self.root / 'unsafe.zip'
                with zipfile.ZipFile(path, 'w') as archive: archive.writestr(name, 'x')
                self.assertNotEqual(self.inspect(path, 'zip').returncode, 0)
        with zipfile.ZipFile(path, 'w') as archive:
            link = zipfile.ZipInfo('Game/link'); link.external_attr = (stat.S_IFLNK | 0o777) << 16; archive.writestr(link, '../outside')
        self.assertNotEqual(self.inspect(path, 'zip').returncode, 0)
    def test_tar_relative_prefix_allowed_but_links_rejected(self):
        path = self.root / 'game.tar.bz2'
        with tarfile.open(path, 'w:bz2') as archive:
            file = tarfile.TarInfo('./Game/game/script.rpy'); file.size = 1; archive.addfile(file, io.BytesIO(b'x'))
        self.assertEqual(json.loads(self.inspect(path, 'tar.bz2').stdout)['singleFolder'], 'Game')
        with tarfile.open(path, 'w:bz2') as archive:
            link = tarfile.TarInfo('Game/link'); link.type = tarfile.SYMTYPE; link.linkname = '../outside'; archive.addfile(link)
        self.assertNotEqual(self.inspect(path, 'tar.bz2').returncode, 0)
    def test_corrupt_empty_and_expansion_limits_fail_before_extraction(self):
        path = self.root / 'game.zip'; path.write_bytes(b'corrupt')
        self.assertNotEqual(self.inspect(path, 'zip').returncode, 0)
        with zipfile.ZipFile(path, 'w'): pass
        self.assertNotEqual(self.inspect(path, 'zip').returncode, 0)
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive: archive.writestr('Game/large', b'x' * (1024 * 1024 + 1))
        self.assertNotEqual(self.inspect(path, 'zip', {**os.environ, 'MAX_EXTRACT_SIZE_MB': '1'}).returncode, 0)

if __name__ == '__main__': unittest.main()
