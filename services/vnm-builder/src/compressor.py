"""Image compression for web builds — operates on a symlink overlay.

Creates a lightweight overlay directory that symlinks all non-image files
from the original game directory and places compressed copies of images
alongside them.  The Ren'Py ``web_build`` command is then pointed at the
overlay so that compressed images are baked into the web build while the
original game files remain untouched.

Compression tools:
  - jpegoptim  — lossy JPEG re-quantisation + metadata strip
  - pngquant   — lossy palette quantisation (preserves transparency)
  - Pillow     — WebP re-encoding and BMP→PNG conversion

Environment variables (all optional):
  COMPRESS_JPEG_QUALITY  0-100 (default: 80)
  COMPRESS_PNG_QUALITY  "min-max" (default: "60-80")
  COMPRESS_WEBP_QUALITY  0-100 (default: 80)
  COMPRESS_WORKERS       int, 0 = auto (default: 0)
"""

import asyncio
import os
import shutil
import time
from concurrent.futures import ProcessPoolExecutor
from functools import partial
from pathlib import Path

from logger import setup_logger

logger = setup_logger("vnm-builder.compressor")

# Extensions we attempt to compress.  Everything else is symlinked.
IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})

# ── Defaults (overridable via env) ───────────────────────────

DEFAULT_JPEG_QUALITY = 80
DEFAULT_PNG_QUALITY = "60-80"
DEFAULT_WEBP_QUALITY = 80


def _env_bool(name: str, default: bool = True) -> bool:
    val = os.environ.get(name, "").strip().lower()
    if val in ("0", "false", "no", "off"):
        return False
    if val in ("1", "true", "yes", "on"):
        return True
    return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except (ValueError, AttributeError):
        return default


def _env_str(name: str, default: str) -> str:
    val = os.environ.get(name, "").strip()
    return val if val else default


# ── Per-image compression (runs in ProcessPoolExecutor) ──────

def _compress_one(
    src: str,
    dst: str,
    ext: str,
    jpeg_quality: int,
    png_quality: str,
    webp_quality: int,
) -> tuple[str, int, int, str | None]:
    """Compress a single image file.

    Returns ``(relative_path, original_bytes, compressed_bytes, error_or_None)``.
    Runs in a worker process — must not reference any asyncio objects.
    """
    src_p = Path(src)
    dst_p = Path(dst)
    original_size = src_p.stat().st_size

    try:
        dst_p.parent.mkdir(parents=True, exist_ok=True)

        if ext in (".jpg", ".jpeg"):
            compressed_size = _compress_jpeg(src_p, dst_p, jpeg_quality)
        elif ext == ".png":
            compressed_size = _compress_png(src_p, dst_p, png_quality)
        elif ext == ".webp":
            compressed_size = _compress_webp(src_p, dst_p, webp_quality)
        elif ext == ".bmp":
            compressed_size = _compress_bmp(src_p, dst_p)
        else:
            # Should not happen — fall through to symlink in caller
            shutil.copy2(src_p, dst_p)
            compressed_size = dst_p.stat().st_size

        return (src, original_size, compressed_size, None)

    except Exception as exc:
        # On failure, create a symlink so the build can still proceed
        try:
            if dst_p.exists() or dst_p.is_symlink():
                dst_p.unlink()
            os.symlink(src_p, dst_p)
        except OSError:
            pass
        return (src, original_size, original_size, str(exc))


def _compress_jpeg(src: Path, dst: Path, quality: int) -> int:
    """Lossy JPEG re-compression via jpegoptim."""
    import subprocess

    # jpegoptim works in-place, so copy first
    shutil.copy2(src, dst)
    subprocess.run(
        [
            "jpegoptim",
            f"--max={quality}",
            "--strip-all",
            "--quiet",
            str(dst),
        ],
        check=False,
        capture_output=True,
    )
    return dst.stat().st_size


def _compress_png(src: Path, dst: Path, quality: str) -> int:
    """Lossy PNG quantisation via pngquant."""
    import subprocess

    result = subprocess.run(
        [
            "pngquant",
            "--quality",
            quality,
            "--force",
            "--skip-if-larger",
            "--output",
            str(dst),
            str(src),
        ],
        check=False,
        capture_output=True,
    )
    if not dst.exists():
        # pngquant skipped (--skip-if-larger kicked in or error) — symlink
        os.symlink(src, dst)
    return dst.stat().st_size if dst.exists() and not dst.is_symlink() else src.stat().st_size


def _compress_webp(src: Path, dst: Path, quality: int) -> int:
    """Re-encode WebP at target quality via Pillow."""
    from PIL import Image

    img = Image.open(src)
    img.save(dst, "WEBP", quality=quality, method=4)
    compressed = dst.stat().st_size
    # If Pillow made it bigger, symlink the original instead
    if compressed >= src.stat().st_size:
        dst.unlink()
        os.symlink(src, dst)
        return src.stat().st_size
    return compressed


def _compress_bmp(src: Path, dst: Path) -> int:
    """Convert BMP → PNG (BMP is uncompressed; this always wins)."""
    from PIL import Image

    dst_png = dst.with_suffix(".png")
    img = Image.open(src)
    img.save(dst_png, "PNG", optimize=True)
    # Also symlink under the original .bmp name so Ren'Py can still find it
    if dst_png != dst:
        os.symlink(dst_png, dst)
    return dst_png.stat().st_size


