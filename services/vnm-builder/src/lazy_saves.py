"""Generate the save-location adapter only for the researched, exact SDK."""
import ast
import hashlib
import zipfile
from pathlib import Path

HOOK_NAME = "_vnm_lazy_saves.rpy"
FINGERPRINTS = {
    "loadsave": "70cd82d5fc2245f647306951ac2ed1a1426f7dc23b3ee8ebb2f5236ec32a34e1",
    "savelocation": "e0b32aab4127325a307a8396b6a9b636781161fd23d595127e668d784342b85c",
}
MARKER = '<script>window.__VNM_SAVE_ADAPTER__={version:1,engine:"8.5.2.26010301"};</script>'


def prepare_lazy_saves(overlay_path, sdk_path):
    hook = Path(overlay_path) / "game" / HOOK_NAME
    if hook.exists() or hook.is_symlink() or hook.with_suffix('.rpyc').exists() or hook.with_suffix('.rpyc').is_symlink():
        raise RuntimeError("Reserved lazy-save adapter script already exists")
    sources = {}
    for name, expected in FINGERPRINTS.items():
        try:
            source = (Path(sdk_path) / "renpy" / (name + ".py")).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            return False
        if hashlib.sha256(source.encode()).hexdigest() != expected:
            return False
        sources[name] = source
    boundaries = []
    for node in ast.parse(sources['loadsave']).body:
        if isinstance(node, ast.FunctionDef) and node.name in ('load', 'get_save_data'):
            node.body = [ast.Try(body=node.body, handlers=[ast.ExceptHandler(
                type=ast.Name(id='_vnm_save_cancelled', ctx=ast.Load()), name=None,
                body=[ast.Return(value=ast.Constant(value=None))])], orelse=[], finalbody=[])]
            boundaries.append(ast.unparse(ast.fix_missing_locations(node)))
    if len(boundaries) != 2:
        return False
    adapter = Path(__file__).with_name('save_adapter.py').read_text(encoding='utf-8')
    adapter = '_vnm_boundaries = ' + repr(boundaries) + '\n' + adapter
    hook.parent.mkdir(parents=True, exist_ok=True)
    hook.write_text('python early:\n'
        '    import sys as _vnm_sys\n    import types as _vnm_types\n'
        '    _vnm_module = _vnm_types.ModuleType("vnm_save_adapter")\n'
        '    _vnm_sys.modules["vnm_save_adapter"] = _vnm_module\n'
        '    exec(' + repr(adapter) + ', _vnm_module.__dict__)\n', encoding='utf-8')
    return True


def publish_lazy_marker(index_file):
    path = Path(index_file)
    try:
        with zipfile.ZipFile(path.with_name('game.zip')) as archive:
            if archive.getinfo('game/' + HOOK_NAME.replace('.rpy', '.rpyc')).file_size <= 0:
                return False
    except (OSError, KeyError, zipfile.BadZipFile):
        return False
    text = path.read_text(encoding='utf-8')
    if '<head>' not in text:
        return False
    if '__VNM_SAVE_ADAPTER__' in text:
        raise RuntimeError('Cannot publish lazy-save capability in this web index')
    path.write_text(text.replace('<head>', '<head>' + MARKER, 1), encoding='utf-8')
    return True
