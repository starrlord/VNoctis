import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from compressor import create_compressed_overlay
from published_assets import write_assets, reuse_asset, digest, MANIFEST


class PublishedAssetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        (self.source / 'game').mkdir(parents=True)
        for name, color in [('one.webp', 'red'), ('two.webp', 'blue')]:
            Image.new('RGB', (128, 128), color).save(self.source / 'game' / name, 'WEBP', lossless=True)
        self.environment = patch.dict(os.environ, {'COMPRESS_WORKERS': '1', 'COMPRESS_WEBP_METHOD': '4'})
        self.environment.start()
        self.output = self.root / 'published'
        self.output.mkdir()
    async def asyncTearDown(self):
        self.environment.stop()
        self.temp.cleanup()
    async def publish(self):
        overlay = self.root / 'first'
        stats = await create_compressed_overlay(str(self.source), str(overlay))
        (self.output / 'game').mkdir()
        shutil.copyfile(overlay / 'game/one.webp', self.output / 'game/one.webp')
        with zipfile.ZipFile(self.output / 'game.zip', 'w') as archive:
            archive.write(overlay / 'game/two.webp', 'game/two.webp')
            archive.writestr('_placeholders/two.webp', b'not the image')
        self.assertEqual(write_assets(self.output, stats), 2)
        return stats
    async def test_reuses_progressive_files_and_zip_members_without_an_extra_cache(self):
        await self.publish()
        stats = await create_compressed_overlay(str(self.source), str(self.root / 'next'), published_root=self.output)
        self.assertEqual(stats['reused'], 2)
        with Image.open(self.root / 'next/game/two.webp') as image:
            self.assertEqual(image.size, (128, 128))
        self.assertEqual(sorted(p.name for p in self.output.iterdir()), ['.vnm-assets.json', '.vnm-compression.json', 'game', 'game.zip'])
    async def test_changed_sources_or_encoding_settings_are_not_reused(self):
        await self.publish()
        Image.new('RGB', (128, 128), 'green').save(self.source / 'game/one.webp', 'WEBP', lossless=True)
        stats = await create_compressed_overlay(str(self.source), str(self.root / 'changed'), published_root=self.output)
        self.assertEqual(stats['reused'], 1)
        with patch.dict(os.environ, {'COMPRESS_WEBP_METHOD': '1'}):
            stats = await create_compressed_overlay(str(self.source), str(self.root / 'settings'), published_root=self.output)
        self.assertEqual(stats['reused'], 0)
    async def test_force_recompression_bypasses_valid_published_images(self):
        await self.publish()
        stats = await create_compressed_overlay(str(self.source), str(self.root / 'force'), published_root=self.output, force_recompress=True)
        self.assertEqual(stats['reused'], 0)
    async def test_corrupt_reused_bytes_fall_back_to_original_source(self):
        await self.publish()
        (self.output / 'game/one.webp').write_bytes(b'corrupt')
        stats = await create_compressed_overlay(str(self.source), str(self.root / 'repair'), published_root=self.output)
        self.assertEqual(stats['reused'], 1)
        with Image.open(self.root / 'repair/game/one.webp') as image:
            image.verify()
        self.assertEqual(stats['errors'], 0)
    async def test_zip_placeholder_is_not_indexed_as_original_image(self):
        stats = await self.publish()
        (self.output / 'game/one.webp').unlink()
        with zipfile.ZipFile(self.output / 'game.zip', 'w') as archive:
            archive.writestr('_placeholders/one.webp', b'placeholder')
        self.assertEqual(write_assets(self.output, stats), 0)
    async def test_manifest_cannot_copy_files_outside_the_published_game(self):
        outside = self.root / 'private'
        outside.write_bytes(b'private')
        entry = {'source': 'sourcehash', 'output': digest(outside), 'path': '../private'}
        self.assertFalse(reuse_asset(self.output, entry, 'sourcehash', self.root / 'copied'))
        self.assertFalse((self.root / 'copied').exists())


if __name__ == '__main__':
    unittest.main()
