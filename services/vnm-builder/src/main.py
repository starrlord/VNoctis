"""vnm-builder — Ren'Py web-build worker service.

Exposes a FastAPI application with:
  GET  /health            — service health check
  POST /build             — enqueue a web build
  DELETE /build/{jobId}   — cancel a queued or running build
  GET  /build/{jobId}/log — SSE stream of build log lines
"""

import asyncio
import os
import signal
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from builder import RenPyBuilder
from build_queue import BuildQueue
from logger import setup_logger

# ── Structured JSON Logging ────────────────────────────────
logger = setup_logger("vnm-builder")

# ── Configuration ──────────────────────────────────────────
SDK_PATH = os.getenv("RENPY_SDK_PATH", "/renpy-sdk")
GAMES_PATH = os.getenv("GAMES_PATH", "/games")
WEB_BUILDS_PATH = os.getenv("WEB_BUILDS_PATH", "/web-builds")
API_URL = os.getenv("API_URL", "http://vnm-api:3001")
MAX_CONCURRENT_BUILDS = int(os.getenv("BUILD_CONCURRENCY", os.getenv("MAX_CONCURRENT_BUILDS", "1")))

# ── Globals (initialised in lifespan) ──────────────────────
builder: RenPyBuilder | None = None
build_queue: BuildQueue | None = None
_start_time: float = time.time()
_shutting_down: bool = False


# ── Graceful Shutdown Helper ───────────────────────────────
async def graceful_shutdown():
    """Perform graceful shutdown: stop builds, persist logs, notify API."""
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True

    logger.info("Builder shutting down...")

    if build_queue is not None:
        # Cancel all active builds gracefully
        active_job_ids = list(build_queue._jobs.keys())
        for job_id in active_job_ids:
            state = build_queue._jobs.get(job_id)
            if state and state.status == "building":
                logger.info("Cancelling active build %s during shutdown", job_id)
                try:
                    await build_queue.cancel(job_id)
                except Exception as exc:
                    logger.warning("Error cancelling build %s: %s", job_id, exc)

        # Stop the build queue workers
        try:
            await build_queue.stop()
        except Exception as exc:
            logger.warning("Error stopping build queue: %s", exc)

    logger.info("Builder shutdown complete")


def _handle_shutdown_signal(signum, frame):
    """Signal handler for SIGTERM/SIGINT — schedules async shutdown."""
    sig_name = signal.Signals(signum).name
    logger.info("Received %s, initiating graceful shutdown...", sig_name)
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(graceful_shutdown())
    except RuntimeError:
        # No running event loop — just log and exit
        logger.warning("No event loop available for async shutdown")


# Register signal handlers
signal.signal(signal.SIGTERM, _handle_shutdown_signal)
signal.signal(signal.SIGINT, _handle_shutdown_signal)


# ── Lifespan ───────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global builder, build_queue

    builder = RenPyBuilder(
        sdk_path=SDK_PATH,
        games_path=GAMES_PATH,
        web_builds_path=WEB_BUILDS_PATH,
        api_url=API_URL,
    )
    build_queue = BuildQueue(builder=builder, max_concurrent=MAX_CONCURRENT_BUILDS)
    await build_queue.start()

    logger.info("vnm-builder ready  (sdk_version=%s)", builder.sdk_version)
    yield

    await graceful_shutdown()


# ── FastAPI app ────────────────────────────────────────────
app = FastAPI(title="vnm-builder", version="1.0.0", lifespan=lifespan)


# ── Request / response models ─────────────────────────────
class BuildRequest(BaseModel):
    jobId: str
    gameId: str
    gamePath: str
    compressAssets: bool = True


class BuildAccepted(BaseModel):
    status: str = "accepted"
    jobId: str


# ── Routes ─────────────────────────────────────────────────


@app.get("/health")
async def health():
    """Service health check with SDK version and uptime."""
    assert builder is not None
    return {
        "status": "ok",
        "service": "vnm-builder",
        "version": "1.0.0",
        "sdkVersion": builder.sdk_version,
        "sdkAvailable": builder.sdk_available(),
        "uptime": round(time.time() - _start_time, 1),
    }


@app.post("/build", status_code=202, response_model=BuildAccepted)
async def start_build(body: BuildRequest):
    """Enqueue a Ren'Py web build.

    Returns 202 Accepted immediately; the build runs asynchronously.
    """
    assert builder is not None
    assert build_queue is not None

    # Reject new builds during shutdown
    if _shutting_down:
        raise HTTPException(
            status_code=503,
            detail="Service is shutting down, not accepting new builds.",
        )

    # Validate SDK availability
    if not builder.sdk_available():
        raise HTTPException(
            status_code=503,
            detail="Ren'Py SDK is not available. Ensure the SDK volume is mounted.",
        )

    # Validate the game path
    error = builder.validate_game_path(body.gamePath)
    if error:
        raise HTTPException(status_code=400, detail=error)

    # Enqueue
    await build_queue.add(
        job_id=body.jobId,
        game_id=body.gameId,
        game_path=body.gamePath,
        compress_assets=body.compressAssets,
    )

    return BuildAccepted(jobId=body.jobId)


@app.delete("/build/{job_id}")
async def cancel_build(job_id: str):
    """Cancel a queued or running build."""
    assert build_queue is not None

    status = build_queue.get_status(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    if status not in ("queued", "building"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel job with status '{status}'",
        )

    cancelled = await build_queue.cancel(job_id)
    if not cancelled:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found or already finished")

    return {"status": "cancelled", "jobId": job_id}


@app.get("/build/{job_id}/log")
async def stream_build_log(job_id: str, request: Request):
    """SSE stream of build log lines for the given job.

    First replays any existing lines from the log file, then streams
    new lines as they appear. Sends a ``done`` event when the build
    finishes and closes the connection.
    """
    assert build_queue is not None
    assert builder is not None

    # Check if we have a log file for this job
    log_file = builder.logs_dir / f"{job_id}.log"

    # Subscribe to live log stream
    sub_queue = build_queue.subscribe_logs(job_id)

    async def _event_generator():
        try:
            # Phase 1: Replay existing log lines from file
            if log_file.is_file():
                with open(log_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.rstrip("\n\r")
                        if line:
                            yield f"data: {line}\n\n"

            # Phase 2: Stream live lines from subscriber queue
            status = build_queue.get_status(job_id)
            if status in ("done", "failed", "cancelled"):
                # Build already finished — just send the done event
                yield f"event: done\ndata: {status}\n\n"
                return

            while True:
                # Check for client disconnect
                if await request.is_disconnected():
                    break

                try:
                    line = await asyncio.wait_for(sub_queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    # Send keepalive comment
                    yield ": keepalive\n\n"
                    continue

                if line is None:
                    # Sentinel: stream ended
                    final_status = build_queue.get_status(job_id) or "done"
                    yield f"event: done\ndata: {final_status}\n\n"
                    break

                yield f"data: {line}\n\n"

        finally:
            build_queue.unsubscribe_logs(job_id, sub_queue)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Entrypoint ─────────────────────────────────────────────
if __name__ == "__main__":
    log_level = os.getenv("LOG_LEVEL", "info").lower()
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=3002,
        log_level=log_level,
    )
