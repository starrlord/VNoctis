"""Build-owned staging and publication; never delete the playable build up front."""
import os
import shutil
from pathlib import Path


def create_source_overlay(source, overlay):
    source, overlay = Path(source).resolve(), Path(overlay)
    if overlay.exists():
        shutil.rmtree(overlay)
    for root, _, files in os.walk(source):
        destination = overlay / Path(root).relative_to(source)
        destination.mkdir(parents=True, exist_ok=True)
        for name in files:
            original = Path(root) / name
            target = destination / name
            if original.suffix.lower() in {".rpy", ".rpyc", ".rpym", ".rpymc"} or original == source / "progressive_download.txt":
                shutil.copy2(original, target)
            else:
                target.symlink_to(original)


def publish_build(output, target, previous):
    output, target, previous = Path(output), Path(target), Path(previous)
    if not (output / "index.html").is_file():
        raise RuntimeError("Build output has no index.html")
    if previous.exists():
        raise RuntimeError("Publication backup already exists")
    if target.exists():
        target.rename(previous)
    try:
        output.rename(target)
    except BaseException:
        if previous.exists():
            previous.rename(target)
        raise


def materialize_mutable_files(overlay):
    """SDK compilation must not follow script symlinks into the imported game."""
    for root, _, files in os.walk(overlay):
        for name in files:
            path = Path(root) / name
            if path.is_symlink() and (path.suffix.lower() in {".rpy", ".rpyc", ".rpym", ".rpymc"} or name == "progressive_download.txt"):
                original = path.resolve()
                path.unlink()
                shutil.copy2(original, path)


def recover_publication(web_builds, job_id, game_path):
    """Restore the old playable build if shutdown interrupted the two renames."""
    target = Path(web_builds) / Path(game_path).name
    staging = Path(web_builds) / ".vnm-staging" / job_id
    previous = staging / "previous"
    if previous.is_dir() and not target.exists():
        previous.rename(target)
    if staging.exists():
        shutil.rmtree(staging)
