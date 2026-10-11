import asyncio
import json
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from build_storage import create_source_overlay, materialize_mutable_files, publish_build, recover_publication
from build_queue import BuildQueue
from builder import RenPyBuilder, owned_file_work
from unittest.mock import AsyncMock, patch
import pickle
import zlib
import time

def slow_compress(*args, **kwargs):
    time.sleep(30)


class OwnedFileWorkTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_waits_for_filesystem_writer_before_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'overlay'
            def write_later():
                time.sleep(0.1)
                output.write_text('finished')
            task = asyncio.create_task(owned_file_work(write_later))
            await asyncio.sleep(0.02)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(output.read_text(), 'finished')
            output.unlink()
            await asyncio.sleep(0.05)
            self.assertFalse(output.exists())


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def test_invalid_replacement_preserves_playable_build(self):
        output, target, previous = [self.root / name for name in ('output', 'target', 'previous')]
        output.mkdir(); target.mkdir(); (target / 'index.html').write_text('old')
        with self.assertRaises(RuntimeError): publish_build(output, target, previous)
        self.assertEqual((target / 'index.html').read_text(), 'old')
    def test_publication_retains_backup_and_recovers_interrupted_rename(self):
        output, target, previous = [self.root / name for name in ('output', 'game', '.vnm-staging/job/previous')]
        output.mkdir(); target.mkdir(); previous.parent.mkdir(parents=True)
        (output / 'index.html').write_text('new'); (target / 'index.html').write_text('old')
        publish_build(output, target, previous)
        self.assertEqual((target / 'index.html').read_text(), 'new')
        self.assertEqual((previous / 'index.html').read_text(), 'old')
        import shutil; shutil.rmtree(target)
        recover_publication(self.root, 'job', '/games/game')
        self.assertEqual((target / 'index.html').read_text(), 'old')
    def test_sdk_writes_do_not_follow_source_script_symlinks(self):
        source, overlay = self.root / 'source', self.root / 'overlay'
        (source / 'game').mkdir(parents=True)
        for name in ('script.rpy', 'script.rpyc', 'screen.rpym', 'screen.rpymc'):
            (source / 'game' / name).write_text('original')
        (source / 'progressive_download.txt').write_text('original')
        (source / 'game/asset.bin').write_text('asset')
        create_source_overlay(source, overlay)
        for name in ('script.rpy', 'script.rpyc', 'screen.rpym', 'screen.rpymc'):
            (overlay / 'game' / name).write_text('compiled')
            self.assertEqual((source / 'game' / name).read_text(), 'original')
        self.assertTrue((overlay / 'game/asset.bin').is_symlink())
        (overlay / 'game/script.rpy').unlink(); (overlay / 'game/script.rpy').symlink_to(source / 'game/script.rpy')
        materialize_mutable_files(overlay)
        self.assertFalse((overlay / 'game/script.rpy').is_symlink())


