"""Publish an immutable file inventory after the SDK has finished writing."""
import hashlib
import json
import os
from pathlib import Path

MANIFEST = '.vnm-offline-manifest.json'

def write_offline_manifest(directory):
    root = Path(directory).resolve()
    files = []
    for parent, directories, names in os.walk(root):
        if any((Path(parent) / name).is_symlink() for name in directories):
            raise ValueError('Offline builds cannot contain symlink directories')
        directories[:] = sorted(name for name in directories if not name.startswith('.') and name != 'logs')
        for name in sorted(names):
            path = Path(parent) / name
            if name.startswith('.'):
                continue
            if path.is_symlink() or not path.is_file():
                raise ValueError('Offline builds require regular files')
            relative = path.relative_to(root).as_posix()
            if len(relative) > 2048 or any(ord(c) < 32 or c == '\\' for c in relative):
                raise ValueError('Unsupported offline asset path')
            before = path.stat()
            checksum = hashlib.sha256()
            with path.open('rb') as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    checksum.update(chunk)
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError('Build changed during offline manifest generation')
            files.append(dict(path=relative, size=after.st_size, hash=checksum.hexdigest()))
    files.sort(key=lambda item: item['path'])
    if len(files) > 200000 or not any(item['path'] == 'index.html' for item in files):
        raise ValueError('Invalid offline build inventory')
    encoded = json.dumps(files, ensure_ascii=False, separators=(',', ':')).encode()
    result = dict(version=1, id=hashlib.sha256(encoded).hexdigest(), files=files)
    temporary = root / (MANIFEST + '.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(root / MANIFEST)
    return result
