"""Core Ren'Py web-build logic — SDK detection, subprocess execution, API callbacks."""

import asyncio
import os
import re
import shutil
import signal
import time
from pathlib import Path

import httpx

from compressor import create_compressed_overlay, cleanup_overlay
from logger import setup_logger

logger = setup_logger("vnm-builder.builder")

# Headless environment — suppress SDL display/audio initialisation
_HEADLESS_ENV = {
    "SDL_AUDIODRIVER": "dummy",
    "SDL_VIDEODRIVER": "dummy",
}


class RenPyBuilder:
    """Manages Ren'Py SDK interaction, subprocess builds, and API status callbacks."""

    def __init__(
        self,
        sdk_path: str,
        games_path: str,
        web_builds_path: str,
        api_url: str,
    ):
        self.sdk_path = Path(sdk_path)
        self.games_path = Path(games_path)
        self.web_builds_path = Path(web_builds_path)
        self.api_url = api_url.rstrip("/")
        self.sdk_version = self._detect_sdk_version()
        self.active_builds: dict[str, asyncio.subprocess.Process] = {}
        self._cancelled_jobs: set[str] = set()

        # Ensure output directories exist
        self.logs_dir = self.web_builds_path / "logs"
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        logger.info(
            "RenPyBuilder initialised — sdk=%s  version=%s  games=%s  builds=%s",
            self.sdk_path,
            self.sdk_version,
            self.games_path,
            self.web_builds_path,
        )

    # ── SDK version detection ──────────────────────────────

    def _detect_sdk_version(self) -> str:
        """Read SDK version from renpy/__init__.py or renpy/vc_version.py."""
        candidates = [
            self.sdk_path / "renpy" / "__init__.py",
            self.sdk_path / "renpy" / "vc_version.py",
        ]
        for path in candidates:
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")

                # Try version_tuple = (8, 2, 0)
                m = re.search(
                    r"version_tuple\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)",
                    text,
                )
                if m:
                    return f"{m.group(1)}.{m.group(2)}.{m.group(3)}"

                # Try version = "8.2.0"
                m = re.search(r'version\s*=\s*["\']([0-9]+\.[0-9]+[^"\']*)["\']', text)
                if m:
                    return m.group(1)

                # Try vc_version = 8020000
                m = re.search(r"vc_version\s*=\s*(\d+)", text)
                if m:
                    val = int(m.group(1))
                    major = val // 1_000_000
                    minor = (val % 1_000_000) // 10_000
                    patch = val % 10_000
                    return f"{major}.{minor}.{patch}"
            except Exception as exc:
                logger.warning("Failed to read %s: %s", path, exc)

        logger.warning("Could not detect Ren'Py SDK version at %s", self.sdk_path)
        return "unknown"

    # ── SDK availability check ─────────────────────────────

    def sdk_available(self) -> bool:
        """Return True if the SDK directory exists and contains a launcher."""
        return self._resolve_launcher() is not None

    def _resolve_launcher(self) -> str | None:
        """Return the absolute path to the Ren'Py launcher executable.

        Returns the path to ``renpy.sh`` or ``renpy.py``, or *None* if no
        usable launcher was found.
        """
        # Option 1: renpy.sh (Linux container — primary scenario)
        sh_launcher = self.sdk_path / "renpy.sh"
        if sh_launcher.is_file():
            return str(sh_launcher)

        # Option 2: renpy.py as a fallback
        py_launcher = self.sdk_path / "renpy.py"
        if py_launcher.is_file():
            return str(py_launcher)

        return None

    # ── Validate game path ─────────────────────────────────

    def validate_game_path(self, game_path: str) -> str | None:
        """Return an error message if the game path is not a valid Ren'Py project, else None."""
        p = Path(game_path)
        if not p.is_dir():
            return f"Game directory does not exist: {game_path}"

        # A valid Ren'Py game should have a "game" subdirectory
        game_subdir = p / "game"
        if not game_subdir.is_dir():
            return f"No 'game/' subdirectory found in {game_path}"

        return None

    # ── Helper: build env dict ─────────────────────────────

    @staticmethod
    def _build_env() -> dict[str, str]:
        """Return an environment dict suitable for headless Ren'Py subprocesses."""
        env = {**os.environ, **_HEADLESS_ENV}
        return env

    # ── Helper: stream subprocess output ───────────────────

    async def _stream_output(
        self,
        proc: asyncio.subprocess.Process,
        log_fn,
        log_file: Path,
    ):
        """Stream subprocess output, handling both \\n and \\r line endings.

        Ren'Py progress output uses ``\\r`` to overwrite lines in-place.
        ``readline()`` only splits on ``\\n``, so all the ``\\r``-separated
        progress concatenates into one massive line that exceeds asyncio's
        64 KB buffer limit.  Reading raw chunks and splitting manually
        avoids the overflow.
        """
        assert proc.stdout is not None
        buffer = ""
        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            buffer += text

            # Split on both \r and \n
            while "\n" in buffer or "\r" in buffer:
                idx_n = buffer.find("\n")
                idx_r = buffer.find("\r")

                if idx_n == -1:
                    idx = idx_r
                elif idx_r == -1:
                    idx = idx_n
                else:
                    idx = min(idx_n, idx_r)

                line = buffer[:idx].strip()
                # Skip \r\n combination
                if idx + 1 < len(buffer) and buffer[idx] == "\r" and buffer[idx + 1] == "\n":
                    buffer = buffer[idx + 2:]
                else:
                    buffer = buffer[idx + 1:]

                if line:
                    await log_fn(line)
                    with open(log_file, "a", encoding="utf-8") as fh:
                        fh.write(line + "\n")

        # Flush remaining buffer
        if buffer.strip():
            await log_fn(buffer.strip())
            with open(log_file, "a", encoding="utf-8") as fh:
                fh.write(buffer.strip() + "\n")

    # ── Main build coroutine ───────────────────────────────

    async def build_game(
        self,
        job_id: str,
        game_id: str,
        game_path: str,
        log_callback,
        compress_assets: bool = True,
    ):
        """Execute the Ren'Py web build for a game.

        Uses the ``web_build`` command via the SDK launcher::

            renpy.sh <sdk>/launcher web_build <game_path> --destination <output_dir>

        Parameters
        ----------
        job_id : str
            The BuildJob ID for tracking.
        game_id : str
            The Game ID for output directory naming.
        game_path : str
            Absolute path to the game directory inside the container.
        log_callback : async callable(str)
            Called with each line of build output.
        """
        log_file = self.logs_dir / f"{job_id}.log"
        dir_name = Path(game_path).name
        output_dir = self.web_builds_path / dir_name
        start_time = time.monotonic()

        async def _log(line: str):
            """Write to log file and notify subscribers."""
            with open(log_file, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
            await log_callback(line)

        try:
            await _log(f"[vnm-builder] Build started for job={job_id} game={game_id}")
            await _log(f"[vnm-builder] Game path: {game_path}")
            await _log(f"[vnm-builder] SDK version: {self.sdk_version}")
            logger.info("Build started job=%s game=%s path=%s", job_id, game_id, game_path)

            # Notify API: building
            await self._notify_api_status(job_id, "building")

            # ── Resolve launcher ────────────────────────────
            launcher = self._resolve_launcher()
            if launcher is None:
                raise RuntimeError(
                    f"Ren'Py SDK not found or not usable at {self.sdk_path}"
                )

            env = self._build_env()
            env["RENPY_LAUNCHER_DIR"] = str(self.sdk_path)

            # ── Ensure output dir exists and is clean ────────
            if output_dir.exists():
                await asyncio.to_thread(shutil.rmtree, output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)

            # ── Compress images into overlay (if enabled) ────
            overlay_dir = Path(f"/tmp/build-{job_id}")
            build_source = game_path  # default: build from original

            if compress_assets:
                try:
                    await _log("[vnm-builder] Compressing images for web build...")
                    compress_stats = await create_compressed_overlay(
                        game_path, str(overlay_dir), log_callback=_log,
                    )
                    build_source = str(overlay_dir)
                    await _log(
                        f"[vnm-builder] Image compression complete — "
                        f"building from overlay at {overlay_dir}"
                    )
                except Exception as comp_exc:
                    await _log(
                        f"[vnm-builder] ⚠️ Image compression failed: {comp_exc} "
                        f"— building uncompressed from original game files"
                    )
                    logger.warning(
                        "Compression failed job=%s: %s — proceeding uncompressed",
                        job_id, comp_exc,
                    )
                    build_source = game_path
            else:
                await _log("[vnm-builder] Asset compression skipped (user opted out)")

            # ── Write progressive_download.txt for web build ──
            prog_dl = Path(build_source) / "progressive_download.txt"
            if prog_dl.exists():
                await _log(
                    "[vnm-builder] progressive_download.txt already exists "
                    "— keeping existing rules"
                )
            else:
                prog_dl.write_text(
                    "# RenPyWeb progressive download rules - first match applies\n"
                    "# '+' = progressive download, '-' = keep in game.data (default)\n"
                    "# See https://www.renpy.org/doc/html/build.html"
                    "#classifying-and-ignoring-files for matching\n"
                    "#\n"
                    "# +/- type path\n"
                    "- image game/gui/**\n"
                    "+ image game/**\n"
                    "+ music game/audio/**\n"
                    "+ music game/music/**\n"
                    "+ voice game/voice/**\n",
                    encoding="utf-8",
                )
                await _log(
                    f"[vnm-builder] Wrote progressive_download.txt to {build_source}"
                )

            # ── web_build via launcher ───────────────────────
            await _log("[vnm-builder] Building web distribution via web_build...")
            launcher_path = os.path.join(str(self.sdk_path), 'launcher')

            build_cmd = [
                launcher,           # renpy.sh path
                launcher_path,      # /renpy-sdk/launcher as the basedir
                'web_build',        # the web_build command
                build_source,       # overlay (compressed) or original game path
                '--destination',    # destination flag
                str(output_dir),    # /web-builds/{dirName}
            ]
            await _log(f"[vnm-builder] Running: {' '.join(build_cmd)}")

            build_proc = await asyncio.create_subprocess_exec(
                *build_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=env,
                cwd=str(self.sdk_path),
            )
            self.active_builds[job_id] = build_proc

            await self._stream_output(build_proc, _log, log_file)
            await build_proc.wait()
            build_rc = build_proc.returncode

            elapsed = time.monotonic() - start_time
            await _log(
                f"[vnm-builder] web_build exited with code {build_rc} "
                f"after {elapsed:.1f}s"
            )

            # ── Verify index.html exists in the output ───────
            if build_rc != 0:
                raise RuntimeError(
                    f"web_build command failed with exit code {build_rc}"
                )

            index_file = output_dir / "index.html"
            if not index_file.is_file():
                raise RuntimeError(
                    f"web_build completed but index.html not found in {output_dir}"
                )
            # ── Clean up redundant distributable ZIP ──────────
            # Ren'Py web_build creates a distributable .zip alongside
            # the extracted web root.  Only the extracted folder is
            # served by nginx, so delete the ZIP to save disk space.
            sibling_zip = self.web_builds_path / f"{dir_name}.zip"
            if sibling_zip.is_file():
                sibling_zip.unlink()
                await _log(f"[vnm-builder] Removed redundant distributable ZIP: {sibling_zip}")

            # ── Success ─────────────────────────────────────
            elapsed = time.monotonic() - start_time
            web_build_path = f"/web-builds/{dir_name}"
            await self._notify_api_status(
                job_id,
                "done",
                web_build_path=web_build_path,
            )
            await _log(
                f"[vnm-builder] ✅ Web build successful! Output at: {output_dir} "
                f"({elapsed:.1f}s)"
            )
            logger.info(
                "Build completed job=%s game=%s elapsed=%.1fs",
                job_id, game_id, elapsed,
            )

        except asyncio.CancelledError:
            await _log("[vnm-builder] Build was cancelled")
            logger.info("Build cancelled job=%s game=%s", job_id, game_id)
            # Don't notify API — the cancel route already set status to
            # 'cancelled' / 'not_built'.  Sending "failed" here would
            # overwrite that and leave the game in a broken state.
            raise

        except Exception as exc:
            if job_id in self._cancelled_jobs:
                # Subprocess was killed by cancel_build() → non-zero exit
                # code raised a RuntimeError.  The API cancel route already
                # updated the status, so skip the callback.
                await _log("[vnm-builder] Build was cancelled")
                logger.info(
                    "Build cancelled (subprocess terminated) job=%s game=%s",
                    job_id, game_id,
                )
                raise asyncio.CancelledError() from exc

            error_msg = str(exc)
            await _log(f"[vnm-builder] ❌ Build FAILED: {error_msg}")
            logger.error(
                "Build failed job=%s game=%s error=%s", job_id, game_id, error_msg
            )
            await self._notify_api_status(job_id, "failed", error=error_msg)
            raise

        finally:
            was_cancelled = job_id in self._cancelled_jobs
            self._cancelled_jobs.discard(job_id)
            self.active_builds.pop(job_id, None)
            # Always clean up the compression overlay
            cleanup_overlay(str(Path(f"/tmp/build-{job_id}")))
            # If cancelled, remove the partial output directory so stale
            # files don't linger on disk until the next build.
            if was_cancelled and output_dir.exists():
                try:
                    await asyncio.to_thread(shutil.rmtree, output_dir)
                    logger.info(
                        "Cleaned up partial output dir %s after cancel",
                        output_dir,
                    )
                except Exception as cleanup_exc:
                    logger.warning(
                        "Failed to clean up partial output %s: %s",
                        output_dir, cleanup_exc,
                    )

    # ── Cancel a running build ─────────────────────────────

    async def cancel_build(self, job_id: str):
        """Cancel a running build by terminating its subprocess."""
        # Mark as cancelled BEFORE killing the subprocess so that
        # build_game()'s exception handlers know this was intentional
        # and skip the API status callback.
        self._cancelled_jobs.add(job_id)

        proc = self.active_builds.get(job_id)
        if proc is None:
            return

        logger.info("Cancelling build job %s (pid=%s)", job_id, proc.pid)

        try:
            proc.send_signal(signal.SIGTERM)
        except (ProcessLookupError, OSError):
            return

        try:
            await asyncio.wait_for(proc.wait(), timeout=10.0)
            logger.info("Build %s terminated gracefully", job_id)
        except asyncio.TimeoutError:
            logger.warning("Build %s did not terminate in 10s, sending SIGKILL", job_id)
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass

        self.active_builds.pop(job_id, None)

    # ── API notification helper ────────────────────────────

    async def _notify_api_status(
        self,
        job_id: str,
        status: str,
        *,
        error: str | None = None,
        web_build_path: str | None = None,
    ):
        """POST a status update back to vnm-api's internal endpoint."""
        url = f"{self.api_url}/api/v1/internal/build/{job_id}/status"
        payload: dict = {"status": status}
        if error is not None:
            payload["error"] = error
        if web_build_path is not None:
            payload["webBuildPath"] = web_build_path

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload)
                if resp.status_code >= 400:
                    logger.error(
                        "API status callback failed: %s %s — %s",
                        resp.status_code,
                        url,
                        resp.text,
                    )
        except Exception as exc:
            logger.error("API status callback error: %s — %s", url, exc)
