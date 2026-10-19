import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from save_metadata import HOOK, HOOK_NAME, create_plain_overlay, prepare_save_metadata, read_save_metadata


class Define:
    def __init__(self, expression='"Lewd Town Adventures"', filename="game/options.rpy", linenumber=1):
        self.store = "store.config"
        self.varname = "save_directory"
        self.code = SimpleNamespace(source=expression)
        self.filename = filename
        self.linenumber = linenumber
        self.operator = "="
        self.index = None


class MetadataTests(unittest.TestCase):
    def capture(self, root, nodes=None, directory="Lewd Town Adventures", savedir=None, line=None):
        source = root / "game/options.rpy"
        source.parent.mkdir(exist_ok=True)
        source.write_text(line or 'define config.save_directory = "Lewd Town Adventures"\n', encoding="utf-8")
        build = SimpleNamespace(dump=lambda: {"base_patterns": [("game/**", ["all"])]})
        config = SimpleNamespace(basedir=str(root), gamedir=str(root / "game"), save_directory=directory,
                                 savedir=savedir or f"/home/build/.renpy/{directory}")
        renpy = SimpleNamespace(ast=SimpleNamespace(Define=Define),
                                game=SimpleNamespace(script=SimpleNamespace(namemap=dict(enumerate(nodes or [Define()])))),
                                __main__=SimpleNamespace(path_to_saves=lambda gamedir, name: f"/home/build/.renpy/{name}"))
        namespace = {"build": build, "config": config, "renpy": renpy}
        output = root / "vnm-save-directory.json"
        with patch.dict(os.environ, {"VNM_SAVE_METADATA": str(output)}):
            exec(textwrap.dedent(HOOK.split("init 999 python:\n", 1)[1]), namespace)
            result = build.dump()
        self.assertEqual(result["base_patterns"][0], ("game/_vnm_save_directory_metadata.*", None))
        self.assertEqual(result["base_patterns"][1], ("vnm-save-directory.json", None))
        return read_save_metadata(output)

    def test_literal_destination_and_export_exclusions(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.capture(Path(tmp)), "Lewd Town Adventures")

    def test_computed_conditional_and_overridden_settings_remain_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertIsNone(self.capture(root, nodes=[Define('"Game" + str(123)')]))
            self.assertIsNone(self.capture(root, nodes=[Define(), Define('"Other"')]))
            self.assertIsNone(self.capture(root, line='    define config.save_directory = "Lewd Town Adventures"\n'))
            custom = Define(); custom.varname = "savedir"
            self.assertIsNone(self.capture(root, nodes=[Define(), custom]))
            python = SimpleNamespace(filename="game/custom.rpy", code=SimpleNamespace(source='config.savedir = "/custom"'))
            self.assertIsNone(self.capture(root, nodes=[Define(), python]))
            self.assertIsNone(self.capture(root, savedir="/custom/saves"))
            self.assertIsNone(self.capture(root, directory="Changed"))
            self.assertIsNone(self.capture(root, nodes=[Define(filename="game/missing.rpy")]))

    def test_overlay_protects_originals_and_refuses_reserved_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "source"; (source / "game").mkdir(parents=True)
            original = source / "game/options.rpy"; original.write_text("original")
            compiled = source / "game/options.rpyc"; compiled.write_bytes(b"compiled")
            (source / "progressive_download.txt").write_text("rules")
            asset = source / "game/movie.webm"; asset.write_bytes(b"movie")
            overlay = root / "overlay"
            create_plain_overlay(str(source), str(overlay)); prepare_save_metadata(str(overlay))
            (overlay / "game/options.rpy").write_text("changed")
            (overlay / "game/options.rpyc").write_bytes(b"changed")
            (overlay / "progressive_download.txt").write_text("changed")
            self.assertEqual(original.read_text(), "original")
            self.assertEqual(compiled.read_bytes(), b"compiled")
            self.assertEqual((source / "progressive_download.txt").read_text(), "rules")
            self.assertTrue((overlay / "game/movie.webm").is_symlink())
            self.assertFalse((source / "game" / HOOK_NAME).exists())
            with self.assertRaises(RuntimeError): prepare_save_metadata(str(overlay))

    def test_bad_or_missing_metadata_never_guesses_a_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "metadata.json"
            self.assertIsNone(read_save_metadata(path))
            for directory in ["", "../Game", "/Game", "C:/saves", "Game\\saves", "tokens", "Game//saves", 42]:
                path.write_text(json.dumps({"version": 1, "directory": directory}))
                self.assertIsNone(read_save_metadata(path))
            path.write_text("invalid json")
            self.assertIsNone(read_save_metadata(path))


if __name__ == "__main__": unittest.main()
