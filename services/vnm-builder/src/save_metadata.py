"""Capture a conservative web save destination during the existing SDK build."""

import json
import os
import shutil
from pathlib import Path

HOOK_NAME = "_vnm_save_directory_metadata.rpy"
HOOK = '''# Temporary build hook; excluded from every distribution.
init 999 python:
    import ast as _vnm_ast
    import json as _vnm_json
    import os as _vnm_os

    _vnm_original_build_dump = build.dump

    def _vnm_directory_metadata():
        # Only a single, top-level literal declaration is portable between the
        # headless build and web runtime. Computed/custom settings remain unknown.
        nodes = list(renpy.game.script.namemap.values())
        declarations = []
        for node in nodes:
            filename = getattr(node, "filename", "")
            if filename.startswith(("common/", "renpy/common/")) or filename.endswith("_vnm_save_directory_metadata.rpy"):
                continue
            code = getattr(getattr(node, "code", None), "source", None)
            if isinstance(node, renpy.ast.Define) and node.store == "store.config":
                if node.varname == "savedir":
                    return None
                if node.varname == "save_directory":
                    declarations.append(node)
            elif isinstance(code, str) and ("save_directory" in code or "savedir" in code):
                return None
        if len(declarations) != 1:
            return None
        node = declarations[0]
        if getattr(node, "operator", "=") != "=" or getattr(node, "index", None) is not None:
            return None
        try:
            filename = _vnm_os.path.join(config.basedir, node.filename)
            with open(filename, "r", encoding="utf-8-sig") as source:
                line = source.readlines()[node.linenumber - 1]
            if line != line.lstrip():
                return None
            directory = _vnm_ast.literal_eval(node.code.source)
        except Exception:
            return None
        if not isinstance(directory, str) or directory != config.save_directory:
            return None
        if config.savedir != renpy.__main__.path_to_saves(config.gamedir, directory):
            return None
        if not directory or len(directory) > 400 or directory.split("/")[0] == "tokens":
            return None
        if any(c in directory for c in ("\\\\", ":")) or any(ord(c) < 32 for c in directory):
            return None
        if any(part in ("", ".", "..") for part in directory.split("/")):
            return None
        return directory

    def _vnm_build_dump():
        result = _vnm_original_build_dump()
        result["base_patterns"] = [("game/_vnm_save_directory_metadata.*", None), ("vnm-save-directory.json", None)] + result["base_patterns"]
        destination = _vnm_os.environ.get("VNM_SAVE_METADATA")
        if destination:
            try:
                with open(destination, "w", encoding="utf-8") as output:
                    _vnm_json.dump({"version": 1, "directory": _vnm_directory_metadata()}, output)
            except Exception:
                pass
        return result

    build.dump = _vnm_build_dump
'''


def create_plain_overlay(game_path: str, overlay_path: str) -> None:
    source = Path(game_path).resolve()
    overlay = Path(overlay_path)
    if overlay.exists():
        shutil.rmtree(overlay)
    for root, _, files in os.walk(source):
        destination = overlay / Path(root).relative_to(source)
        destination.mkdir(parents=True, exist_ok=True)
        for name in files:
            (destination / name).symlink_to(Path(root) / name)


def prepare_save_metadata(overlay_path: str) -> Path:
    overlay = Path(overlay_path)
    hook = overlay / "game" / HOOK_NAME
    metadata = overlay / "vnm-save-directory.json"
    if any(path.exists() or path.is_symlink() for path in (hook, hook.with_suffix(".rpyc"), metadata)):
        raise RuntimeError("Reserved save metadata script already exists")
    # Compilers and progressive-download setup must not write through links.
    for root, _, files in os.walk(overlay):
        for name in files:
            path = Path(root) / name
            if path.is_symlink() and (path.suffix.lower() in {".rpy", ".rpyc", ".rpym", ".rpymc"}
                                      or path == overlay / "progressive_download.txt"):
                source = path.resolve()
                path.unlink()
                shutil.copy2(source, path)
    hook.parent.mkdir(parents=True, exist_ok=True)
    hook.write_text(HOOK, encoding="utf-8")
    return metadata


def read_save_metadata(path: Path) -> str | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        directory = data.get("directory")
        if data.get("version") != 1 or not isinstance(directory, str) or not directory or len(directory) > 400:
            return None
        if any(c in directory for c in ("\\", ":")) or any(ord(c) < 32 for c in directory):
            return None
        if directory.split("/")[0] == "tokens" or any(p in ("", ".", "..") for p in directory.split("/")):
            return None
        return directory
    except (OSError, ValueError, AttributeError):
        return None
