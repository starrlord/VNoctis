import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from compatibility import (
    create_uncompressed_overlay, needs_legacy_image_lookup, prepare_build_overlay,
)


class CompatibilityTests(unittest.TestCase):
    def test_engine_default_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(needs_legacy_image_lookup(directory))
            (root / "renpy").mkdir()
            config = root / "renpy/config.py"
            for value, expected in [
                ('[ "", "images/" ]', True),
                ('[\n "",\n "images/",\n]', True),
                ('[""]', False),
                ('["", "custom/", "images/"]', False),
                ('[get_prefix(), "images/"]', False),
            ]:
                with self.subTest(value=value):
                    config.write_text('print "Python 2 module"\nsearch_prefixes = ' + value + '\n')
                    self.assertEqual(needs_legacy_image_lookup(directory), expected)

    def test_no_imported_code_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "renpy").mkdir()
            (root / "renpy/config.py").write_text(
                'search_prefixes = __import__("os").system("exit 1")\n'
            )
            self.assertFalse(needs_legacy_image_lookup(directory))

    def test_overlay_keeps_compiler_writes_out_of_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            (source / "game/images").mkdir(parents=True)
            (source / "game/script.rpy").write_text("original script")
            (source / "game/script.rpyc").write_bytes(b"original compiled")
            (source / "game/images/movie.webm").write_bytes(b"video")
            (source / "progressive_download.txt").write_text("original rules")
            overlay = Path(directory) / "overlay"
            create_uncompressed_overlay(str(source), str(overlay))
            prepare_build_overlay(str(overlay), True)
            (overlay / "game/script.rpy").write_text("compiled changes")
            (overlay / "game/script.rpyc").write_bytes(b"new compiled")
            (overlay / "progressive_download.txt").write_text("changed rules")
            self.assertEqual((source / "game/script.rpy").read_text(), "original script")
            self.assertEqual((source / "game/script.rpyc").read_bytes(), b"original compiled")
            self.assertEqual((source / "progressive_download.txt").read_text(), "original rules")
            self.assertTrue((overlay / "game/images/movie.webm").is_symlink())
            self.assertFalse((source / "game/_vnm_legacy_search_prefixes.rpy").exists())

    def test_existing_compressed_assets_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            game = Path(directory) / "game"
            game.mkdir()
            image = game / "compressed.png"
            image.write_bytes(b"compressed")
            prepare_build_overlay(directory, False)
            self.assertEqual(image.read_bytes(), b"compressed")
            self.assertFalse((game / "_vnm_legacy_search_prefixes.rpy").exists())

    def test_shim_preserves_explicit_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            prepare_build_overlay(directory, True)
            shim = (Path(directory) / "game/_vnm_legacy_search_prefixes.rpy").read_text()
            body = '\n'.join(line[4:] for line in shim.splitlines() if line.startswith('    '))
            for initial, expected in [
                ([""], ["", "images/"]),
                (["", "custom/"], ["", "custom/"]),
                (["", "images/"], ["", "images/"]),
            ]:
                config = SimpleNamespace(search_prefixes=initial)
                exec(body, {"config": config})
                self.assertEqual(config.search_prefixes, expected)

    def test_reserved_name_collision_fails_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            game = Path(directory) / "game"
            game.mkdir()
            existing = game / "_vnm_legacy_search_prefixes.rpy"
            existing.write_text("game content")
            with self.assertRaises(RuntimeError):
                prepare_build_overlay(directory, True)
            self.assertEqual(existing.read_text(), "game content")


if __name__ == "__main__":
    unittest.main()
