"""Async build queue with concurrency control and SSE log subscriber management."""

import asyncio
import json
import os
import re
from pathlib import Path
from dataclasses import dataclass, field

from builder import RenPyBuilder
from build_storage import recover_publication
from logger import setup_logger

logger = setup_logger("vnm-builder.queue")


@dataclass
class QueuedJob:
    """A job waiting in the queue or actively building."""

    job_id: str
    game_id: str
    game_path: str
    compress_assets: bool = True
    force_recompress: bool = False


@dataclass
class JobState:
    """Runtime state for a tracked job (queued, active, or finished)."""

    job_id: str
    status: str = "queued"  # queued | building | done | failed | cancelled
    task: asyncio.Task | None = None
    log_subscribers: list[asyncio.Queue] = field(default_factory=list)


class BuildQueue:
    """Manages an async FIFO build queue with bounded concurrency.

    * Jobs are submitted via :meth:`add` and processed by background worker tasks.
    * SSE consumers can subscribe to live log lines via :meth:`subscribe_logs`.
    * Running or queued jobs can be cancelled via :meth:`cancel`.
    """

    def __init__(self, builder: RenPyBuilder, max_concurrent: int = 1):
        self.builder = builder
        self.max_concurrent = max_concurrent
        self._queue: asyncio.Queue[QueuedJob] = asyncio.Queue()
        self._jobs: dict[str, JobState] = {}  # jobId -> JobState
        self._workers: list[asyncio.Task] = []
        self._stopping = False
        self._records = {}
        self._state_dir = self.builder.web_builds_path / ".vnm-jobs"
        self._state_dir.mkdir(parents=True, exist_ok=True)

    def _persist(self, job_id, status, **extra):
        record = self._records[job_id]
        record.update(status=status, **extra)
        target = self._state_dir / f"{job_id}.json"
        temporary = target.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)

    def get_record(self, job_id):
        return self._records.get(job_id)

    # ── Lifecycle ──────────────────────────────────────────

    async def start(self):
        """Spawn worker tasks. Call once at application startup."""
        for path in sorted(self._state_dir.glob("*.json"), key=lambda p: p.stat().st_mtime):
            try:
                record = json.loads(path.read_text())
                job_id = record["job_id"]
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
                    continue
                self._records[job_id] = record
                status = record["status"]
                if status == "building":
                    recover_publication(self.builder.web_builds_path, job_id, record["game_path"])
                    status = "failed"
                    self._persist(job_id, status, error="Build interrupted by worker restart. Retry to build again.")
                self._jobs[job_id] = JobState(job_id=job_id, status=status)
                if status == "queued":
                    await self._queue.put(QueuedJob(job_id, record["game_id"], record["game_path"], record["compress_assets"], record.get("force_recompress", False)))
            except Exception as error:
                logger.error("Cannot recover queue record %s: %s", path, error)
        for i in range(self.max_concurrent):
            task = asyncio.create_task(self._worker(i), name=f"build-worker-{i}")
            self._workers.append(task)
        logger.info("Build queue started with %d worker(s)", self.max_concurrent)

    async def stop(self):
        """Cancel workers and drain. Call at application shutdown."""
        self._stopping = True
        for job_id, state in self._jobs.items():
            if state.status == "building":
                await self.builder.cancel_build(job_id)
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        logger.info("Build queue stopped")

    # ── Public API ─────────────────────────────────────────

    async def add(self, job_id: str, game_id: str, game_path: str, compress_assets: bool = True, force_recompress: bool = False):
        """Enqueue a new build job."""
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
            raise ValueError("Invalid build job ID")
        if job_id in self._records:
            record = self._records[job_id]
            if (record["game_id"], record["game_path"], record["compress_assets"], record.get("force_recompress", False)) != (game_id, game_path, compress_assets, force_recompress):
                raise ValueError("Build job ID reused for different inputs")
            return
        self._records[job_id] = {"job_id": job_id, "game_id": game_id, "game_path": game_path, "compress_assets": compress_assets, "force_recompress": force_recompress}
        self._persist(job_id, "queued")
        job = QueuedJob(job_id=job_id, game_id=game_id, game_path=game_path, compress_assets=compress_assets, force_recompress=force_recompress)
        state = JobState(job_id=job_id, status="queued")
        self._jobs[job_id] = state
        await self._queue.put(job)
        logger.info("Job %s queued (queue depth=%d)", job_id, self._queue.qsize())

    async def cancel(self, job_id: str) -> bool:
        """Cancel a queued or running job. Returns True if found and cancelled."""
        state = self._jobs.get(job_id)
        if state is None:
            return False

        if state.status == "queued":
            # Remove from the queue by rebuilding it (asyncio.Queue has no remove)
            new_items: list[QueuedJob] = []
            while not self._queue.empty():
                try:
                    item = self._queue.get_nowait()
                    self._queue.task_done()
                    if item.job_id != job_id:
                        new_items.append(item)
                except asyncio.QueueEmpty:
                    break
            for item in new_items:
                await self._queue.put(item)

            state.status = "cancelled"
            self._persist(job_id, "cancelled")
            await self._broadcast_log(job_id, "[vnm-builder] Build cancelled (removed from queue)")
            await self._close_log_subscribers(job_id)
            logger.info("Cancelled queued job %s", job_id)
            return True

        if state.status == "building":
            if job_id in getattr(self.builder, "publishing_jobs", set()):
                return False
            # Cancel the running build
            await self.builder.cancel_build(job_id)
            if state.task and not state.task.done():
                state.task.cancel()
            state.status = "cancelled"
            self._persist(job_id, "cancelled")
            await self._broadcast_log(job_id, "[vnm-builder] Build cancelled (terminated)")
            await self._close_log_subscribers(job_id)
            logger.info("Cancelled active build %s", job_id)
            return True

        # Already finished
        return False

    def get_status(self, job_id: str) -> str | None:
        """Return the current status of a job, or None if unknown."""
        state = self._jobs.get(job_id)
        return state.status if state else None

    def subscribe_logs(self, job_id: str) -> asyncio.Queue:
        """Subscribe to the live log stream for a given job.

        Returns an asyncio.Queue that will receive log line strings.
        A ``None`` sentinel indicates the stream has ended.
        """
        state = self._jobs.get(job_id)
        if state is None:
            # Create a placeholder so late subscribers still get a queue
            state = JobState(job_id=job_id, status="unknown")
            self._jobs[job_id] = state

        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        state.log_subscribers.append(q)
        return q

    def unsubscribe_logs(self, job_id: str, q: asyncio.Queue):
        """Remove a subscriber queue."""
        state = self._jobs.get(job_id)
        if state:
            try:
                state.log_subscribers.remove(q)
            except ValueError:
                pass

    # ── Internal worker ────────────────────────────────────

    async def _worker(self, worker_id: int):
        """Long-running coroutine that pulls jobs from the queue and builds them."""
        logger.info("Worker-%d started", worker_id)
        while True:
            job = await self._queue.get()
            state = self._jobs.get(job.job_id)

            # Job may have been cancelled while queued
            if state is None or state.status == "cancelled":
                self._queue.task_done()
                continue

            state.status = "building"
            self._persist(job.job_id, "building")

            try:
                logger.info("Worker-%d starting build for job %s", worker_id, job.job_id)

                async def _log_cb(line: str):
                    await self._broadcast_log(job.job_id, line)

                state.task = asyncio.create_task(self.builder.build_game(
                    job_id=job.job_id,
                    game_id=job.game_id,
                    game_path=job.game_path,
                    log_callback=_log_cb,
                    compress_assets=job.compress_assets,
                    force_recompress=job.force_recompress,
                ))
                await state.task
                state.status = "done"
                self._persist(job.job_id, "done", webBuildPath=f"/web-builds/{Path(job.game_path).name}")
                logger.info("Worker-%d completed job %s", worker_id, job.job_id)

            except asyncio.CancelledError:
                state.status = "failed" if self._stopping else "cancelled"
                self._persist(job.job_id, state.status, error="Build interrupted by worker shutdown." if self._stopping else None)
                logger.info("Worker-%d: job %s was cancelled", worker_id, job.job_id)

            except Exception as exc:
                state.status = "failed"
                self._persist(job.job_id, "failed", error=str(exc))
                logger.error(
                    "Worker-%d: job %s failed — %s", worker_id, job.job_id, exc
                )

            finally:
                state.task = None
                await self._close_log_subscribers(job.job_id)
                self._queue.task_done()
            if self._stopping:
                return

    # ── Log broadcasting ───────────────────────────────────

    async def _broadcast_log(self, job_id: str, line: str):
        """Push a log line to all subscribers for a given job."""
        state = self._jobs.get(job_id)
        if state is None:
            return
        dead: list[asyncio.Queue] = []
        for q in state.log_subscribers:
            try:
                q.put_nowait(line)
            except asyncio.QueueFull:
                dead.append(q)
        # Remove slow/dead subscribers
        for q in dead:
            try:
                state.log_subscribers.remove(q)
            except ValueError:
                pass

    async def _close_log_subscribers(self, job_id: str):
        """Send a None sentinel to all subscribers to signal end-of-stream."""
        state = self._jobs.get(job_id)
        if state is None:
            return
        for q in state.log_subscribers:
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
