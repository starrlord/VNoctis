# Background imports and builds

Administrators can open **Jobs** from the navigation bar to follow imports and builds, reopen their logs, cancel processing, retry failures, or remove finished job records. The launcher also recovers its active build-log link from the game's stored job ID when reopened.

Local uploads return HTTP 202 after the complete archive is written and its job recorded. Keep the browser open until that acknowledgement; resumable uploads are not included. URL imports return a job ID immediately. Accepted extraction and build work continues after the overlay closes or the browser disconnects. The library refreshes when processing finishes. Returning to the library or default Jobs view retains the last loaded session data while fresh status is fetched; closing a view cancels its outstanding request. Hidden tabs skip job-list polling.

Progress shows the current stage, elapsed time, download bytes when available, and activity in the log. Compression reports image counts in its output. Unknown-length stages do not display an invented overall percentage or completion estimate.

## Storage and recovery

- SQLite `WorkJob` records persist import and build identity, stage, timestamps and errors. Existing `BuildJob` records remain supported; the latest 200 are added to Jobs when upgrading.
- Uploaded archives use `/data/import-jobs/<job-id>` by default, configurable with `JOB_STORAGE_PATH`. Successful imports remove their staged upload. Failed uploads remain available for retry until their job is removed. An upload referenced by another pending or failed retry is retained.
- Outer archive extraction uses `/games/.vnm-staging/<job-id>`. Paths, links, encrypted archives, extraction limits and available space are checked before publication. Completed imports reserve their destination exclusively and do not overwrite an existing game.
- Builder queue records use `/web-builds/.vnm-jobs`. Queued builds survive restart. Worker reconciliation runs independently of long imports, so a lost completion callback can still be recovered while extraction is running. Interrupted subprocesses become failed jobs that can be retried; arbitrary mid-process execution is not resumed.
- Build output uses `/web-builds/.vnm-staging/<job-id>`. The previous playable build remains until replacement output contains `index.html`. Publication failures restore the prior output; restart recovery repairs an interrupted publication rename.
- Build preparation extracts packed assets into temporary overlays. SDK-writable scripts and progressive-download rules are local copies. Cancellation terminates owned SDK/extraction processes and compression worker groups.
- Import registration that was interrupted after publication can be retried without extracting into or replacing the already-published game folder.
- VNDB metadata refresh remains a separate best-effort operation after registration, matching the previous import flow.

Logs persist at `/web-builds/logs/<job-id>.log`. Authenticated byte-cursor reads resume after disconnection and preserve partial lines and UTF-8 characters. The viewer shows the latest 5,000 nonempty lines; **Download full log** includes the complete file. Job records and logs remain until an administrator chooses **Remove job**. This removes the record, log and unneeded staged upload while retaining the game and playable build. Removing a game from the library does not remove a job's retained log.

The API serializes import work, and the builder retains its configured `BUILD_CONCURRENCY` limit. This change separates processing from HTTP request lifetimes and makes it observable and recoverable. Extraction parallelism and SDK packaging speed improvements require separate measurement.

## Asset compression and rebuilds

Build options show the published build's compression record. When reusable optimized images are available, **Force recompress assets** is unchecked by default: unchanged images are copied from the published build, while new or changed images are optimized. Checking it recompresses from the original source files. Without a reusable record, **Compress assets** is checked by default and can be disabled.

Reuse is verified against source and output SHA-256 hashes, quality settings, encoder method and optimizer versions. Changed settings or damaged/missing output cause fresh compression. Older builds require one tracked optimization build before they can be reused. A small private manifest indexes the actual published files or `game.zip` members; progressive placeholders are excluded. There is no separate persistent image cache. Temporary processing overlays are purged after builds.

WebP encoding defaults to method 2 at quality 80. Set `COMPRESS_WEBP_METHOD=4` on the builder to use the previous encoder effort, or choose another supported value from 0 through 6. A 12-image Abnormal sample encoded in 3.07 seconds with method 2 versus 6.09 seconds with method 4, with approximately 5% larger output; this is a sample encoding result, not a whole-build speed guarantee. The user inspected the exported original/method 2/method 4 samples and accepted method 2's visual quality.

Compression worker selection respects the builder container's CPU quota and CPU affinity/cpuset. Both cgroup v1 and v2 are supported, including tighter visible parent quotas. `COMPRESS_WORKERS=0` selects the detected allowance; positive values request fewer workers but cannot exceed it. Fractional CPU allowances round down, with at least one worker (Docker still enforces fractional bandwidth). Simultaneous builds share worker slots within the builder process instead of multiplying full-sized pools. Build logs show the detected limits and allocated workers. CPU shares/weights are relative priority, not a hard CPU quota. Task ordering, batching and image quality settings are unchanged.

## Deployment

Rebuild/recreate the API, UI and builder together. The API applies the new database migration at startup. Preserve `/data` and `/web-builds` volumes to preserve queue records and logs. The shared Prisma Game model's publishing fields are added when absent in older non-R2 databases; R2-only tables remain restricted to R2 mode.

The new job endpoints and log downloads require the admin role. Nginx blocks direct static access to job logs, queue records and staging output. Cancellation is refused during final publication/registration so a completed folder cannot be left half-registered. A failed rebuild keeps previously validated output playable.

## Checks

From `services/vnm-api`, run `npm test` (Node 24; Prisma client generated), and run `python3 -m unittest discover -s test -p test_archives.py -v` for outer-archive checks.

From `services/vnm-builder`, run `python -m unittest discover -s tests -v` with its requirements installed. Linux is required for process-group and overlay checks, matching the production container.

The local integration testbed is intentionally ignored under `test-data/jobs-test`. It uses separate databases/game/build volumes and port 3181. It covers actual archive imports, compressed/uncompressed SDK builds, unsafe/corrupt archives, collisions, 10,000-line log recovery/download, launcher reopen, background overlay dismissal and mobile layout. A real Abnormal archive (144 MB and 9,609 entries) also imported successfully in the isolated testbed.

A full 4.46 GB Abnormal source built locally in 16m19s with WebP method 2, quality 80 and eight workers within an eight-CPU container quota. A launcher-initiated reuse rebuild took 9m9s; image processing fell from 7m4s to 3.3s and reused all 9,183 published game images with identical source/output hashes. Temporary overlays were removed after both builds. Complete retained logs and fresh Chrome menu/gameplay launch were checked without SDK compilation or browser exceptions. The remaining time largely comes from sequential SDK progressive-download placeholder generation. These are local measurements, not promised build times; large-archive import and TrueNAS deployment still need server validation.
