import hashlib
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from lazy_saves import HOOK_NAME, prepare_lazy_saves, publish_lazy_marker


class LazySaveTests(unittest.TestCase):
    def test_unknown_sdk_leaves_overlay_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertFalse(prepare_lazy_saves(root / 'game', root / 'unknown'))
            self.assertFalse((root / 'game').exists())

    def test_generation_reads_trusted_sources_without_executing_them_and_refuses_collisions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); sdk = root / 'sdk/renpy'; sdk.mkdir(parents=True)
            source = 'raise RuntimeError("must never execute SDK source")\ndef load(x):\n    return x\ndef get_save_data(x):\n    return x\n'
            for name in ('loadsave', 'savelocation'):
                (sdk / (name + '.py')).write_text(source)
            fingerprints = {name: hashlib.sha256(source.encode()).hexdigest() for name in ('loadsave', 'savelocation')}
            with patch('lazy_saves.FINGERPRINTS', fingerprints):
                self.assertTrue(prepare_lazy_saves(root / 'overlay', sdk.parent))
                hook = root / 'overlay/game' / HOOK_NAME
                self.assertIn('vnm_save_adapter', hook.read_text())
                self.assertIn('_vnm_save_cancelled', hook.read_text())
                with self.assertRaises(RuntimeError): prepare_lazy_saves(root / 'overlay', sdk.parent)
                (sdk / 'loadsave.py').write_text(source + '# changed SDK\n')
                self.assertFalse(prepare_lazy_saves(root / 'other', sdk.parent))

    def test_marker_requires_published_compiled_adapter(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); index = root / 'index.html'; index.write_text('<head></head>')
            self.assertFalse(publish_lazy_marker(index))
            with zipfile.ZipFile(root / 'game.zip', 'w') as archive: archive.writestr('game/script.rpyc', b'compiled')
            self.assertFalse(publish_lazy_marker(index))
            with zipfile.ZipFile(root / 'game.zip', 'w') as archive: archive.writestr('game/' + HOOK_NAME.replace('.rpy', '.rpyc'), b'compiled')
            self.assertTrue(publish_lazy_marker(index))
            self.assertIn('__VNM_SAVE_ADAPTER__', index.read_text())
            with self.assertRaises(RuntimeError): publish_lazy_marker(index)
