"""Trusted generated web adapter, executed in a private module, never the store."""
import json
import os
import renpy


class SaveCancelled(Exception):
    pass


def call(expression):
    import emscripten
    return emscripten.run_script_string(expression)


def install():
    if not renpy.emscripten or tuple(renpy.version_tuple[:4]) != (8, 5, 2, 26010301):
        return
    if call('window.vnmSaves && window.vnmSaves.active ? "yes" : "no"') != 'yes':
        return
    import emscripten
    native = renpy.savelocation.FileLocation

    class SaveLocation(native):
        def remote(self):
            return json.loads(call('JSON.stringify(window.vnmSaves.rows.apply(null, ' +
                json.dumps([self.directory.rstrip('/'), renpy.savegame_suffix]) + '))'))

        def resident(self, slot):
            return os.path.exists(self.filename(slot))

        def list(self):
            return sorted(set(super().list()) | set(self.remote()))

        def mtime(self, slot):
            value = super().mtime(slot) if self.resident(slot) else None
            return value if value is not None else self.remote().get(slot, {}).get('mtime')

        def json(self, slot):
            return super().json(slot) if self.resident(slot) else self.remote().get(slot, {}).get('metadata')

        def screenshot(self, slot):
            if self.resident(slot):
                return super().screenshot(slot)
            row = self.remote().get(slot, {})
            if not row.get('thumbnail'):
                return None
            try:
                with open(row['thumbnail'], 'rb') as image:
                    return renpy.display.im.Data(image.read(), 'vnm-save-preview.png')
            except OSError:
                return None

        def load(self, slot):
            if not self.resident(slot) and slot in self.remote():
                emscripten.run_script('window.vnmSaves.begin(' + json.dumps(self.filename(slot)) + ')')
                while emscripten.run_script_int('window.vnmSaves.transfer.pending ? 1 : 0'):
                    emscripten.sleep(0.02)
                if emscripten.run_script_int('window.vnmSaves.transfer.error ? 1 : 0'):
                    raise SaveCancelled('Save download failed or cancelled')
                self.scan()
            return super().load(slot)

        def mutate(self, operation, old, new=None):
            # Only the canonical directory owns aliases. The sync mirror must
            # not apply the same autosave rotation for a second time.
            call('window.vnmSaves.mutate.apply(null, ' + json.dumps([
                self.directory.rstrip('/'), operation, old, new, renpy.savegame_suffix]) + '); "ok"')

        def rename(self, old, new):
            super().rename(old, new)
            self.mutate('rename', old, new)

        def copy(self, old, new):
            super().copy(old, new)
            self.mutate('copy', old, new)

        def unlink(self, slot):
            super().unlink(slot)
            self.mutate('remove', slot)

    renpy.savelocation.FileLocation = SaveLocation
    renpy.loadsave._vnm_save_cancelled = SaveCancelled
    for source in _vnm_boundaries:
        scope = {}
        exec(compile(source, '<vnm-save-load-boundary>', 'exec'), scope)
        for name in ('load', 'get_save_data'):
            if name in scope:
                getattr(renpy.loadsave, name).__code__ = scope[name].__code__


install()