# ── Public API ───────────────────────────────────────────────


async def create_compressed_overlay(
    game_path: str,
    overlay_path: str,
    log_callback=None,
) -> dict:
    """Create a symlink overlay of *game_path* with compressed images.

    All non-image files are symlinked (zero extra disk).  Image files are
    compressed into the overlay directory using parallel worker processes.

    Parameters
    ----------
    game_path : str
        Path to the original game directory (e.g. ``/games/MyGame``).
    overlay_path : str
        Path for the temporary overlay (e.g. ``/tmp/build-<jobId>``).
    log_callback : async callable(str), optional
        Called with progress messages.

    Returns
    -------
    dict
        Statistics: images, symlinks, original_bytes, compressed_bytes,
        errors, elapsed_s.
    """
    game = Path(game_path)
    overlay = Path(overlay_path)

    # Read config from environment
    jpeg_quality = _env_int("COMPRESS_JPEG_QUALITY", DEFAULT_JPEG_QUALITY)
    png_quality = _env_str("COMPRESS_PNG_QUALITY", DEFAULT_PNG_QUALITY)
    webp_quality = _env_int("COMPRESS_WEBP_QUALITY", DEFAULT_WEBP_QUALITY)
    workers = _env_int("COMPRESS_WORKERS", 0) or os.cpu_count() or 4

    async def _log(msg: str):
        if log_callback:
            await log_callback(msg)

    # ── Clean slate ──────────────────────────────────────
    if overlay.exists():
        await asyncio.to_thread(shutil.rmtree, overlay)
    overlay.mkdir(parents=True, exist_ok=True)

    await _log(
        f"[compressor] Scanning {game} for compressible images "
        f"(jpeg_q={jpeg_quality}, png_q={png_quality}, webp_q={webp_quality}, "
        f"workers={workers})"
    )

    # ── Walk and classify ────────────────────────────────
    image_jobs: list[tuple[str, str, str]] = []  # (src, dst, ext)
    symlink_count = 0
    t0 = time.monotonic()

    for root, dirs, files in os.walk(game):
        rel_root = Path(root).relative_to(game)
        target_dir = overlay / rel_root
        target_dir.mkdir(parents=True, exist_ok=True)

        for filename in files:
            src_file = Path(root) / filename
            dst_file = target_dir / filename
            ext = src_file.suffix.lower()

            if ext in IMAGE_EXTENSIONS:
                image_jobs.append((str(src_file), str(dst_file), ext))
            else:
                os.symlink(src_file, dst_file)
                symlink_count += 1

    await _log(
        f"[compressor] Found {len(image_jobs)} images to compress, "
        f"{symlink_count} files symlinked"
    )

    if not image_jobs:
        return {
            "images": 0,
            "symlinks": symlink_count,
            "original_bytes": 0,
            "compressed_bytes": 0,
            "errors": 0,
            "elapsed_s": time.monotonic() - t0,
        }

    # ── Parallel compression ─────────────────────────────
    loop = asyncio.get_running_loop()
    compress_fn = partial(
        _compress_one,
        jpeg_quality=jpeg_quality,
        png_quality=png_quality,
        webp_quality=webp_quality,
    )

    total_original = 0
    total_compressed = 0
    error_count = 0
    done_count = 0
    total = len(image_jobs)

    # ProcessPoolExecutor lets us fully parallelise CPU-bound compression
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = []
        for src, dst, ext in image_jobs:
            future = loop.run_in_executor(pool, compress_fn, src, dst, ext)
            futures.append(future)

        for coro in asyncio.as_completed(futures):
            src, orig_sz, comp_sz, err = await coro
            total_original += orig_sz
            total_compressed += comp_sz
            done_count += 1
            if err:
                error_count += 1
                logger.warning("Compression failed for %s: %s", src, err)

            # Progress every 200 images or at the end
            if done_count % 200 == 0 or done_count == total:
                pct = done_count / total * 100
                saved_mb = (total_original - total_compressed) / (1024 * 1024)
                ratio = (
                    total_compressed / total_original * 100
                    if total_original > 0
                    else 0
                )
                await _log(
                    f"[compressor] {done_count}/{total} ({pct:.0f}%) — "
                    f"saved {saved_mb:.0f} MB so far ({ratio:.0f}% of original)"
                )

    elapsed = time.monotonic() - t0
    savings_mb = (total_original - total_compressed) / (1024 * 1024)
    ratio = (
        total_compressed / total_original * 100
        if total_original > 0
        else 0
    )

    await _log(
        f"[compressor] ✅ Done in {elapsed:.1f}s — "
        f"{done_count} images, {savings_mb:.0f} MB saved "
        f"({ratio:.0f}% of original), {error_count} errors"
    )

    return {
        "images": done_count,
        "symlinks": symlink_count,
        "original_bytes": total_original,
        "compressed_bytes": total_compressed,
        "errors": error_count,
        "elapsed_s": elapsed,
    }


def cleanup_overlay(overlay_path: str):
    """Remove the temporary overlay directory.

    Safe to call even if the path does not exist.
    """
    overlay = Path(overlay_path)
    if overlay.exists():
        shutil.rmtree(overlay, ignore_errors=True)
        logger.info("Cleaned up overlay at %s", overlay)
