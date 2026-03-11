"""Async build queue with concurrency control and SSE log subscriber management."""

import asyncio
from dataclasses import dataclass, field

from builder import RenPyBuilder
from logger import setup_logger

logger = setup_logger("vnm-builder.queue")


@dataclass
class QueuedJob:
    """A job waiting in the queue or actively building."""

    job_id: str
    game_id: str
    game_path: str
    compress_assets: bool = True


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

    # ── Lifecycle ──────────────────────────────────────────

    async def start(self):
        """Spawn worker tasks. Call once at application startup."""
        for i in range(self.max_concurrent):
            task = asyncio.create_task(self._worker(i), name=f"build-worker-{i}")
            self._workers.append(task)
        logger.info("Build queue started with %d worker(s)", self.max_concurrent)

    async def stop(self):
        """Cancel workers and drain. Call at application shutdown."""
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        logger.info("Build queue stopped")

    # ── Public API ─────────────────────────────────────────

    async def add(self, job_id: str, game_id: str, game_path: str, compress_assets: bool = True):
        """Enqueue a new build job."""
        job = QueuedJob(job_id=job_id, game_id=game_id, game_path=game_path, compress_assets=compress_assets)
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
                    if item.job_id != job_id:
                        new_items.append(item)
                except asyncio.QueueEmpty:
                    break
            for item in new_items:
                await self._queue.put(item)

            state.status = "cancelled"
            await self._broadcast_log(job_id, "[vnm-builder] Build cancelled (removed from queue)")
            await self._close_log_subscribers(job_id)
            logger.info("Cancelled queued job %s", job_id)
            return True

        if state.status == "building":
            # Cancel the running build
            await self.builder.cancel_build(job_id)
            if state.task and not state.task.done():
                state.task.cancel()
            state.status = "cancelled"
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
            state.task = asyncio.current_task()

            try:
                logger.info("Worker-%d starting build for job %s", worker_id, job.job_id)

                async def _log_cb(line: str):
                    await self._broadcast_log(job.job_id, line)

                await self.builder.build_game(
                    job_id=job.job_id,
                    game_id=job.game_id,
                    game_path=job.game_path,
                    log_callback=_log_cb,
                    compress_assets=job.compress_assets,
                )
                state.status = "done"
                logger.info("Worker-%d completed job %s", worker_id, job.job_id)

            except asyncio.CancelledError:
                state.status = "cancelled"
                logger.info("Worker-%d: job %s was cancelled", worker_id, job.job_id)

            except Exception as exc:
                state.status = "failed"
                logger.error(
                    "Worker-%d: job %s failed — %s", worker_id, job.job_id, exc
                )

            finally:
                state.task = None
                await self._close_log_subscribers(job.job_id)
                self._queue.task_done()

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
