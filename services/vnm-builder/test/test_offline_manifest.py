import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from offline_manifest import write_offline_manifest, MANIFEST

class OfflineInventory(unittest.TestCase):
    def test_inventory_binds_all_public_bytes_and_excludes_private_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'index.html').write_text('<head></head>')
            (root/'images').mkdir();(root/'images'/'café space.webp').write_bytes(b'image')
            (root/'.private').write_text('not public');(root/'.vnm-jobs').mkdir();(root/'.vnm-jobs'/'log').write_text('private')
            first=write_offline_manifest(root);second=write_offline_manifest(root)
            self.assertEqual(first,second)
            self.assertEqual([row['path'] for row in first['files']],['images/café space.webp','index.html'])
            expected=hashlib.sha256(json.dumps(first['files'],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
            self.assertEqual(first['id'],expected)
            (root/'images'/'café space.webp').write_bytes(b'changed')
            self.assertNotEqual(write_offline_manifest(root)['id'],first['id'])
            self.assertTrue((root/MANIFEST).is_file())
    def test_symlinks_and_missing_launch_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with self.assertRaises(ValueError):write_offline_manifest(root)
            (root/'index.html').write_text('<head></head>');(root/'actual').write_text('asset')
            try:(root/'linked').symlink_to(root/'actual')
            except OSError:self.skipTest('Host cannot create symlinks')
            with self.assertRaises(ValueError):write_offline_manifest(root)
