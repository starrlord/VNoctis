"""Reuse optimized images from the published game, without a separate asset cache."""
import hashlib
import json
import shutil
import zipfile
from pathlib import Path, PurePosixPath

MANIFEST = '.vnm-assets.json'
STATUS = '.vnm-compression.json'
_archives = {}


def published_zip(path):
    # Each compression worker opens a build ZIP once, rather than parsing its
    # entire central directory for every reused image. Worker exit closes it.
    key = str(path)
    if key not in _archives:
        if len(_archives) >= 4:
            _archives.pop(next(iter(_archives))).close()
        _archives[key] = zipfile.ZipFile(path)
    return _archives[key]


def digest(path):
    with Path(path).open('rb') as stream:
        return stream_digest(stream)


def stream_digest(stream):
    result = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        result.update(block)
    return result.hexdigest()


def safe_relative(value):
    return isinstance(value, str) and value and '\\' not in value and not PurePosixPath(value).is_absolute() and not any(part in ('..', '.') for part in value.split('/'))


def load_assets(root, settings):
    try:
        manifest = json.loads((Path(root) / MANIFEST).read_text())
        if manifest.get('version') == 1 and manifest.get('settings') == settings:
            return manifest.get('assets', {})
    except (OSError, ValueError, TypeError):
        pass
    return {}


def reuse_asset(root, entry, source_hash, destination):
    """Verify provenance and output bytes before copying into the disposable overlay."""
    if not entry or entry.get('source') != source_hash or not safe_relative(entry.get('path')):
        return False
    destination = Path(destination)
    try:
        root = Path(root).resolve()
        published = (root / entry['path']).resolve()
        if not published.is_relative_to(root):
            return False
        member = entry.get('member')
        if member:
            if not safe_relative(member):
                return False
            with published_zip(published).open(member) as stream, destination.open('wb') as output:
                shutil.copyfileobj(stream, output)
        else:
            shutil.copyfile(published, destination)
        if digest(destination) == entry.get('output'):
            return True
    except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile):
        pass
    destination.unlink(missing_ok=True)
    return False


def write_assets(output, stats):
    """Index only real published bytes, excluding Ren'Py's progressive placeholders."""
    output = Path(output)
    assets = {}
    archive = None
    try:
        if (output / 'game.zip').is_file():
            archive = zipfile.ZipFile(output / 'game.zip')
        for relative, entry in stats.get('assets', {}).items():
            if not safe_relative(relative):
                continue
            candidate = output / relative
            location = None
            if candidate.is_file() and digest(candidate) == entry['output']:
                location = {'path': relative}
            elif archive:
                try:
                    with archive.open(relative) as stream:
                        if stream_digest(stream) == entry['output']:
                            location = {'path': 'game.zip', 'member': relative}
                except KeyError:
                    pass
            if location:
                assets[relative] = {'source': entry['source'], 'output': entry['output'], **location}
    finally:
        if archive:
            archive.close()
    manifest = {'version': 1, 'settings': stats.get('settings'), 'assets': assets}
    (output / MANIFEST).write_text(json.dumps(manifest, separators=(',', ':')))
    (output / STATUS).write_text(json.dumps({'version': 1, 'compressed': bool(stats.get('images')), 'reusableImages': len(assets)}))
    return len(assets)