class FakeBuilder:
    def __init__(self, root):
        self.web_builds_path = root; self.started = []; self.event = asyncio.Event(); self.publishing_jobs = set()
    async def build_game(self, job_id, **kwargs):
        self.started.append(job_id)
        if job_id == 'first': await self.event.wait()
    async def cancel_build(self, job_id): pass


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name); self.builder = FakeBuilder(self.root)
    async def asyncTearDown(self): self.temp.cleanup()
    async def wait_status(self, queue, job, status):
        for _ in range(200):
            if queue.get_status(job) == status: return
            await asyncio.sleep(.01)
        self.fail('queue did not reach expected status')
    async def test_queued_builds_survive_restart_and_duplicate_delivery(self):
        queue = BuildQueue(self.builder, max_concurrent=0)
        await queue.add('job', 'game', '/games/game')
        await queue.add('job', 'game', '/games/game')
        self.assertEqual(queue._queue.qsize(), 1)
        await queue.stop()
        recovered = BuildQueue(self.builder); await recovered.start()
        try: await self.wait_status(recovered, 'job', 'done')
        finally: await recovered.stop()
        self.assertEqual(self.builder.started, ['job'])
    async def test_cancelling_active_job_does_not_kill_queue_worker(self):
        queue = BuildQueue(self.builder); await queue.start()
        try:
            await queue.add('first', 'game1', '/games/game1')
            await queue.add('second', 'game2', '/games/game2')
            await self.wait_status(queue, 'first', 'building'); self.assertTrue(await queue.cancel('first'))
            await self.wait_status(queue, 'second', 'done')
            self.assertEqual(queue.get_status('first'), 'cancelled')
        finally: await queue.stop()
    async def test_worker_shutdown_reports_interruption_and_retains_queued_jobs(self):
        queue = BuildQueue(self.builder); await queue.start()
        await queue.add('first', 'game1', '/games/game1'); await queue.add('second', 'game2', '/games/game2')
        await self.wait_status(queue, 'first', 'building'); await queue.stop()
        self.assertEqual(queue.get_record('first')['status'], 'failed')
        recovered = BuildQueue(self.builder); await recovered.start()
        try: await self.wait_status(recovered, 'second', 'done')
        finally: await recovered.stop()
    async def test_restart_recovers_interrupted_publication_backup(self):
        state = self.root / '.vnm-jobs'; state.mkdir()
        (state / 'job.json').write_text(json.dumps(dict(job_id='job', game_id='game', game_path='/games/game', compress_assets=True, status='building')))
        previous = self.root / '.vnm-staging/job/previous'; previous.mkdir(parents=True); (previous / 'index.html').write_text('old')
        queue = BuildQueue(self.builder); await queue.start()
        try:
            self.assertEqual(queue.get_status('job'), 'failed')
            self.assertEqual((self.root / 'game/index.html').read_text(), 'old')
        finally: await queue.stop()
    async def test_publication_cannot_be_cancelled(self):
        queue = BuildQueue(self.builder); await queue.start(); await queue.add('first', 'game', '/games/game')
        try:
            await self.wait_status(queue, 'first', 'building'); self.builder.publishing_jobs.add('first')
            self.assertFalse(await queue.cancel('first'))
        finally: await queue.stop()

    async def test_archive_preparation_preserves_source_and_replaces_overlay_links(self):
        source, overlay = self.root / 'source', self.root / 'overlay'
        (source / 'game/images').mkdir(parents=True); (source / 'game/images/asset.dat').write_bytes(b'original')
        payload = b'archive asset'; header_size = len(b'RPA-2.0 0000000000000000\n')
        header = b'RPA-2.0 %016x\n' % (header_size + len(payload))
        archive = source / 'game/animations.rpa'
        archive.write_bytes(header + payload + zlib.compress(pickle.dumps({'images/asset.dat': [(header_size, len(payload))]}, protocol=2)))
        builder = RenPyBuilder('/missing-sdk', source.parent, self.root / 'builds', 'http://unused')
        builder._notify_api_status = AsyncMock()
        log = AsyncMock()
        await builder._prepare_archives('rpa-test', source, overlay, log, self.root / 'log')
        self.assertEqual((overlay / 'game/images/asset.dat').read_bytes(), payload)
        self.assertEqual((source / 'game/images/asset.dat').read_bytes(), b'original')
        self.assertTrue(archive.is_file()); self.assertFalse((overlay / 'game/animations.rpa').exists())

    async def test_cancellation_stops_owned_compression_workers(self):
        from compressor import create_compressed_overlay
        from PIL import Image
        source = self.root / 'source'; source.mkdir(); Image.new('RGB', (32, 32)).save(source / 'image.png')
        with patch('compressor._compress_one', slow_compress):
            task = asyncio.create_task(create_compressed_overlay(str(source), str(self.root / 'compressed')))
            await asyncio.sleep(.25)
            start = time.monotonic(); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
            self.assertLess(time.monotonic() - start, 3)

if __name__ == '__main__': unittest.main()
